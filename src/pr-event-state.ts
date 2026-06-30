import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  fetchPullRequestEventState,
  postPullRequestComment,
  type GitHubPullRequestEventState,
} from './github';
import { readRepoRegistrySnapshot, repoFullName } from './repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';
import {
  listPrWatchRecords,
  parseWatchPrReference,
  type PrWatch,
} from './watch-actions';

type PrEventActionResult<TData extends JsonValue = JsonValue> = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: TData;
  requires?: string[];
  errors?: string[];
};

export type PrWatchEventWatermarkCategory =
  | 'commits'
  | 'review_threads'
  | 'requested_changes_reviews'
  | 'check_suites'
  | 'check_runs'
  | 'mergeability'
  | 'out_of_date_branch';

export type PrWatchEventWatermarkRecord = {
  watchId: string;
  category: PrWatchEventWatermarkCategory;
  watermark: JsonValue;
  sourceUpdatedAt: string | null;
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
};

type PullRequestTarget = {
  repoFullName: string;
  owner: string;
  repo: string;
  number: number;
  watch?: PrWatch;
};

type PrEventStateDependencies = {
  fetchPullRequestEventState?: typeof fetchPullRequestEventState;
  postPullRequestComment?: typeof postPullRequestComment;
};

const watermarkCategories: PrWatchEventWatermarkCategory[] = [
  'commits',
  'review_threads',
  'requested_changes_reviews',
  'check_suites',
  'check_runs',
  'mergeability',
  'out_of_date_branch',
];

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const prEventTargetInputSchema = v.object({
  watchId: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const prWatchEventWatermarkListInputSchema = v.object({
  watchId: v.optional(nonEmptyStringSchema),
});
const prCommentInputSchema = v.object({
  watchId: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(65_536)),
  addressedReviewThreadIds: v.optional(v.array(nonEmptyStringSchema)),
  addressedReviewCommentIds: v.optional(v.array(nonEmptyStringSchema)),
  checkRunIds: v.optional(v.array(v.pipe(v.number(), v.integer()))),
  commitSha: v.optional(nonEmptyStringSchema),
});
const prEventOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const githubPrEventStateGetAction = defineAction({
  name: 'neondeck_github_pr_event_state_get',
  description:
    'Fetch read-only GitHub PR event facts: commits, review threads, requested-changes reviews, checks, mergeability, out-of-date state, and branch push permissions.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrEventState(input);
  },
});

export const githubPrReviewThreadsGetAction = defineAction({
  name: 'neondeck_github_pr_review_threads_get',
  description:
    'Fetch read-only GitHub PR review thread state, including unresolved and resolved threads.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrReviewThreads(input);
  },
});

export const githubPrRequestedChangesGetAction = defineAction({
  name: 'neondeck_github_pr_requested_changes_get',
  description:
    'Fetch read-only requested-changes review state for a GitHub PR.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrRequestedChanges(input);
  },
});

export const githubPrBranchPermissionsGetAction = defineAction({
  name: 'neondeck_github_pr_branch_permissions_get',
  description:
    'Fetch read-only branch push permission facts for a GitHub PR without pushing or commenting.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrBranchPermissions(input);
  },
});

export const prCommentAction = defineAction({
  name: 'neondeck_pr_comment',
  description:
    'Post a GitHub PR summary comment with optional addressed review feedback, commit, and check metadata.',
  input: prCommentInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return postGitHubPrComment(input);
  },
});

export const prReviewCommentsLookupTool = defineTool({
  name: 'neondeck_pr_review_comments_lookup',
  description:
    'Fetch unresolved GitHub PR review comments and review thread metadata.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrReviewThreads(input);
  },
});

export const prRequestedChangesLookupTool = defineTool({
  name: 'neondeck_pr_requested_changes_lookup',
  description: 'Fetch current requested-changes review state for a GitHub PR.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrRequestedChanges(input);
  },
});

export const prBranchPermissionsLookupTool = defineTool({
  name: 'neondeck_pr_branch_permissions_lookup',
  description:
    'Fetch branch push permission facts for a GitHub PR without pushing.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrBranchPermissions(input);
  },
});

export const prWatchEventStateRefreshAction = defineAction({
  name: 'neondeck_pr_watch_event_state_refresh',
  description:
    'Refresh a watched PR event-state snapshot and persist per-category event watermarks.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return refreshPrWatchEventState(input);
  },
});

export const prWatchEventWatermarksListAction = defineAction({
  name: 'neondeck_pr_watch_event_watermarks_list',
  description: 'List persisted per-watch PR event watermarks.',
  input: prWatchEventWatermarkListInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return listPrWatchEventWatermarks(input);
  },
});

