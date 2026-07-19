/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  type GitHubCheckSummary,
  type GitHubFailingCheckFact,
  type GitHubPullRequestDetail,
  type GitHubPullRequestEventState,
  fetchPullRequestEventState,
  fetchCheckSummary,
  fetchFailingCheckFacts,
  fetchPullRequestDetail,
} from '../github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from '../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../app-state';
import {
  notifyAutopilotState,
  recoveryActionsForPreparedDiff,
} from './notifications';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { runApprovedExecution } from '../execution';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
} from '../pr-events';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffByWorktree,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
  type PreparedDiffRecord,
} from '../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  gitCurrentSha,
  gitCommitAll,
  gitCommitPaths,
  gitPushHead,
  gitStatus,
  type GitCommitResult,
} from '../../repo-edit/git';
import {
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  replaceRepoFilesAtomically,
} from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import {
  type RuntimePaths,
  parseAppConfig,
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import {
  createWorktree,
  listWorktrees,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
  type WorktreeRecord,
} from '../worktrees';
import {
  AutopilotActionResult,
  AutopilotDependencies,
  AutopilotTriageClass,
  autopilotFixtureSchema,
  autopilotModeSchema,
  autopilotOutputSchema,
  checkSummarySchema,
  commentPrAutofixResultInputSchema,
  fixPrCiFailureInputSchema,
  fixPrReviewFeedbackInputSchema,
  prEventDeltaSchema,
  prEventSnapshotSchema,
  prFactsSchema,
  prReviewEventStateSchema,
  preparePrWorktreeInputSchema,
  pushPrAutofixInputSchema,
  reviewFixReplacementSchema,
  triagePrEventInputSchema,
  verifyPrWorktreeInputSchema,
} from './schemas';
import {
  arrayField,
  booleanField,
  failResult,
  numberField,
  objectField,
  stringField,
  unique,
} from './utils';

export async function fetchReviewEventState(
  owner: string,
  repo: string,
  number: number,
  dependencies: AutopilotDependencies,
): Promise<GitHubPullRequestEventState | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_fix_pr_review_feedback',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const state = await (
    dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState
  )({
    token,
    owner,
    repo,
    number,
  });
  const parsed = v.safeParse(prReviewEventStateSchema, state);
  if (!parsed.success) {
    return failResult(
      'autopilot_fix_pr_review_feedback',
      'Invalid GitHub PR review event state.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }
  return parsed.output as GitHubPullRequestEventState;
}

export type ReviewCommentFact = {
  id: string;
  databaseId: number | null;
  threadId: string;
  authorLogin: string | null;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffHunk: string | null;
  reviewId: number | null;
  createdAt: string;
  updatedAt: string;
  threadPath: string | null;
  threadLine: number | null;
  threadIsOutdated: boolean;
};

export type ReviewFeedbackGroup = {
  path: string | null;
  topic: string;
  comments: ReviewCommentFact[];
};

export function reviewFactsFromEventState(state: GitHubPullRequestEventState) {
  const unresolvedThreads = state.reviewThreads.filter(
    (thread) => !thread.isResolved,
  );
  const unresolvedComments = unresolvedThreads.flatMap((thread) =>
    thread.comments.map((comment) => ({
      id: comment.id,
      databaseId: comment.databaseId,
      threadId: thread.id,
      authorLogin: comment.authorLogin,
      body: comment.body,
      url: comment.url,
      path: comment.path ?? thread.path,
      line: comment.line ?? thread.line,
      originalLine: comment.originalLine,
      diffHunk: comment.diffHunk,
      reviewId: comment.reviewId,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      threadPath: thread.path,
      threadLine: thread.line,
      threadIsOutdated: thread.isOutdated,
    })),
  );

  return {
    pr: {
      repo: state.repo,
      number: state.number,
      title: state.title,
      url: state.url,
      state: state.state,
      draft: state.draft,
      headSha: state.headSha,
      headRef: state.headRef,
      baseRef: state.baseRef,
      fetchedAt: state.fetchedAt,
    },
    unresolvedThreadCount: unresolvedThreads.length,
    unresolvedCommentCount: unresolvedComments.length,
    truncated:
      Boolean(state.reviewThreadsTruncated) || Boolean(state.reviewsTruncated),
    truncation: {
      reviewThreads: Boolean(state.reviewThreadsTruncated),
      reviews: Boolean(state.reviewsTruncated),
    },
    unresolvedComments,
    requestedChanges: state.requestedChangesReviews.map((review) => ({
      id: review.id,
      nodeId: review.nodeId,
      authorLogin: review.authorLogin,
      submittedAt: review.submittedAt,
      commitId: review.commitId,
      url: review.url,
    })),
    requestedChangesState: state.requestedChangesState,
  };
}

export function groupReviewFeedback(comments: ReviewCommentFact[]) {
  const groups = new Map<string, ReviewFeedbackGroup>();
  for (const comment of comments) {
    const path = comment.path ?? comment.threadPath;
    const topic = topicFromComment(comment);
    const key = `${path ?? '(general)'}\u0000${topic}`;
    const existing = groups.get(key);
    if (existing) {
      existing.comments.push(comment);
    } else {
      groups.set(key, { path: path ?? null, topic, comments: [comment] });
    }
  }

  return [...groups.values()].sort((a, b) => {
    const path = (a.path ?? '').localeCompare(b.path ?? '');
    return path === 0 ? a.topic.localeCompare(b.topic) : path;
  });
}

export function buildReviewFixPlan(
  groups: ReviewFeedbackGroup[],
  requestedChanges: ReturnType<
    typeof reviewFactsFromEventState
  >['requestedChanges'],
) {
  return {
    groupCount: groups.length,
    commentCount: groups.reduce((sum, group) => sum + group.comments.length, 0),
    requestedChangesCount: requestedChanges.length,
    groups: groups.map((group) => ({
      path: group.path,
      topic: group.topic,
      commentIds: group.comments.map((comment) => comment.id),
      threadIds: unique(group.comments.map((comment) => comment.threadId)),
      lineHints: unique(
        group.comments
          .map((comment) => comment.line ?? comment.threadLine)
          .filter((line): line is number => typeof line === 'number')
          .map((line) => String(line)),
      ).map(Number),
      summaries: group.comments.map((comment) => summarizeComment(comment)),
      suggestedAction: group.path
        ? 'Read this file through repo-edit, then apply a bounded replacement or patch that directly addresses the reviewer request.'
        : 'Review the general thread context; no file path was supplied by GitHub.',
    })),
  };
}

export function reviewTargetPathSet(groups: ReviewFeedbackGroup[]) {
  return new Set(
    groups
      .map((group) => group.path)
      .filter((path): path is string => Boolean(path)),
  );
}

export function plannedEditPaths(
  replacements: Array<v.InferOutput<typeof reviewFixReplacementSchema>>,
  patch: string | undefined,
) {
  const paths = new Set(replacements.map((replacement) => replacement.path));
  if (patch) {
    for (const operation of parseV4APatch(patch).operations) {
      if (operation.type === 'move') {
        paths.add(operation.from);
        paths.add(operation.to);
      } else {
        paths.add(operation.path);
      }
    }
  }
  return [...paths].sort();
}

export function worktreeStatusDirty(status: unknown) {
  const git = objectField(status, 'git');
  return Boolean(booleanField(git, 'dirty'));
}

export async function readReviewTargetFiles(
  repoId: string,
  worktreeId: string,
  groups: ReviewFeedbackGroup[],
  limit: number,
  paths: RuntimePaths,
) {
  const targetPaths = unique(
    groups
      .map((group) => group.path)
      .filter(
        (path): path is string => typeof path === 'string' && path !== '',
      ),
  );
  const reads = [];
  for (const path of targetPaths) {
    const result = await readRepoFile(
      {
        repoId,
        worktreeId,
        path,
        limit,
        includeLineNumbers: true,
      },
      paths,
    );
    reads.push({
      ok: Boolean(booleanField(result, 'ok')),
      path,
      message: stringField(result, 'message') ?? `Read ${path}.`,
      stamp: objectField(result, 'stamp') ?? null,
      totalLines: numberField(result, 'totalLines') ?? null,
      truncated: Boolean(booleanField(result, 'truncated')),
    });
  }
  return reads;
}

export async function applyReviewEdits(
  input: {
    repoId: string;
    worktreeId: string;
    lockId?: string;
    replacements: Array<v.InferOutput<typeof reviewFixReplacementSchema>>;
    patch?: string;
    dryRun?: boolean;
    fileReads: Array<{ path: string; stamp: object | null }>;
  },
  paths: RuntimePaths,
) {
  const results: unknown[] = [];
  const stamps = new Map(
    input.fileReads
      .filter((read) => read.stamp)
      .map((read) => [read.path, read.stamp!]),
  );
  const readPaths = new Set(input.fileReads.map((read) => read.path));

  const unreadReplacementPaths = unique(
    input.replacements
      .map((replacement) => replacement.path)
      .filter((path) => !readPaths.has(path) || !stamps.has(path)),
  );
  if (unreadReplacementPaths.length > 0) {
    results.push({
      ok: false,
      action: 'repo_files_replace',
      changed: false,
      message: `Replacement target(s) were not read from unresolved review feedback: ${unreadReplacementPaths.join(', ')}.`,
    });
  } else if (input.replacements.length > 0) {
    results.push(
      await replaceRepoFilesAtomically(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          worktreeLockId: input.lockId,
          replacements: input.replacements,
          expectedStamps: Object.fromEntries(stamps) as Record<string, any>,
          dryRun: input.dryRun,
          reason: 'fix_pr_review_feedback',
        },
        paths,
      ),
    );
  }

  if (input.patch) {
    const patch = parseV4APatch(input.patch);
    const patchPaths = patch.operations.flatMap((operation) =>
      operation.type === 'move'
        ? [operation.from, operation.to]
        : [operation.path],
    );
    const unreadPatchPaths = unique(
      patchPaths.filter((path) => !readPaths.has(path) || !stamps.has(path)),
    );
    if (unreadPatchPaths.length > 0) {
      results.push({
        ok: false,
        action: 'repo_file_patch',
        changed: false,
        message: `Patch target(s) were not read from unresolved review feedback: ${unreadPatchPaths.join(', ')}.`,
      });
      return results;
    }
    results.push(
      await patchRepoFiles(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          worktreeLockId: input.lockId,
          patch: input.patch,
          expectedStamps: Object.fromEntries(stamps),
          dryRun: input.dryRun,
          reason: 'fix_pr_review_feedback',
        },
        paths,
      ),
    );
  }

  return results;
}

