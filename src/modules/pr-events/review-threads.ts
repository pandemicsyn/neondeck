import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  fetchPullRequestReviewThread,
  invalidatePullRequestReviewSurfaceThreadCache,
  replyToPullRequestReviewThread,
  resolvePullRequestReviewThread,
  unresolvePullRequestReviewThread,
  type GitHubPullRequestReviewThread,
} from '../github';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  prEventTargetInputSchema,
  prReviewThreadReplyInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PullRequestTarget,
} from './schemas';
import { isConfiguredRepoTarget, resolvePullRequestTarget } from './target';
import { reviewThreadCommentDeliveryFingerprint } from './watermarks';
import { recordNeondeckPrDelivery } from './deliveries';
import {
  githubCommentLengthLimit,
  neondeckSelfAuthoredMarker,
} from './comment-support';
import { errorMessage, failResult, okResult } from './utils';

export async function postGitHubPrThreadReply(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  threadId: string,
  input: v.InferInput<typeof prReviewThreadReplyInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const action = 'github_pr_thread_reply_post';
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  const parsed = v.safeParse(prReviewThreadReplyInputSchema, input);
  if (!threadId || !parsedTarget.success || !parsed.success) {
    return failResult(action, 'Invalid review thread reply input.', {
      errors: [
        ...(!parsedTarget.success ? [v.summarize(parsedTarget.issues)] : []),
        ...(!parsed.success ? [v.summarize(parsed.issues)] : []),
      ],
      requires: !threadId ? ['threadId'] : undefined,
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(action, 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const resolved = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    action,
  );
  if (!resolved.ok) return resolved.result;
  if (!(await isConfiguredRepoTarget(resolved.target, paths))) {
    return failResult(
      action,
      `Repository "${resolved.target.repoFullName}" is not configured for review thread replies.`,
      { requires: ['repo'] },
    );
  }

  const verified = await verifyReviewThreadTarget({
    action,
    token,
    threadId,
    target: resolved.target,
    dependencies,
  });
  if (!verified.ok) return verified.result;

  const replyBody = `${parsed.output.text}\n\n${neondeckSelfAuthoredMarker}`;
  if (replyBody.length > githubCommentLengthLimit) {
    return failResult(
      action,
      'Review thread reply plus its Neondeck marker exceeds GitHub’s comment length limit.',
      { requires: ['shorterComment'] },
    );
  }

  try {
    const replier =
      dependencies.replyToPullRequestReviewThread ??
      replyToPullRequestReviewThread;
    let thread: GitHubPullRequestReviewThread;
    try {
      thread = await replier({
        token,
        threadId,
        body: replyBody,
      });
    } finally {
      invalidatePullRequestReviewSurfaceThreadCache({
        owner: resolved.target.owner,
        repo: resolved.target.repo,
        number: resolved.target.number,
      });
    }
    const previousCommentIds = new Set(
      verified.thread.comments.map((comment) =>
        String(comment.databaseId ?? comment.id),
      ),
    );
    const deliveredComments = thread.comments.filter(
      (comment) =>
        !previousCommentIds.has(String(comment.databaseId ?? comment.id)) &&
        comment.body === replyBody,
    );
    if (deliveredComments.length !== 1) {
      return failResult(
        action,
        'Posted review thread reply but could not uniquely verify its durable delivery identity.',
        { requires: ['deliveryIdentity'] },
      );
    }
    const deliveredComment = deliveredComments[0]!;
    recordNeondeckPrDelivery(
      {
        repoFullName: resolved.target.repoFullName,
        prNumber: resolved.target.number,
        itemKind: 'review-comment',
        itemId: deliveredComment.databaseId ?? deliveredComment.id,
        itemFingerprint: reviewThreadCommentDeliveryFingerprint(
          deliveredComment,
          thread,
        ),
      },
      paths,
    );
    return okResult(action, true, 'Posted review thread reply.', {
      thread: thread as unknown as JsonValue,
    });
  } catch (error) {
    return failResult(action, 'Could not post review thread reply.', {
      errors: [errorMessage(error)],
    });
  }
}

export async function postGitHubPrThreadResolution(
  targetInput: v.InferInput<typeof prEventTargetInputSchema>,
  threadId: string,
  resolved: boolean,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const action = resolved
    ? 'github_pr_thread_resolve_post'
    : 'github_pr_thread_unresolve_post';
  const parsedTarget = v.safeParse(prEventTargetInputSchema, targetInput);
  if (!threadId || !parsedTarget.success) {
    return failResult(
      action,
      !threadId
        ? 'Review thread id is required.'
        : 'Invalid review thread target input.',
      {
        errors: parsedTarget.success
          ? undefined
          : [v.summarize(parsedTarget.issues)],
        requires: !threadId ? ['threadId'] : undefined,
      },
    );
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(action, 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const target = await resolvePullRequestTarget(
    parsedTarget.output,
    paths,
    action,
  );
  if (!target.ok) return target.result;
  if (!(await isConfiguredRepoTarget(target.target, paths))) {
    return failResult(
      action,
      `Repository "${target.target.repoFullName}" is not configured for review thread resolution.`,
      { requires: ['repo'] },
    );
  }

  const verified = await verifyReviewThreadTarget({
    action,
    token,
    threadId,
    target: target.target,
    dependencies,
  });
  if (!verified.ok) return verified.result;

  try {
    const mutator = resolved
      ? (dependencies.resolvePullRequestReviewThread ??
        resolvePullRequestReviewThread)
      : (dependencies.unresolvePullRequestReviewThread ??
        unresolvePullRequestReviewThread);
    let thread: GitHubPullRequestReviewThread;
    try {
      thread = await mutator({ token, threadId });
    } finally {
      invalidatePullRequestReviewSurfaceThreadCache({
        owner: target.target.owner,
        repo: target.target.repo,
        number: target.target.number,
      });
    }
    return okResult(
      action,
      true,
      resolved ? 'Resolved review thread.' : 'Unresolved review thread.',
      { thread: thread as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      action,
      resolved
        ? 'Could not resolve review thread.'
        : 'Could not unresolve review thread.',
      { errors: [errorMessage(error)] },
    );
  }
}

async function verifyReviewThreadTarget(options: {
  action: string;
  token: string;
  threadId: string;
  target: PullRequestTarget;
  dependencies: PrEventStateDependencies;
}): Promise<
  | { ok: true; thread: GitHubPullRequestReviewThread }
  | { ok: false; result: PrEventActionResult }
> {
  try {
    const fetcher =
      options.dependencies.fetchPullRequestReviewThread ??
      fetchPullRequestReviewThread;
    const thread = await fetcher({
      token: options.token,
      threadId: options.threadId,
    });
    if (!reviewThreadBelongsToTarget(thread, options.target)) {
      return {
        ok: false,
        result: failResult(
          options.action,
          'Review thread does not belong to this pull request.',
          { requires: ['threadId'] },
        ),
      };
    }
    return { ok: true, thread };
  } catch (error) {
    return {
      ok: false,
      result: failResult(
        options.action,
        'Could not verify review thread target.',
        { errors: [errorMessage(error)] },
      ),
    };
  }
}

function reviewThreadBelongsToTarget(
  thread: GitHubPullRequestReviewThread,
  target: PullRequestTarget,
) {
  return (
    thread.pullRequestRepo?.toLowerCase() ===
      target.repoFullName.toLowerCase() &&
    thread.pullRequestNumber === target.number
  );
}
