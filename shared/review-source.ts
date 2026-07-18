export const reviewSourceSchemaVersion = 2 as const;

export type ReviewSourceKind =
  | 'github-pr'
  | 'prepared-diff'
  | 'kilo-result'
  | 'skill-patch'
  | 'repo-edit-event';

export type ReviewRevisionKind =
  'git-commit' | 'worktree-diff' | 'retained-patch';

export type ResolvedReviewRevision = {
  state: 'resolved';
  kind: ReviewRevisionKind;
  id: string;
  baseId: string | null;
};

export type UnavailableReviewRevision = {
  state: 'unavailable';
  kind: ReviewRevisionKind;
  reason: string;
};

export type ReviewRevision = ResolvedReviewRevision | UnavailableReviewRevision;

export type ReviewSourceCapability =
  | 'comments'
  | 'request-revision'
  | 'context-expansion'
  | 'open-in-editor'
  | 'refresh'
  | 'external-link';

export type ReviewSourcePromotionTarget =
  | {
      destination: 'github-review-draft';
      repoFullName: string;
      prNumber: number;
    }
  | {
      destination: 'prepared-diff-revision';
      preparedDiffId: string;
    };

export type ReviewFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'unknown';

export type ReviewPatchState =
  | 'unloaded'
  | 'loading'
  | 'available'
  | 'unavailable'
  | 'truncated'
  | 'binary'
  | 'stale';

export type ReviewFileMetadata = {
  path: string;
  previousPath: string | null;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  generatedLike: boolean;
  patchState: ReviewPatchState;
  patchMessage: string | null;
};

export type ReviewSourceRepository = {
  repoId: string | null;
  repoFullName: string | null;
  worktreeId: string | null;
  localPath: string | null;
  localAccess: boolean;
};

export type ReviewSourceSnapshot = {
  schemaVersion: typeof reviewSourceSchemaVersion;
  id: string;
  kind: ReviewSourceKind;
  title: string;
  revision: ReviewRevision;
  repository: ReviewSourceRepository;
  files: ReviewFileMetadata[];
  capabilities: ReviewSourceCapability[];
  promotionTargets: ReviewSourcePromotionTarget[];
  externalUrl: string | null;
};

export function resolvedReviewRevision(input: {
  kind: ReviewRevisionKind;
  id: string;
  baseId?: string | null;
}): ResolvedReviewRevision {
  return {
    state: 'resolved',
    kind: input.kind,
    id: input.id,
    baseId: input.baseId ?? null,
  };
}

export function unavailableReviewRevision(
  kind: ReviewRevisionKind,
  reason: string,
): UnavailableReviewRevision {
  return { state: 'unavailable', kind, reason };
}

export function reviewRevisionKey(revision: ReviewRevision) {
  if (revision.state === 'unavailable') return null;
  return [revision.kind, revision.baseId ?? '', revision.id].join(':');
}