export const prWatchEventWatermarksLookupTool = defineTool({
  name: 'neondeck_pr_watch_event_watermarks_lookup',
  description:
    'Read persisted PR watch event watermarks without refreshing GitHub.',
  input: prWatchEventWatermarkListInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return listPrWatchEventWatermarks(input);
  },
});

export const neondeckPrEventActions = [
  githubPrEventStateGetAction,
  githubPrReviewThreadsGetAction,
  githubPrRequestedChangesGetAction,
  githubPrBranchPermissionsGetAction,
  prCommentAction,
  prWatchEventStateRefreshAction,
  prWatchEventWatermarksListAction,
];

export const neondeckPrEventTools = [
  prReviewCommentsLookupTool,
  prRequestedChangesLookupTool,
  prBranchPermissionsLookupTool,
  prWatchEventWatermarksLookupTool,
];

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

  const token = process.env.GITHUB_TOKEN;
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

async function fetchEventState(
  action: string,
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies,
): Promise<
  | {
      ok: true;
      target: PullRequestTarget;
      state: GitHubPullRequestEventState;
    }
  | { ok: false; result: PrEventActionResult }
> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      result: failResult(action, 'Invalid PR event state input.', {
        errors: [v.summarize(parsed.issues)],
      }),
    };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      result: failResult(action, 'GITHUB_TOKEN is not configured.', {
        requires: ['GITHUB_TOKEN'],
      }),
    };
  }

  const target = await resolvePullRequestTarget(parsed.output, paths, action);
  if (!target.ok) return target;

  try {
    const fetcher =
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState;
    return {
      ok: true,
      target: target.target,
      state: await fetcher({
        token,
        owner: target.target.owner,
        repo: target.target.repo,
        number: target.target.number,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      result: failResult(action, 'Could not fetch GitHub PR event state.', {
        errors: [errorMessage(error)],
      }),
    };
  }
}

async function resolvePullRequestTarget(
  input: v.InferOutput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths,
  action: string,
): Promise<
  | { ok: true; target: PullRequestTarget }
  | { ok: false; result: PrEventActionResult }
> {
  const watches = await listPrWatchRecords(paths);
  if (input.watchId) {
    const watch = watches.find((item) => item.id === input.watchId);
    if (!watch) {
      return {
        ok: false,
        result: failResult(action, `PR watch "${input.watchId}" not found.`, {
          requires: ['watchId'],
        }),
      };
    }

    return { ok: true, target: targetFromWatch(watch) };
  }

  if (input.ref) {
    const registry = await readRepoRegistrySnapshot(paths);
    const parsed = parseWatchPrReference(input.ref, registry);
    if (!parsed.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          action,
          changed: false,
          message: parsed.result.message,
          requires: parsed.result.requires,
          errors: parsed.result.errors,
        },
      };
    }
    const watch = watches.find((item) => item.id === parsed.reference.id);
    return {
      ok: true,
      target: {
        repoFullName: parsed.reference.repoFullName,
        owner: parsed.reference.githubOwner,
        repo: parsed.reference.githubName,
        number: parsed.reference.prNumber,
        ...(watch ? { watch } : {}),
      },
    };
  }

  if (!input.repo || !input.prNumber) {
    return {
      ok: false,
      result: failResult(
        action,
        'A watchId, ref, or repo plus prNumber is required.',
        { requires: ['watchId', 'ref', 'repo', 'prNumber'] },
      ),
    };
  }

  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find(
    (item) =>
      item.id === input.repo ||
      item.github.name === input.repo ||
      repoFullName(item).toLowerCase() === input.repo?.toLowerCase(),
  );
  if (repo) {
    const fullName = repoFullName(repo);
    const watch = watches.find(
      (item) =>
        item.repoFullName.toLowerCase() === fullName.toLowerCase() &&
        item.prNumber === input.prNumber,
    );
    return {
      ok: true,
      target: {
        repoFullName: fullName,
        owner: repo.github.owner,
        repo: repo.github.name,
        number: input.prNumber,
        ...(watch ? { watch } : {}),
      },
    };
  }

  const match = input.repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    return {
      ok: false,
      result: failResult(
        action,
        `Repository "${input.repo}" is not configured.`,
        {
          requires: ['repo'],
        },
      ),
    };
  }

  return {
    ok: true,
    target: {
      repoFullName: `${match[1]}/${match[2]}`,
      owner: match[1],
      repo: match[2],
      number: input.prNumber,
    },
  };
}

