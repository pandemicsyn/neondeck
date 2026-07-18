import type {
  AutopilotPreparedDiff,
  GitHubPullRequest,
  KiloTaskRecord,
  LearningCandidate,
  RepoEditEvent,
} from '../../api';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
  unavailableReviewRevision,
  type ReviewFileMetadata,
  type ReviewFileStatus,
  type ReviewPatchState,
  type ReviewRevision,
  type ReviewSourceCapability,
  type ReviewSourceKind,
  type ReviewSourcePromotionTarget,
  type ReviewSourceRepository,
  type ReviewSourceSnapshot,
} from '../../../../shared/review-source';
import { patchHasContent } from './helpers';
import type { DiffFilePatch } from './types';

type PatchStateOptions = {
  loadingPaths?: ReadonlySet<string>;
  stalePaths?: ReadonlySet<string>;
  unavailablePaths?: ReadonlySet<string>;
};

type SourceInput = PatchStateOptions & {
  capabilities: ReviewSourceCapability[];
  externalUrl?: string | null;
  files: DiffFilePatch[];
  id: string;
  kind: ReviewSourceKind;
  promotionTargets?: ReviewSourcePromotionTarget[];
  repository?: Partial<ReviewSourceRepository>;
  revision: ReviewRevision;
  title: string;
};

export function githubPrReviewSource(
  pr: GitHubPullRequest,
  files: DiffFilePatch[],
  options: PatchStateOptions & { localSource: boolean },
) {
  const headSha = pr.headSha?.trim();
  return reviewSource({
    ...options,
    capabilities: [
      'comments',
      'refresh',
      'external-link',
      ...(options.localSource
        ? (['context-expansion', 'open-in-editor'] as const)
        : []),
    ],
    promotionTargets: [
      {
        destination: 'github-review-draft',
        repoFullName: pr.repo,
        prNumber: pr.number,
      },
    ],
    externalUrl: pr.url,
    files,
    id: `github-pr:${pr.repo.toLowerCase()}#${pr.number}`,
    kind: 'github-pr',
    repository: {
      repoFullName: pr.repo,
      localAccess: options.localSource,
    },
    revision: headSha
      ? resolvedReviewRevision({
          kind: 'git-commit',
          id: headSha,
          baseId: pr.baseSha ?? null,
        })
      : unavailableReviewRevision(
          'git-commit',
          'The pull request head SHA is unavailable.',
        ),
    title: pr.title,
  });
}

export function preparedDiffReviewSource(
  diff: AutopilotPreparedDiff,
  files: DiffFilePatch[],
  revision: ReviewRevision | undefined,
  options: PatchStateOptions = {},
) {
  return reviewSource({
    ...options,
    capabilities: [
      'request-revision',
      'context-expansion',
      'open-in-editor',
      'refresh',
    ],
    promotionTargets: [
      {
        destination: 'prepared-diff-revision',
        preparedDiffId: diff.id,
      },
    ],
    files,
    id: `prepared-diff:${diff.id}`,
    kind: 'prepared-diff',
    repository: {
      repoId: diff.repoId,
      repoFullName: diff.repoFullName,
      worktreeId: diff.worktreeId,
      localPath: diff.localPath,
      localAccess: true,
    },
    revision:
      revision ??
      unavailableReviewRevision(
        'worktree-diff',
        'The prepared-diff worktree fingerprint has not loaded.',
      ),
    title: diff.title,
  });
}

export function kiloResultReviewSource(
  task: KiloTaskRecord,
  files: DiffFilePatch[],
  revision: ReviewRevision | undefined,
  options: PatchStateOptions = {},
) {
  const liveWorktree = Boolean(task.repoId && task.worktreeId);
  return reviewSource({
    ...options,
    capabilities: [
      ...(task.preparedDiffId ? (['request-revision'] as const) : []),
      ...(liveWorktree
        ? (['context-expansion', 'open-in-editor', 'refresh'] as const)
        : []),
    ],
    promotionTargets: task.preparedDiffId
      ? [
          {
            destination: 'prepared-diff-revision',
            preparedDiffId: task.preparedDiffId,
          },
        ]
      : [],
    files,
    id: `kilo-result:${task.id}`,
    kind: 'kilo-result',
    repository: {
      repoId: task.repoId,
      repoFullName: task.repoFullName,
      worktreeId: task.worktreeId,
      localPath: task.cwd,
      localAccess: true,
    },
    revision:
      revision ??
      unavailableReviewRevision(
        'worktree-diff',
        'The Kilo result worktree fingerprint is unavailable.',
      ),
    title: task.title,
  });
}

