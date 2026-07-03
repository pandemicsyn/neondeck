/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { fetchPullRequestEventState, postPullRequestComment, type GitHubPullRequestEventState } from '../../github';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import { type RuntimePaths, ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { listPrWatchRecords, parseWatchPrReference, type PrWatch } from '../../watch-actions';
import { prCommentInputSchema, prEventTargetInputSchema, prWatchEventWatermarkListInputSchema, type PrEventActionResult, type PrEventStateDependencies } from './schemas';
import { fetchEventState, isConfiguredRepoTarget, resolvePullRequestTarget } from './target';
import { readWatermarks, upsertWatermarks, watermarksFromEventState } from './watermarks';
import { errorMessage, eventTargetJson, failResult, okResult, stableJson } from './utils';

export async function getGitHubPrEventState(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_event_state_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;

  return okResult(
    'github_pr_event_state_get',
    false,
    `Fetched PR event state for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      state: resolved.state as unknown as JsonValue,
    },
  );
}

export async function getGitHubPrReviewThreads(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_review_threads_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;
  const threads = resolved.state.reviewThreads;
  const unresolvedThreads = threads.filter((thread) => !thread.isResolved);
  const unresolvedReviewComments = unresolvedThreads.flatMap((thread) =>
    thread.comments.map((comment) => ({
      ...comment,
      threadId: thread.id,
      threadPath: thread.path,
      threadLine: thread.line,
      threadIsOutdated: thread.isOutdated,
    })),
  );

  return okResult(
    'github_pr_review_threads_get',
    false,
    `Fetched ${threads.length} review thread(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      reviewThreads: threads as unknown as JsonValue,
      unresolvedReviewThreads: unresolvedThreads as unknown as JsonValue,
      unresolvedReviewComments:
        unresolvedReviewComments as unknown as JsonValue,
    },
  );
}

export async function getGitHubPrRequestedChanges(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_requested_changes_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;

  return okResult(
    'github_pr_requested_changes_get',
    false,
    `Fetched ${resolved.state.requestedChangesReviews.length} requested-changes review(s) for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      requestedChangesReviews: resolved.state
        .requestedChangesReviews as unknown as JsonValue,
      requestedChangesState: resolved.state
        .requestedChangesState as unknown as JsonValue,
    },
  );
}

export async function getGitHubPrBranchPermissions(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'github_pr_branch_permissions_get',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;

  return okResult(
    'github_pr_branch_permissions_get',
    false,
    `Fetched branch permission facts for ${resolved.target.repoFullName}#${resolved.target.number}.`,
    {
      target: eventTargetJson(resolved.target),
      branchPermissions: resolved.state
        .branchPermissions as unknown as JsonValue,
    },
  );
}

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
    await fetcher({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
    });

    const poster =
      dependencies.postPullRequestComment ?? postPullRequestComment;
    const comment = await poster({
      token,
      owner: resolved.target.owner,
      repo: resolved.target.repo,
      number: resolved.target.number,
      body: parsed.output.body,
    });

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

export async function refreshPrWatchEventState(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  const resolved = await fetchEventState(
    'pr_watch_event_state_refresh',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;
  if (!resolved.target.watch) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Refreshing event watermarks requires a configured PR watch.',
      { requires: ['watchId'] },
    );
  }

  const previous = readWatermarks(paths, resolved.target.watch.id);
  const next = watermarksFromEventState(
    resolved.target.watch.id,
    resolved.state,
  );
  const changedCategories = next
    .filter((item) => {
      const existing = previous.find(
        (record) => record.category === item.category,
      );
      return stableJson(existing?.watermark ?? null) !== stableJson(item.value);
    })
    .map((item) => item.category);

  upsertWatermarks(paths, resolved.target.watch.id, next);

  return okResult(
    'pr_watch_event_state_refresh',
    changedCategories.length > 0,
    changedCategories.length > 0
      ? `Updated ${changedCategories.length} PR event watermark(s) for ${resolved.target.watch.id}.`
      : `No PR event watermark changes for ${resolved.target.watch.id}.`,
    {
      watchId: resolved.target.watch.id,
      target: eventTargetJson(resolved.target),
      changedCategories,
      watermarks: readWatermarks(
        paths,
        resolved.target.watch.id,
      ) as unknown as JsonValue,
    },
  );
}

export async function listPrWatchEventWatermarks(
  input: v.InferInput<typeof prWatchEventWatermarkListInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prWatchEventWatermarkListInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'pr_watch_event_watermarks_list',
      'Invalid PR watch event watermark input.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }

  const watermarks = readWatermarks(paths, parsed.output.watchId);
  return okResult(
    'pr_watch_event_watermarks_list',
    false,
    `Listed ${watermarks.length} PR watch event watermark(s).`,
    { watermarks: watermarks as unknown as JsonValue },
  );
}