function targetFromWatch(watch: PrWatch): PullRequestTarget {
  return {
    repoFullName: watch.repoFullName,
    owner: watch.githubOwner,
    repo: watch.githubName,
    number: watch.prNumber,
    watch,
  };
}

async function isConfiguredRepoTarget(
  target: PullRequestTarget,
  paths: RuntimePaths,
) {
  const registry = await readRepoRegistrySnapshot(paths);
  return registry.repos.some(
    (repo) =>
      repoFullName(repo).toLowerCase() === target.repoFullName.toLowerCase(),
  );
}

function watermarksFromEventState(
  watchId: string,
  state: GitHubPullRequestEventState,
) {
  const latestCommit = maxString(
    state.commits.map((commit) => commit.committedAt),
  );
  const latestThreadComment = maxString(
    state.reviewThreads.flatMap((thread) =>
      thread.comments.map((comment) => comment.updatedAt),
    ),
  );
  const latestRequestedChanges = maxString(
    state.requestedChangesReviews.map((review) => review.submittedAt),
  );
  const latestSuiteUpdate = maxString(
    state.checkSuites.map((suite) => suite.updatedAt),
  );
  const latestRunUpdate = maxString(
    state.checkRuns.map((run) => run.completedAt ?? run.startedAt),
  );
  const requestedChangesReviews = state.requestedChangesReviews
    .map((review) => ({
      id: review.id,
      authorLogin: review.authorLogin,
      commitId: review.commitId,
      submittedAt: review.submittedAt,
    }))
    .sort((a, b) => a.id - b.id);
  const latestRequestedChangeStates =
    state.requestedChangesState.latestByReviewer
      .map((review) => ({
        id: review.id,
        state: review.state,
        authorLogin: review.authorLogin,
        commitId: review.commitId,
        submittedAt: review.submittedAt,
      }))
      .sort((a, b) =>
        String(a.authorLogin ?? a.id).localeCompare(
          String(b.authorLogin ?? b.id),
        ),
      );
  const requestedChangeHistory = state.requestedChangesState.history
    .map((review) => ({
      id: review.id,
      state: review.state,
      authorLogin: review.authorLogin,
      commitId: review.commitId,
      submittedAt: review.submittedAt,
    }))
    .sort((a, b) => a.id - b.id);
  const reviewThreads = state.reviewThreads
    .map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      commentIds: thread.comments
        .map((comment) => comment.databaseId ?? comment.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
      latestCommentUpdatedAt: maxString(
        thread.comments.map((comment) => comment.updatedAt),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const checkSuites = state.checkSuites
    .map((suite) => ({
      id: suite.id,
      headSha: suite.headSha,
      status: suite.status,
      conclusion: suite.conclusion,
      appSlug: suite.appSlug,
      updatedAt: suite.updatedAt,
    }))
    .sort((a, b) => a.id - b.id);
  const checkRuns = state.checkRuns
    .map((run) => ({
      id: run.id,
      name: run.name,
      headSha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.completedAt,
    }))
    .sort((a, b) => a.id - b.id);

  return [
    categoryWatermark(watchId, 'commits', latestCommit, {
      headSha: state.headSha,
      total: state.commits.length,
      shas: state.commits.map((commit) => commit.sha).sort(),
      latestCommittedAt: latestCommit,
    }),
    categoryWatermark(watchId, 'review_threads', latestThreadComment, {
      total: state.reviewThreads.length,
      unresolvedThreadIds: reviewThreads
        .filter((thread) => !thread.isResolved)
        .map((thread) => thread.id),
      resolvedThreadIds: reviewThreads
        .filter((thread) => thread.isResolved)
        .map((thread) => thread.id),
      outdatedThreadIds: reviewThreads
        .filter((thread) => thread.isOutdated)
        .map((thread) => thread.id),
      latestCommentUpdatedAt: latestThreadComment,
      threads: reviewThreads,
    }),
    categoryWatermark(
      watchId,
      'requested_changes_reviews',
      latestRequestedChanges,
      {
        total: requestedChangesReviews.length,
        reviewIds: requestedChangesReviews.map((review) => review.id),
        latestSubmittedAt: latestRequestedChanges,
        reviews: requestedChangesReviews,
        latestByReviewer: latestRequestedChangeStates,
        history: requestedChangeHistory,
      },
    ),
    categoryWatermark(watchId, 'check_suites', latestSuiteUpdate, {
      total: checkSuites.length,
      suiteIds: checkSuites.map((suite) => suite.id),
      failingSuiteIds: checkSuites
        .filter((suite) => isFailingConclusion(suite.conclusion))
        .map((suite) => suite.id),
      pendingSuiteIds: checkSuites
        .filter((suite) => suite.status !== 'completed')
        .map((suite) => suite.id),
      suites: checkSuites,
    }),
    categoryWatermark(watchId, 'check_runs', latestRunUpdate, {
      total: checkRuns.length,
      runIds: checkRuns.map((run) => run.id),
      failingRunIds: checkRuns
        .filter((run) => isFailingConclusion(run.conclusion))
        .map((run) => run.id),
      pendingRunIds: checkRuns
        .filter((run) => run.status !== 'completed')
        .map((run) => run.id),
      runs: checkRuns,
    }),
    categoryWatermark(watchId, 'mergeability', state.fetchedAt, {
      state: state.state,
      merged: state.merged,
      mergeable: state.mergeable,
      mergeableState: state.mergeableState,
      mergeCommitSha: state.mergeCommitSha,
      headSha: state.headSha,
      baseSha: state.baseSha,
    }),
    categoryWatermark(watchId, 'out_of_date_branch', state.fetchedAt, {
      isOutOfDate: state.isOutOfDate,
      mergeableState: state.mergeableState,
      headSha: state.headSha,
      baseSha: state.baseSha,
      baseRef: state.baseRef,
    }),
  ];
}

function categoryWatermark(
  watchId: string,
  category: PrWatchEventWatermarkCategory,
  sourceUpdatedAt: string | null,
  value: JsonValue,
) {
  return { watchId, category, sourceUpdatedAt, value };
}

function readWatermarks(
  paths: RuntimePaths,
  watchId?: string,
): PrWatchEventWatermarkRecord[] {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const query = watchId
      ? `
        SELECT *
        FROM pr_watch_event_watermarks
        WHERE watch_id = ?
        ORDER BY category ASC;
      `
      : `
        SELECT *
        FROM pr_watch_event_watermarks
        ORDER BY updated_at DESC, watch_id ASC, category ASC;
      `;
    return (
      watchId
        ? database.prepare(query).all(watchId)
        : database.prepare(query).all()
    ).map(readWatermarkRow);
  } finally {
    database.close();
  }
}

function upsertWatermarks(
  paths: RuntimePaths,
  watchId: string,
  watermarks: ReturnType<typeof watermarksFromEventState>,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    database.exec('BEGIN;');
    try {
      for (const watermark of watermarks) {
        database
          .prepare(
            `
            INSERT INTO pr_watch_event_watermarks (
              watch_id,
              category,
              watermark_json,
              source_updated_at,
              checked_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(watch_id, category) DO UPDATE SET
              watermark_json = excluded.watermark_json,
              source_updated_at = excluded.source_updated_at,
              checked_at = excluded.checked_at,
              updated_at = excluded.updated_at;
          `,
          )
          .run(
            watchId,
            watermark.category,
            JSON.stringify(watermark.value),
            watermark.sourceUpdatedAt,
            now,
            now,
            now,
          );
      }
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    database.close();
  }
}

function readWatermarkRow(row: unknown): PrWatchEventWatermarkRecord {
  const record = row as Record<string, unknown>;
  const category = String(record.category);
  return {
    watchId: String(record.watch_id),
    category: watermarkCategories.includes(
      category as PrWatchEventWatermarkCategory,
    )
      ? (category as PrWatchEventWatermarkCategory)
      : 'commits',
    watermark:
      typeof record.watermark_json === 'string'
        ? (JSON.parse(record.watermark_json) as JsonValue)
        : null,
    sourceUpdatedAt:
      typeof record.source_updated_at === 'string'
        ? record.source_updated_at
        : null,
    checkedAt: String(record.checked_at),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function eventTargetJson(target: PullRequestTarget): JsonValue {
  return {
    repoFullName: target.repoFullName,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    watchId: target.watch?.id ?? null,
  };
}

function okResult(
  action: string,
  changed: boolean,
  message: string,
  data: JsonValue,
): PrEventActionResult {
  return {
    ok: true,
    action,
    changed,
    message,
    data,
  };
}

function failResult(
  action: string,
  message: string,
  details: Pick<PrEventActionResult, 'errors' | 'requires'> = {},
): PrEventActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.requires ? { requires: details.requires } : {}),
    ...(details.errors ? { errors: details.errors } : {}),
  };
}

function maxString(values: Array<string | null | undefined>) {
  const filtered = values.filter((value): value is string => Boolean(value));
  if (filtered.length === 0) return null;
  return filtered.sort((a, b) => b.localeCompare(a))[0];
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

function isFailingConclusion(value: string | null) {
  return [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
  ].includes(value ?? '');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
