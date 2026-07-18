import * as v from 'valibot';
import type { ReviewRevision } from '../../shared/review-source';

export const maxReadBytes = 256 * 1024;
export const defaultReadLimit = 400;
export const maxReadLimit = 2_000;
export const maxSearchResults = 100;
export const maxPatchBytes = 256 * 1024;

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const repoIdSchema = nonEmptyStringSchema;
export const repoRelativePathSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    const trimmed = value.trim();
    return (
      trimmed === '.' ||
      (!trimmed.startsWith('/') &&
        !trimmed.startsWith('-') &&
        !trimmed.split(/[\\/]/).includes('..'))
    );
  }, 'Expected a safe repo-relative path.'),
);
export const gitRefSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    return (
      !value.startsWith('-') &&
      !value.includes('\u0000') &&
      !/[\s\\~^:?*[\]]/.test(value)
    );
  }, 'Expected a safe git ref name.'),
);

export const fileStampSchema = v.object({
  mtimeMs: v.number(),
  size: v.number(),
  sha256: nonEmptyStringSchema,
});

export const repoReadInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  path: repoRelativePathSchema,
  sessionId: v.optional(nonEmptyStringSchema),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxReadLimit)),
  ),
  includeLineNumbers: v.optional(v.boolean()),
});

export const repoSearchInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  query: nonEmptyStringSchema,
  globs: v.optional(v.array(repoRelativePathSchema)),
  maxResults: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(maxSearchResults),
    ),
  ),
  contextLines: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
  ),
});

export const repoWriteInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  worktreeLockId: v.optional(nonEmptyStringSchema),
  path: repoRelativePathSchema,
  content: v.string(),
  sessionId: v.optional(nonEmptyStringSchema),
  createParentDirectories: v.optional(v.boolean()),
  expectedStamp: v.optional(fileStampSchema),
  reason: v.optional(v.string()),
  dryRun: v.optional(v.boolean()),
});

export const repoReplaceInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  worktreeLockId: v.optional(nonEmptyStringSchema),
  path: repoRelativePathSchema,
  oldString: nonEmptyStringSchema,
  newString: v.string(),
  sessionId: v.optional(nonEmptyStringSchema),
  replaceAll: v.optional(v.boolean()),
  expectedStamp: v.optional(fileStampSchema),
  fuzzy: v.optional(v.picklist(['off', 'safe'])),
  dryRun: v.optional(v.boolean()),
  reason: v.optional(v.string()),
});

export const repoPatchInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  worktreeLockId: v.optional(nonEmptyStringSchema),
  patch: v.pipe(v.string(), v.minLength(1), v.maxLength(maxPatchBytes)),
  sessionId: v.optional(nonEmptyStringSchema),
  expectedStamps: v.optional(v.record(v.string(), fileStampSchema)),
  dryRun: v.optional(v.boolean()),
  reason: v.optional(v.string()),
});

export const repoDiffInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  base: v.optional(gitRefSchema),
  paths: v.optional(v.array(repoRelativePathSchema)),
  includePatch: v.optional(v.boolean()),
  maxPatchBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxPatchBytes)),
  ),
});

export const repoStatusInputSchema = v.object({
  repoId: repoIdSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
});

export const repoCommitInputSchema = v.strictObject({
  repoId: repoIdSchema,
  worktreeId: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  paths: v.optional(v.array(repoRelativePathSchema)),
  sessionId: v.optional(nonEmptyStringSchema),
});

export const repoPushInputSchema = v.strictObject({
  sessionId: v.optional(nonEmptyStringSchema),
  repoId: v.optional(repoIdSchema),
  worktreeId: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  acknowledgeExpansion: v.optional(v.boolean()),
  confirmationToken: v.optional(nonEmptyStringSchema),
});

export const repoEditOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export type FileStamp = v.InferOutput<typeof fileStampSchema>;
export type RepoReadInput = v.InferOutput<typeof repoReadInputSchema>;
export type RepoSearchInput = v.InferOutput<typeof repoSearchInputSchema>;
export type RepoWriteInput = v.InferOutput<typeof repoWriteInputSchema>;
export type RepoReplaceInput = v.InferOutput<typeof repoReplaceInputSchema>;
export type RepoPatchInput = v.InferOutput<typeof repoPatchInputSchema>;
export type RepoDiffInput = v.InferOutput<typeof repoDiffInputSchema>;
export type RepoStatusInput = v.InferOutput<typeof repoStatusInputSchema>;
export type RepoCommitInput = v.InferOutput<typeof repoCommitInputSchema>;
export type RepoPushInput = v.InferOutput<typeof repoPushInputSchema>;

export type RepoEditStatus = 'preview' | 'applied' | 'failed' | 'blocked';

export type RepoEditErrorCode =
  | 'INVALID_INPUT'
  | 'REPO_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_DENIED'
  | 'FILE_NOT_FOUND'
  | 'BINARY_FILE'
  | 'FILE_TOO_LARGE'
  | 'STALE_FILE'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'LOW_CONFIDENCE'
  | 'PATCH_PARSE_ERROR'
  | 'PATCH_VALIDATE_ERROR'
  | 'GIT_ERROR'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_DELETED'
  | 'WORKTREE_NOT_READY'
  | 'WORKTREE_LOCKED'
  | 'PATH_OUTSIDE_WORKTREE_ROOT'
  | 'REPO_MISMATCH'
  | 'CORRUPT_WORKTREE_ROW'
  | 'WORKTREE_ERROR'
  | 'IO_ERROR';

export type RepoEditError = {
  code: RepoEditErrorCode;
  message: string;
  path?: string;
  details?: unknown;
};

export type DiffSummary = {
  files: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
};

export type RepoEditResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  repoId?: string;
  path?: string;
  files?: unknown[];
  diff?: string;
  diffSummary?: DiffSummary;
  revision?: ReviewRevision;
  dryRun?: boolean;
  stale?: boolean | Array<{ path: string; reason: string }>;
  eventId?: string;
  errors?: string[];
  error?: RepoEditError;
  data?: unknown;
};

export function failedResult(
  action: string,
  message: string,
  error: RepoEditError,
): RepoEditResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error,
  };
}

export function invalidInputResult(action: string, message: string) {
  return failedResult(action, message, {
    code: 'INVALID_INPUT',
    message,
  });
}
