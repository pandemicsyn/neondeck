import * as v from 'valibot';
import {
  neonReviewFindingLimits,
  neonReviewFindingSchemaVersion,
  type NeonReviewFinding,
  type NeonReviewFindingDraft,
  type NeonReviewFindingSubmission,
  type ReviewSurfaceFindingsApplyRequest,
  type ReviewSurfaceFindingsClearRequest,
  type ReviewSurfaceFindingsDismissRequest,
  type ReviewSurfaceFindingPromoteRequest,
} from '../../../shared/review-finding';
import {
  reviewSourceSchemaVersion,
  type ReviewSourceSnapshot,
} from '../../../shared/review-source';
import {
  reviewSurfaceContextPageLimits,
  reviewSurfaceSchemaVersion,
  type ReviewSurfaceContextPageRequest,
  type ReviewSurfaceNavigationRequest,
  type ReviewSurfaceSnapshot,
} from '../../../shared/review-surface';
import { reviewRefreshSchemaVersion } from '../../../shared/review-refresh';
import { isoDateStringSchema } from '../../lib/valibot';

const identifierSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(240));
const surfaceIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const revisionKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(768));
const pathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));
const nullableIdentifierSchema = v.nullable(identifierSchema);
const findingIdListSchema = v.pipe(
  v.array(identifierSchema),
  v.minLength(1),
  v.maxLength(neonReviewFindingLimits.maxApplyBatch),
  v.check(
    (findingIds) => new Set(findingIds).size === findingIds.length,
    'Finding ids must be unique.',
  ),
);

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
  promotionTargets: v.pipe(
    v.array(
      v.variant('destination', [
        v.object({
          destination: v.literal('github-review-draft'),
          repoFullName: identifierSchema,
          prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
        }),
        v.object({
          destination: v.literal('prepared-diff-revision'),
          preparedDiffId: identifierSchema,
        }),
      ]),
    ),
    v.maxLength(4),
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

const refreshStatusSchema = v.object({
  schemaVersion: v.literal(reviewRefreshSchemaVersion),
  state: v.picklist(['current', 'available', 'applying']),
  appliedRevisionKey: v.nullable(revisionKeySchema),
  availableRevision: v.nullable(reviewRevisionSchema),
  availableRevisionKey: v.nullable(revisionKeySchema),
  pausedReasons: v.pipe(
    v.array(
      v.picklist([
        'dirty-editor',
        'active-selection',
        'stale-draft',
        'reanchor-active',
        'revision-confirmation-open',
        'mutation-pending',
        'safety-uncertain',
      ]),
    ),
    v.maxLength(7),
  ),
  preservation: v.nullable(v.picklist(['preserved', 'degraded', 'failed'])),
  message: v.nullable(v.pipe(v.string(), v.maxLength(500))),
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
    refresh: refreshStatusSchema,
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

const findingSideSchema = v.picklist(['additions', 'deletions']);
const findingAnchorSchema = v.variant('kind', [
  v.pipe(
    v.object({
      kind: v.literal('line-range'),
      side: findingSideSchema,
      startLine: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(neonReviewFindingLimits.maxLineNumber),
      ),
      endLine: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(neonReviewFindingLimits.maxLineNumber),
      ),
    }),
    v.check(
      (anchor) => anchor.endLine >= anchor.startLine,
      'Finding end line must not precede its start line.',
    ),
    v.check(
      (anchor) =>
        anchor.endLine - anchor.startLine + 1 <=
        neonReviewFindingLimits.maxLineRangeSpan,
      'Finding line range exceeds the supported span.',
    ),
  ),
  v.object({
    kind: v.literal('hunk'),
    side: findingSideSchema,
    hunkId: identifierSchema,
  }),
]);
const findingSeveritySchema = v.picklist(['critical', 'major', 'minor', 'nit']);
const findingConfidenceSchema = v.nullable(
  v.picklist(['high', 'medium', 'low']),
);
const findingProvenanceInputSchema = v.object({
  authorRole: identifierSchema,
  model: nullableIdentifierSchema,
  workflowRunId: nullableIdentifierSchema,
});

const neonReviewFindingSubmissionEntries = {
  schemaVersion: v.literal(neonReviewFindingSchemaVersion),
  id: identifierSchema,
  sourceId: identifierSchema,
  revisionKey: revisionKeySchema,
  file: pathSchema,
  anchor: findingAnchorSchema,
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(neonReviewFindingLimits.maxTitleLength),
  ),
  explanation: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(neonReviewFindingLimits.maxExplanationLength),
  ),
  severity: findingSeveritySchema,
  confidence: findingConfidenceSchema,
  suggestedAction: v.nullable(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(neonReviewFindingLimits.maxSuggestedActionLength),
    ),
  ),
};

export const neonReviewFindingSubmissionSchema: v.GenericSchema<NeonReviewFindingSubmission> =
  v.object(neonReviewFindingSubmissionEntries);

export const neonReviewFindingDraftSchema: v.GenericSchema<NeonReviewFindingDraft> =
  v.object({
    ...neonReviewFindingSubmissionEntries,
    provenance: findingProvenanceInputSchema,
  });

