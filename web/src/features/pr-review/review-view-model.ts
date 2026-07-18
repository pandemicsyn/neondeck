import type { SelectedLineRange } from '@pierre/diffs/react';
import {
  ApiError,
  type DiffSummary,
  type GitHubPrReviewDraft,
  type GitHubPrReviewDraftComment,
  type GitHubPullRequest,
  type GitHubPullRequestReviewThread,
  type PrReviewReportOnlyFinding,
} from '../../api';
import type {
  GitHubPrReviewDraftResponse,
  GitHubPrReviewSubmitResponse,
  GitHubPrThreadMutationResponse,
} from '../../api';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import { queryErrorMessage } from '../../lib/query';
import { patchHasContent } from '../diff-viewer/helpers';
import type {
  DiffFilePatch,
  DiffReviewAnnotation,
  FileReviewMapEntry,
} from '../diff-viewer/types';
import type { PullRequestFilePatchQueryState } from './queries';
import {
  commentInputFromSelection,
  reviewCommentPreview,
  type PatchAnchorIndex,
} from './review-helpers';
import {
  commentAnchorLabel,
  latestThreadComment,
  threadPath,
} from './review-ui-helpers';

const findingSeverityRank = {
  nit: 0,
  minor: 1,
  major: 2,
  critical: 3,
} as const;

export function prReviewMapByPath({
  draft,
  files,
  findings,
  neonFindings = [],
  staleCommentIds,
  unresolvedThreads,
}: {
  draft: GitHubPrReviewDraft | null;
  files: DiffFilePatch[];
  findings: PrReviewReportOnlyFinding[];
  neonFindings?: readonly NeonReviewFinding[];
  staleCommentIds: ReadonlySet<string>;
  unresolvedThreads: GitHubPullRequestReviewThread[];
}) {
  const result = new Map<string, FileReviewMapEntry>();
  const currentPathByAlias = reviewMapPathAliases(files);
  for (const file of files) {
    result.set(file.path, emptyFileReviewMapEntry(file.path));
  }

  for (const thread of unresolvedThreads) {
    if (thread.isResolved) continue;
    const path = resolveReviewMapPath(
      threadPath(thread),
      result,
      currentPathByAlias,
    );
    if (!path) continue;
    const entry = result.get(path);
    if (entry) entry.unresolvedThreadCount += 1;
  }
  for (const comment of draft?.comments ?? []) {
    const path = resolveReviewMapPath(comment.path, result, currentPathByAlias);
    if (!path) continue;
    const entry = result.get(path);
    if (!entry) continue;
    entry.draftCount += 1;
    if (staleCommentIds.has(comment.id)) entry.staleDraftCount += 1;
  }
  for (const finding of findings) {
    const path = resolveReviewMapPath(finding.path, result, currentPathByAlias);
    if (!path) continue;
    const entry = result.get(path);
    if (!entry) continue;
    entry.findingCount += 1;
    entry.findingSummaries.push(finding.summary);
    if (
      entry.highestFindingSeverity === null ||
      findingSeverityRank[finding.severity] >
        findingSeverityRank[entry.highestFindingSeverity]
    ) {
      entry.highestFindingSeverity = finding.severity;
    }
  }
  for (const finding of neonFindings) {
    const path = resolveReviewMapPath(finding.file, result, currentPathByAlias);
    if (!path) continue;
    const entry = result.get(path);
    if (!entry) continue;
    entry.findingCount += 1;
    entry.findingSummaries.push(finding.title, finding.explanation);
    if (
      entry.highestFindingSeverity === null ||
      findingSeverityRank[finding.severity] >
        findingSeverityRank[entry.highestFindingSeverity]
    ) {
      entry.highestFindingSeverity = finding.severity;
    }
  }
  return result;
}

function emptyFileReviewMapEntry(path: string): FileReviewMapEntry {
  return {
    draftCount: 0,
    findingCount: 0,
    highestFindingSeverity: null,
    findingSummaries: [],
    path,
    staleDraftCount: 0,
    unresolvedThreadCount: 0,
  };
}

function reviewMapPathAliases(files: DiffFilePatch[]) {
  const aliases = new Map<string, string | null>();
  for (const file of files) {
    if (!file.previousPath || file.previousPath === file.path) continue;
    const current = aliases.get(file.previousPath);
    aliases.set(
      file.previousPath,
      current === undefined || current === file.path ? file.path : null,
    );
  }
  return aliases;
}

function resolveReviewMapPath(
  path: string | null,
  entries: ReadonlyMap<string, FileReviewMapEntry>,
  aliases: ReadonlyMap<string, string | null>,
) {
  if (!path) return null;
  if (entries.has(path)) return path;
  return aliases.get(path) ?? null;
}

