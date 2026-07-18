import * as v from 'valibot';
import {
  reviewSourceSchemaVersion,
  type ReviewSourceSnapshot,
} from '../../../shared/review-source';
import {
  reviewSurfaceSchemaVersion,
  type ReviewSurfaceNavigationRequest,
  type ReviewSurfaceSnapshot,
} from '../../../shared/review-surface';

const identifierSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(240));
const surfaceIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const revisionKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(768));
const pathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));
const nullableIdentifierSchema = v.nullable(identifierSchema);

const reviewRevisionSchema = v.variant('state', [
  v.object({
    state: v.literal('resolved'),
    kind: v.picklist(['git-commit', 'worktree-diff', 'retained-patch']),
    id: identifierSchema,
    baseId: nullableIdentifierSchema,
  }),
  v.object({
    state: v.literal('unavailable'),
    kind: v.picklist(['git-commit', 'worktree-diff', 'retained-patch']),
    reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  }),
]);

const reviewFileSchema = v.object({
  path: pathSchema,
  previousPath: v.nullable(pathSchema),
  status: v.picklist([
    'added',
    'modified',
    'deleted',
    'renamed',
    'copied',
    'untracked',
    'unknown',
  ]),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  generatedLike: v.boolean(),
  patchState: v.picklist([
    'unloaded',
    'loading',
    'available',
    'unavailable',
    'truncated',
    'binary',
    'stale',
  ]),
  patchMessage: v.nullable(v.pipe(v.string(), v.maxLength(1_000))),
});

const reviewSourceSchema: v.GenericSchema<ReviewSourceSnapshot> = v.object({
  schemaVersion: v.literal(reviewSourceSchemaVersion),
  id: identifierSchema,
  kind: v.picklist([
    'github-pr',
    'prepared-diff',
    'kilo-result',
    'skill-patch',
    'repo-edit-event',
  ]),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  revision: reviewRevisionSchema,
  repository: v.object({
    repoId: nullableIdentifierSchema,
    repoFullName: nullableIdentifierSchema,
    worktreeId: nullableIdentifierSchema,
    localPath: v.nullable(pathSchema),
    localAccess: v.boolean(),
  }),
  files: v.pipe(v.array(reviewFileSchema), v.maxLength(5_000)),
  capabilities: v.pipe(
    v.array(
      v.picklist([
        'comments',
        'request-revision',
        'context-expansion',
        'open-in-editor',
        'refresh',
        'external-link',
      ]),
    ),
    v.maxLength(16),
  ),
  externalUrl: v.nullable(v.pipe(v.string(), v.maxLength(2_048))),
});

const selectionSchema = v.object({
  path: pathSchema,
  side: v.picklist(['additions', 'deletions']),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  endSide: v.nullable(v.picklist(['additions', 'deletions'])),
});

export const reviewSurfaceSnapshotSchema: v.GenericSchema<ReviewSurfaceSnapshot> =
  v.object({
    schemaVersion: v.literal(reviewSurfaceSchemaVersion),
    surfaceId: surfaceIdSchema,
    source: reviewSourceSchema,
    activePath: v.nullable(pathSchema),
    selection: v.nullable(selectionSchema),
    selectedAnnotationId: nullableIdentifierSchema,
    fileFilter: v.nullable(v.pipe(v.string(), v.maxLength(500))),
    reviewOrder: v.pipe(v.array(pathSchema), v.maxLength(5_000)),
    viewMode: v.picklist(['file', 'changeset']),
    presentationMode: v.picklist(['unified', 'split', 'auto']),
    annotationVisibility: v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(80))),
      v.maxLength(32),
    ),
  });

export const reviewSurfaceNavigationRequestSchema: v.GenericSchema<ReviewSurfaceNavigationRequest> =
  v.object({
    revisionKey: v.nullable(revisionKeySchema),
    target: v.object({ path: pathSchema, focus: v.boolean() }),
  });

export const reviewSurfaceNavigationAckInputSchema = v.object({
  status: v.picklist(['resolved', 'stale-revision', 'target-unavailable']),
  revisionKey: v.nullable(revisionKeySchema),
  resolvedPath: v.nullable(pathSchema),
  message: v.nullable(v.pipe(v.string(), v.maxLength(500))),
});
