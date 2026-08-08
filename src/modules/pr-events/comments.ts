import type { JsonValue } from '@flue/runtime';
import { createHmac } from 'node:crypto';
import * as v from 'valibot';
import { prefixBotComment } from '../../../shared/bot-comments';
import {
  fetchPullRequestEventState,
  listPullRequestComments,
  postPullRequestComment,
  pullRequestEventStateTruncation,
  type GitHubPullRequestEventState,
} from '../github';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import {
  prCommentInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PullRequestTarget,
} from './schemas';
import { isConfiguredRepoTarget, resolvePullRequestTarget } from './target';
import {
  conversationCommentFingerprint,
  watermarksFromEventState,
} from './watermarks';
import { recordAddressedPrFeedback } from './addressed';
import { recordNeondeckPrDelivery } from './deliveries';
import {
  githubCommentLengthLimit,
  neondeckSelfAuthoredMarker,
} from './comment-support';
import { errorMessage, eventTargetJson, failResult, okResult } from './utils';

export async function postGitHubPrComment(
  input: v.InferInput<typeof prCommentInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prCommentInputSchema, input);
  if (!parsed.success) {
    return failResult('pr_comment', 'Invalid PR comment input.', {
      errors: [v.summarize(parsed.issues)],
    });
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult('pr_comment', 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  const resolved = await resolvePullRequestTarget(
    parsed.output,
    paths,
    'pr_comment',
  );
  if (!resolved.ok) return resolved.result;
  if (!(await isConfiguredRepoTarget(resolved.target, paths))) {
    return failResult(
      'pr_comment',
      `Repository "${resolved.target.repoFullName}" is not configured for PR comments.`,
      { requires: ['repo'] },
    );
  }

  try {
    const fetcher =
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState;
    const eventState = await fetcher({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
    });
    const truncation = pullRequestEventStateTruncation(eventState);
    if (truncation.any) {
      return failResult(
        'pr_comment',
        'PR event facts are incomplete; refusing to post a PR comment from truncated GitHub data.',
        {
          requires: ['completePrEventFacts'],
          errors: [
            `Truncated PR event fact categories: ${truncation.categories.join(', ')}.`,
          ],
        },
      );
    }

    const idempotencyMarker = parsed.output.idempotencyKey
      ? await prCommentIdempotencyMarker(parsed.output.idempotencyKey, paths)
      : undefined;
    if (idempotencyMarker) {
      const comments = await (
        dependencies.listPullRequestComments ?? listPullRequestComments
      )({
        token,
        owner: resolved.target.owner,
        repo: resolved.target.repo,
        number: resolved.target.number,
      });
      const existing = comments.find((comment) =>
        comment.body.includes(idempotencyMarker),
      );
      if (existing) {
        const authorizationFailure = await dependencies.authorizeComment?.();
        if (authorizationFailure) return authorizationFailure;
        recordNeondeckPrDelivery(
          {
            repoFullName: resolved.target.repoFullName,
            prNumber: resolved.target.number,
            itemKind: 'conversation-comment',
            itemId: existing.id,
            itemFingerprint: conversationCommentFingerprint(existing),
          },
          paths,
        );
        persistAddressedFeedback(
          resolved.target,
          parsed.output,
          eventState,
          existing.id,
          paths,
        );
        return okResult(
          'pr_comment',
          false,
          `PR comment already exists on ${resolved.target.repoFullName}#${resolved.target.number}.`,
          {
            target: eventTargetJson(resolved.target),
            comment: existing as unknown as JsonValue,
            metadata: {
              idempotentReplay: true,
              addressedReviewThreadIds:
                parsed.output.addressedReviewThreadIds ?? [],
              addressedReviewCommentIds:
                parsed.output.addressedReviewCommentIds ?? [],
              checkRunIds: parsed.output.checkRunIds ?? [],
              commitSha: parsed.output.commitSha ?? null,
            },
          },
        );
      }
    }

    const poster =
      dependencies.postPullRequestComment ?? postPullRequestComment;
    const body = `${prefixBotComment(parsed.output.body)}\n\n${idempotencyMarker ?? neondeckSelfAuthoredMarker}`;
    if (body.length > githubCommentLengthLimit) {
      return failResult(
        'pr_comment',
        'PR comment plus its idempotency marker exceeds GitHub’s comment length limit.',
        { requires: ['shorterComment'] },
      );
    }
    const authorizationFailure = await dependencies.authorizeComment?.();
    if (authorizationFailure) return authorizationFailure;
    const comment = await poster({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      body,
    });
    recordNeondeckPrDelivery(
      {
        repoFullName: resolved.target.repoFullName,
        prNumber: resolved.target.number,
        itemKind: 'conversation-comment',
        itemId: comment.id,
        itemFingerprint: conversationCommentFingerprint(comment),
      },
      paths,
    );
    persistAddressedFeedback(
      resolved.target,
      parsed.output,
      eventState,
      comment.id,
      paths,
    );

    return okResult(
      'pr_comment',
      true,
      `Posted PR comment on ${resolved.target.repoFullName}#${resolved.target.number}.`,
      {
        target: eventTargetJson(resolved.target),
        comment: comment as unknown as JsonValue,
        metadata: {
          addressedReviewThreadIds:
            parsed.output.addressedReviewThreadIds ?? [],
          addressedReviewCommentIds:
            parsed.output.addressedReviewCommentIds ?? [],
          checkRunIds: parsed.output.checkRunIds ?? [],
          commitSha: parsed.output.commitSha ?? null,
        },
      },
    );
  } catch (error) {
    return failResult('pr_comment', 'Could not post GitHub PR comment.', {
      errors: [errorMessage(error)],
    });
  }
}

async function prCommentIdempotencyMarker(
  idempotencyKey: string,
  paths: RuntimePaths,
) {
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const applicationSecret = config.localApi?.token;
  if (!applicationSecret) {
    throw new Error(
      'Neondeck local API credentials are unavailable for stable PR comment idempotency.',
    );
  }
  const digest = createHmac('sha256', applicationSecret)
    .update('github-pr-comment\0')
    .update(idempotencyKey)
    .digest('hex');
  return `<!-- neondeck:idempotency:${digest} -->`;
}

function persistAddressedFeedback(
  target: PullRequestTarget,
  input: {
    addressedReviewThreadIds?: string[];
    addressedReviewCommentIds?: string[];
  },
  eventState: GitHubPullRequestEventState,
  deliveryCommentId: string | number,
  paths: RuntimePaths,
) {
  const reviewThreadIds = input.addressedReviewThreadIds ?? [];
  const reviewCommentIds = input.addressedReviewCommentIds ?? [];
  if (reviewThreadIds.length === 0 && reviewCommentIds.length === 0) return;
  const fingerprints = addressedFeedbackFingerprints(eventState);
  const commentsAddressedByThread = reviewThreadIds.flatMap(
    (threadId) => fingerprints.reviewCommentsByThread.get(threadId) ?? [],
  );
  recordAddressedPrFeedback(
    {
      repoFullName: target.repoFullName,
      prNumber: target.number,
      reviewThreadFingerprints: Object.fromEntries(
        reviewThreadIds.flatMap((id) => {
          const fingerprint = fingerprints.reviewThreads.get(id);
          return fingerprint ? [[id, fingerprint]] : [];
        }),
      ),
      reviewCommentFingerprints: Object.fromEntries(
        [
          ...new Set([...reviewCommentIds, ...commentsAddressedByThread]),
        ].flatMap((id) => {
          const fingerprint = fingerprints.reviewComments.get(id);
          return fingerprint ? [[id, fingerprint]] : [];
        }),
      ),
      deliveryCommentId,
    },
    paths,
  );
}

function addressedFeedbackFingerprints(state: GitHubPullRequestEventState) {
  const reviewThreads = new Map<string, string>();
  const reviewComments = new Map<string, string>();
  const reviewCommentsByThread = new Map<string, string[]>();
  const watermark = watermarksFromEventState('addressed-feedback', state).find(
    (item) => item.category === 'review_threads',
  )?.value;
  const payload =
    watermark && typeof watermark === 'object' && !Array.isArray(watermark)
      ? (watermark as Record<string, unknown>)
      : {};
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  for (const value of threads) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const thread = value as Record<string, unknown>;
    const threadId = typeof thread.id === 'string' ? thread.id : null;
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const commentIds: string[] = [];
    let latestFingerprint: string | null = null;
    let latestUpdatedAt = '';
    for (const commentValue of comments) {
      if (
        !commentValue ||
        typeof commentValue !== 'object' ||
        Array.isArray(commentValue)
      ) {
        continue;
      }
      const comment = commentValue as Record<string, unknown>;
      const id =
        typeof comment.id === 'string' || typeof comment.id === 'number'
          ? String(comment.id)
          : null;
      const fingerprint =
        typeof comment.fingerprint === 'string' ? comment.fingerprint : null;
      if (id && fingerprint) {
        reviewComments.set(id, fingerprint);
        commentIds.push(id);
      }
      const updatedAt =
        typeof comment.updatedAt === 'string' ? comment.updatedAt : '';
      if (fingerprint && updatedAt >= latestUpdatedAt) {
        latestFingerprint = fingerprint;
        latestUpdatedAt = updatedAt;
      }
    }
    if (threadId && latestFingerprint) {
      reviewThreads.set(threadId, latestFingerprint);
      reviewCommentsByThread.set(threadId, commentIds);
    }
  }
  return { reviewThreads, reviewComments, reviewCommentsByThread };
}