export function mergePatchResults(
  files: DiffFilePatch[],
  patchQueryByPath: Map<string, PullRequestFilePatchQueryState>,
) {
  if (patchQueryByPath.size === 0) return files;
  return files.map((file) => {
    const patched = patchQueryByPath.get(file.path)?.file;
    return patched
      ? {
          ...file,
          message: patched.message ?? file.message,
          patch: patched.patch,
          truncated: patched.truncated ?? file.truncated,
        }
      : file;
  });
}

export function draftCommentIdsWithUnknownPatch(
  draft: GitHubPrReviewDraft | null,
  files: DiffFilePatch[],
  patchQueryByPath: Map<string, PullRequestFilePatchQueryState>,
  deferredPatchPaths: ReadonlySet<string> = new Set(),
) {
  const unknown = new Set<string>();
  for (const comment of draft?.comments ?? []) {
    const file = files.find((item) => item.path === comment.path);
    if (patchHasContent(file?.patch)) continue;
    const query = patchQueryByPath.get(comment.path);
    if (
      deferredPatchPaths.has(comment.path) ||
      (query && (query.isLoading || query.isError || !query.hasData))
    ) {
      unknown.add(comment.id);
    }
  }
  return unknown;
}

export function firstReviewablePath(files: DiffFilePatch[]) {
  return (
    files.find((file) => !file.binary && !file.truncated)?.path ??
    files[0]?.path
  );
}

export function reviewPatchQuerySettled(
  query: PullRequestFilePatchQueryState | undefined,
) {
  return Boolean(query?.hasData || query?.isError);
}

export function backgroundReviewPatchPaths({
  activePath,
  draft,
  files,
  unresolvedThreads,
}: {
  activePath: string | null;
  draft: GitHubPrReviewDraft | null;
  files: DiffFilePatch[];
  unresolvedThreads: GitHubPullRequestReviewThread[];
}) {
  const availablePaths = new Set(files.map((file) => file.path));
  const activeIndex = activePath
    ? files.findIndex((file) => file.path === activePath)
    : -1;
  const paths = [
    activeIndex >= 0 ? files[activeIndex - 1]?.path : null,
    activeIndex >= 0 ? files[activeIndex + 1]?.path : null,
    ...(draft?.comments.map((comment) => comment.path) ?? []),
    ...unresolvedThreads
      .map(threadPath)
      .filter((path): path is string => Boolean(path)),
  ];
  return [...new Set(paths)].filter((path): path is string =>
    Boolean(path && path !== activePath && availablePaths.has(path)),
  );
}

export function annotationsFromThreads(
  threads: GitHubPullRequestReviewThread[],
  files: DiffFilePatch[] = [],
) {
  const annotations: Record<string, DiffReviewAnnotation[]> = {};
  for (const thread of threads) {
    const requestedPath = threadPath(thread);
    const path = resolveReviewFilePath(files, requestedPath) ?? requestedPath;
    if (!path) continue;
    const annotation = annotationFromThread(thread);
    if (annotation.lineNumber < 1) continue;
    annotations[path] = [...(annotations[path] ?? []), annotation];
  }
  return annotations;
}

function annotationFromThread(
  thread: GitHubPullRequestReviewThread,
): DiffReviewAnnotation {
  const comment = latestThreadComment(thread);
  const anchor = threadAnchor(thread);
  return {
    ...anchor,
    metadata: {
      id: thread.id,
      kind: 'thread',
      title: `${thread.comments.length} review comment${thread.comments.length === 1 ? '' : 's'}`,
      body: reviewCommentPreview(comment?.body ?? 'Review thread'),
      authorLogin: comment?.authorLogin ?? null,
      url: comment?.url ?? null,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
    },
  };
}

export function annotationsFromDraft(
  draft: GitHubPrReviewDraft | null,
  staleCommentIds: Set<string>,
  files: DiffFilePatch[] = [],
) {
  const annotations: Record<string, DiffReviewAnnotation[]> = {};
  for (const comment of draft?.comments ?? []) {
    const annotation = annotationFromDraftComment(
      comment,
      staleCommentIds.has(comment.id),
    );
    const path = resolveReviewFilePath(files, comment.path) ?? comment.path;
    annotations[path] = [...(annotations[path] ?? []), annotation];
  }
  return annotations;
}

export function resolveReviewFilePath(
  files: DiffFilePatch[],
  path: string | null,
) {
  if (!path) return null;
  if (files.some((file) => file.path === path)) return path;
  return reviewMapPathAliases(files).get(path) ?? null;
}

export function annotationsFromComposer(
  composer: { annotation: DiffReviewAnnotation; path: string } | null,
) {
  if (!composer) return {};
  return { [composer.path]: [composer.annotation] };
}

function annotationFromDraftComment(
  comment: GitHubPrReviewDraftComment,
  isStale: boolean,
): DiffReviewAnnotation {
  return {
    side: comment.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber: comment.line,
    metadata: {
      id: comment.id,
      kind: 'draft',
      title: commentAnchorLabel(comment),
      body: reviewCommentPreview(comment.body),
      isStale,
    },
  };
}