export const neonReviewFindingSchema: v.GenericSchema<NeonReviewFinding> =
  v.object({
    ...neonReviewFindingSubmissionEntries,
    surfaceId: surfaceIdSchema,
    provenance: v.object({
      ...findingProvenanceInputSchema.entries,
      createdAt: isoDateStringSchema,
    }),
    lifecycle: v.object({
      state: v.picklist([
        'active',
        'stale',
        'resolved',
        'dismissed',
        'promoted',
      ]),
      changedAt: isoDateStringSchema,
      reason: v.nullable(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(neonReviewFindingLimits.maxLifecycleReasonLength),
        ),
      ),
      promotion: v.nullable(
        v.object({
          destination: v.picklist([
            'github-review-draft',
            'prepared-diff-revision',
          ]),
          requestId: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(neonReviewFindingLimits.maxPromotionRequestIdLength),
          ),
          requestFingerprint: v.pipe(
            v.string(),
            v.length(neonReviewFindingLimits.maxPromotionFingerprintLength),
            v.regex(/^[a-f0-9]+$/),
          ),
          targetId: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(neonReviewFindingLimits.maxPromotionTargetIdLength),
          ),
          containerId: v.nullable(
            v.pipe(
              v.string(),
              v.minLength(1),
              v.maxLength(neonReviewFindingLimits.maxPromotionTargetIdLength),
            ),
          ),
        }),
      ),
    }),
  });

export const reviewSurfaceFindingPromoteSchema: v.GenericSchema<ReviewSurfaceFindingPromoteRequest> =
  v.object({
    sourceId: identifierSchema,
    revisionKey: revisionKeySchema,
    findingId: identifierSchema,
    requestId: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(neonReviewFindingLimits.maxPromotionRequestIdLength),
    ),
    destination: v.picklist(['github-review-draft', 'prepared-diff-revision']),
    anchor: v.pipe(
      v.object({
        side: findingSideSchema,
        startLine: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(neonReviewFindingLimits.maxLineNumber),
        ),
        endLine: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(neonReviewFindingLimits.maxLineNumber),
        ),
      }),
      v.check(
        (anchor) => anchor.endLine >= anchor.startLine,
        'Promotion end line must not precede its start line.',
      ),
      v.check(
        (anchor) =>
          anchor.endLine - anchor.startLine + 1 <=
          neonReviewFindingLimits.maxLineRangeSpan,
        'Promotion line range exceeds the supported span.',
      ),
    ),
    confirm: v.boolean(),
    reason: v.nullable(
      v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
    ),
  });

const findingBatchSchema = v.pipe(
  v.array(neonReviewFindingSubmissionSchema),
  v.minLength(1),
  v.maxLength(neonReviewFindingLimits.maxApplyBatch),
  v.check(
    (findings) =>
      new Set(findings.map((finding) => finding.id)).size === findings.length,
    'Finding ids must be unique within a batch.',
  ),
);

export const reviewSurfaceFindingsApplySchema: v.GenericSchema<ReviewSurfaceFindingsApplyRequest> =
  v.object({
    revisionKey: revisionKeySchema,
    findings: findingBatchSchema,
  });

export const reviewSurfaceFindingsDismissSchema: v.GenericSchema<ReviewSurfaceFindingsDismissRequest> =
  v.object({
    sourceId: identifierSchema,
    revisionKey: revisionKeySchema,
    findingIds: findingIdListSchema,
    reason: v.nullable(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(neonReviewFindingLimits.maxLifecycleReasonLength),
      ),
    ),
  });

export const reviewSurfaceFindingsClearSchema: v.GenericSchema<ReviewSurfaceFindingsClearRequest> =
  v.object({
    sourceId: identifierSchema,
    revisionKey: revisionKeySchema,
    findingIds: v.optional(findingIdListSchema),
  });

export const reviewSurfaceIdInputSchema = v.object({
  surfaceId: surfaceIdSchema,
});

export const reviewSurfaceContextInputSchema: v.GenericSchema<ReviewSurfaceContextPageRequest> =
  v.object({
    surfaceId: surfaceIdSchema,
    offset: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.maxValue(reviewSurfaceContextPageLimits.maxOffset),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(reviewSurfaceContextPageLimits.maxLimit),
      ),
    ),
  });

export const reviewSurfaceNavigateInputSchema = v.object({
  surfaceId: surfaceIdSchema,
  revisionKey: v.nullable(revisionKeySchema),
  target: v.object({ path: pathSchema, focus: v.boolean() }),
});

export const reviewSurfaceFindingsApplyActionSchema = v.object({
  surfaceId: surfaceIdSchema,
  revisionKey: revisionKeySchema,
  findings: findingBatchSchema,
});

export const reviewSurfaceFindingsDismissActionSchema = v.object({
  surfaceId: surfaceIdSchema,
  sourceId: identifierSchema,
  revisionKey: revisionKeySchema,
  findingIds: findingIdListSchema,
  reason: v.nullable(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(neonReviewFindingLimits.maxLifecycleReasonLength),
    ),
  ),
});

export const reviewSurfaceFindingsClearActionSchema = v.object({
  surfaceId: surfaceIdSchema,
  sourceId: identifierSchema,
  revisionKey: revisionKeySchema,
  findingIds: v.optional(findingIdListSchema),
});

export const reviewSurfaceActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