export function skillPatchReviewSource(
  candidate: Pick<LearningCandidate, 'id' | 'repoId' | 'skillId'>,
  files: DiffFilePatch[],
  afterHash: string | null | undefined,
  title: string,
) {
  return reviewSource({
    capabilities: [],
    files,
    id: `skill-patch:${candidate.id}`,
    kind: 'skill-patch',
    repository: {
      repoId: candidate.repoId,
      localAccess: true,
    },
    revision: afterHash
      ? resolvedReviewRevision({ kind: 'retained-patch', id: afterHash })
      : unavailableReviewRevision(
          'retained-patch',
          'The skill patch content hash is unavailable.',
        ),
    title,
  });
}

export function repoEditEventReviewSource(
  event: RepoEditEvent,
  files: DiffFilePatch[],
) {
  return reviewSource({
    capabilities: ['context-expansion', 'open-in-editor'],
    files,
    id: `repo-edit-event:${event.id}`,
    kind: 'repo-edit-event',
    repository: {
      repoId: event.repoId,
      worktreeId: event.worktreeId,
      localAccess: true,
    },
    revision: event.reviewRevision,
    title: `${event.repoId} - ${event.action}`,
  });
}

export function reviewSourceDataAttributes(source: ReviewSourceSnapshot) {
  return {
    'data-review-source-id': source.id,
    'data-review-source-kind': source.kind,
    'data-review-revision-state': source.revision.state,
    ...(source.revision.state === 'resolved'
      ? {
          'data-review-revision-id': source.revision.id,
          'data-review-revision-kind': source.revision.kind,
        }
      : {}),
  };
}

function reviewSource(input: SourceInput): ReviewSourceSnapshot {
  return {
    schemaVersion: reviewSourceSchemaVersion,
    id: input.id,
    kind: input.kind,
    title: input.title,
    revision: input.revision,
    repository: {
      repoId: input.repository?.repoId ?? null,
      repoFullName: input.repository?.repoFullName ?? null,
      worktreeId: input.repository?.worktreeId ?? null,
      localPath: input.repository?.localPath ?? null,
      localAccess: input.repository?.localAccess ?? false,
    },
    files: input.files.map((file) => reviewFile(file, input)),
    capabilities: [...new Set(input.capabilities)],
    promotionTargets: input.promotionTargets ?? [],
    externalUrl: input.externalUrl ?? null,
  };
}

function reviewFile(
  file: DiffFilePatch,
  options: PatchStateOptions,
): ReviewFileMetadata {
  const patchState = reviewPatchState(file, options);
  return {
    path: file.path,
    previousPath: file.previousPath ?? null,
    status: reviewFileStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    generatedLike: file.generatedLike ?? false,
    patchState,
    patchMessage:
      patchState === 'unavailable' || patchState === 'stale'
        ? (file.message ?? null)
        : null,
  };
}

function reviewPatchState(
  file: DiffFilePatch,
  options: PatchStateOptions,
): ReviewPatchState {
  if (options.stalePaths?.has(file.path)) return 'stale';
  if (file.binary) return 'binary';
  if (file.truncated) return 'truncated';
  if (patchHasContent(file.patch)) return 'available';
  if (options.loadingPaths?.has(file.path)) return 'loading';
  if (options.unavailablePaths?.has(file.path) || file.message) {
    return 'unavailable';
  }
  return 'unloaded';
}

function reviewFileStatus(status: string): ReviewFileStatus {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'a' || normalized === 'added') return 'added';
  if (
    normalized === 'm' ||
    normalized === 'modified' ||
    normalized === 'changed'
  ) {
    return 'modified';
  }
  if (
    normalized === 'd' ||
    normalized === 'deleted' ||
    normalized === 'removed'
  ) {
    return 'deleted';
  }
  if (normalized === 'renamed' || /^r\d*$/u.test(normalized)) return 'renamed';
  if (normalized === 'copied' || /^c\d*$/u.test(normalized)) return 'copied';
  if (normalized === '?' || normalized === 'untracked') return 'untracked';
  return 'unknown';
}