export function addressedFeedback(
  comments: ReviewCommentFact[],
  commentIds: string[] | undefined,
  threadIds: string[] | undefined,
  plannedPaths: string[] = [],
) {
  const availableCommentIds = new Set(comments.map((comment) => comment.id));
  const availableThreadIds = new Set(
    comments.map((comment) => comment.threadId),
  );
  const plannedPathSet = new Set(plannedPaths);
  const defaultComments =
    plannedPathSet.size > 0
      ? comments.filter((comment) => {
          const path = comment.path ?? comment.threadPath;
          return path ? plannedPathSet.has(path) : false;
        })
      : comments;
  const selectedCommentIds =
    commentIds && commentIds.length > 0
      ? commentIds.filter((id) => availableCommentIds.has(id))
      : defaultComments.map((comment) => comment.id);
  const selectedThreadIds =
    threadIds && threadIds.length > 0
      ? threadIds.filter((id) => availableThreadIds.has(id))
      : unique(
          comments
            .filter((comment) => selectedCommentIds.includes(comment.id))
            .map((comment) => comment.threadId),
        );

  return {
    reviewCommentIds: unique(selectedCommentIds),
    reviewThreadIds: unique(selectedThreadIds),
    ignoredReviewCommentIds: (commentIds ?? []).filter(
      (id) => !availableCommentIds.has(id),
    ),
    ignoredReviewThreadIds: (threadIds ?? []).filter(
      (id) => !availableThreadIds.has(id),
    ),
  };
}