export function mergeAnnotations(
  ...groups: Array<Record<string, DiffReviewAnnotation[]> | null | undefined>
) {
  const merged: Record<string, DiffReviewAnnotation[]> = {};
  for (const group of groups) {
    for (const [path, annotations] of Object.entries(group ?? {})) {
      merged[path] = [...(merged[path] ?? []), ...annotations];
    }
  }
  return merged;
}

export function annotationFromSelection(
  selection: SelectedLineRange,
  index?: PatchAnchorIndex,
): DiffReviewAnnotation {
  const input = commentInputFromSelection(selection, index);
  return {
    side: input.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber: input.line,
    metadata: {
      id: 'composer',
      kind: 'composer',
      title: selectionLabel(selection, index),
      body: '',
    },
  };
}

function selectionLabel(
  selection: SelectedLineRange,
  index?: Parameters<typeof commentInputFromSelection>[1],
) {
  const input = commentInputFromSelection(selection, index);
  if (input.startLine) {
    return `${input.startSide} L${input.startLine} -> ${input.side} L${input.line}`;
  }
  return `${input.side} L${input.line}`;
}

function threadAnchor(thread: GitHubPullRequestReviewThread) {
  const side: DiffReviewAnnotation['side'] =
    thread.diffSide === 'LEFT' ? 'deletions' : 'additions';
  if (side === 'deletions') {
    const line =
      positiveLine(thread.originalLine) ??
      positiveLine(latestThreadComment(thread)?.originalLine) ??
      positiveLine(thread.line) ??
      positiveLine(latestThreadComment(thread)?.line);
    return { side, lineNumber: line ?? 0 };
  }

  const line =
    positiveLine(thread.line) ??
    positiveLine(latestThreadComment(thread)?.line);
  return { side, lineNumber: line ?? 0 };
}

function positiveLine(value: number | null | undefined) {
  return typeof value === 'number' && value > 0 ? value : null;
}

export function mutationErrorMessage(
  error: unknown,
  draft: GitHubPrReviewDraft | null,
) {
  if (error instanceof ApiError) {
    const data = error.data as
      | GitHubPrReviewDraftResponse
      | GitHubPrReviewSubmitResponse
      | GitHubPrThreadMutationResponse
      | undefined;
    const details = [
      ...(data?.errors ?? []),
      ...(data?.requires?.length
        ? [`Requires: ${data.requires.join(', ')}`]
        : []),
      ...(data?.data &&
      'failingCommentIds' in data.data &&
      Array.isArray(data.data.failingCommentIds) &&
      data.data.failingCommentIds.length > 0
        ? [
            `Failing comments: ${failingCommentLabels(data.data.failingCommentIds, draft).join(', ')}`,
          ]
        : []),
    ];
    return details.length > 0
      ? `${error.message} ${details.join(' ')}`
      : error.message;
  }
  return error ? queryErrorMessage(error) : null;
}

function failingCommentLabels(
  ids: string[],
  draft: GitHubPrReviewDraft | null,
) {
  return ids.map((id) => {
    const comment = draft?.comments.find((item) => item.id === id);
    if (!comment) return id.slice(0, 8);
    return `${comment.path} ${commentAnchorLabel(comment)}`;
  });
}

export function prDetail(
  pr: GitHubPullRequest,
  summary: DiffSummary | undefined,
) {
  const sha = pr.headSha ? pr.headSha.slice(0, 7) : 'head unknown';
  const files = summary ? `${summary.files} files` : 'files';
  return `${pr.baseRef ?? 'base'} <- ${sha} - ${files}`;
}

export function summaryLabel(summary: DiffSummary) {
  return `+${summary.additions} -${summary.deletions}`;
}

export function reviewFileStats(files: DiffFilePatch[]) {
  return {
    binary: files.filter((file) => file.binary).length,
    truncated: files.filter((file) => file.truncated).length,
  };
}

export function checkLabel(pr: GitHubPullRequest) {
  if (pr.checkError) return 'checks unknown';
  if (!pr.checks) return 'checks unknown';
  if (pr.checks.status === 'success') return 'checks pass';
  if (pr.checks.status === 'failure') return `${pr.checks.failed} failed`;
  if (pr.checks.status === 'pending') return `${pr.checks.pending} pending`;
  return 'no checks';
}

export function checkBadgeClass(pr: GitHubPullRequest) {
  if (pr.checks?.status === 'failure') return 'border-accent text-accent';
  if (pr.checks?.status === 'pending') return 'border-violet text-violet';
  if (pr.checks?.status === 'success') return 'border-primary text-primary';
  return '';
}

export function hasRenderablePrPatch(files: DiffFilePatch[]) {
  return files.some((file) => patchHasContent(file.patch));
}