export function reviewFixCommitMessage(
  repo: string,
  prNumber: number,
  addressed: ReturnType<typeof addressedFeedback>,
) {
  const commentIds = formatIds(addressed.reviewCommentIds);
  const threadIds = formatIds(addressed.reviewThreadIds);
  return [
    'Address PR review feedback',
    '',
    `PR: ${repo}#${prNumber}`,
    `Review comments: ${commentIds}`,
    `Review threads: ${threadIds}`,
  ].join('\n');
}

export function formatIds(ids: string[]) {
  if (ids.length === 0) return 'none';
  const head = ids.slice(0, 12).join(', ');
  return ids.length > 12 ? `${head}, +${ids.length - 12} more` : head;
}

function topicFromComment(comment: ReviewCommentFact) {
  const firstLine =
    comment.body
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find(Boolean) ?? 'review feedback';
  return firstLine
    .replace(/\s+/g, ' ')
    .replace(/[`*_#[\]()]/g, '')
    .slice(0, 96);
}

function summarizeComment(comment: ReviewCommentFact) {
  const body = comment.body.replace(/\s+/g, ' ').trim();
  return {
    id: comment.id,
    threadId: comment.threadId,
    authorLogin: comment.authorLogin,
    line: comment.line ?? comment.threadLine,
    outdated: comment.threadIsOutdated,
    url: comment.url,
    body: body.length > 180 ? `${body.slice(0, 177)}...` : body,
  };
}
