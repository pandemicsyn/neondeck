import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export type LearningReviewKind = 'conversation' | 'curation' | 'pr-batch';
export type LearningReviewStatus = 'running' | 'completed' | 'failed';

export type LearningReviewRecord = {
  id: string;
  kind: LearningReviewKind;
  status: LearningReviewStatus;
  model: string;
  thinkingLevel: string;
  trigger: JsonValue;
  inputSummary: JsonValue | null;
  result: JsonValue | null;
  error: string | null;
  flueRunId: string | null;
  startedAt: string;
  completedAt: string | null;
};

export const activeMemoryScopeSchema = v.picklist(['user', 'local', 'project']);
export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const maxReviewMemoryActions = 12;
export const maxReviewMergeSourceIds = 8;
export const maxReviewValueJsonChars = 4_000;
export const jsonValueSchema = v.pipe(
  v.unknown(),
  v.check(
    isBoundedJsonValue,
    `Value must be JSON-safe and no larger than ${maxReviewValueJsonChars} serialized characters.`,
  ),
);
export const memoryProposalSchema = v.variant('action', [
  v.object({
    action: v.literal('upsert'),
    scope: activeMemoryScopeSchema,
    key: nonEmptyStringSchema,
    value: jsonValueSchema,
    repoId: v.optional(nonEmptyStringSchema),
    reason: v.optional(v.string()),
  }),
  v.object({
    action: v.literal('rewrite'),
    memoryId: nonEmptyStringSchema,
    value: jsonValueSchema,
    reason: v.optional(v.string()),
  }),
  v.object({
    action: v.literal('merge'),
    targetId: nonEmptyStringSchema,
    sourceIds: v.pipe(
      v.array(nonEmptyStringSchema),
      v.minLength(1),
      v.maxLength(maxReviewMergeSourceIds),
    ),
    value: v.optional(jsonValueSchema),
    reason: v.optional(v.string()),
  }),
  v.object({
    action: v.literal('archive'),
    memoryId: nonEmptyStringSchema,
    reason: v.optional(v.string()),
  }),
]);
export const skillPatchProposalSchema = v.object({
  skillId: nonEmptyStringSchema,
  summary: v.optional(v.pipe(v.string(), v.maxLength(500))),
  reason: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
  operation: v.variant('type', [
    v.object({
      type: v.literal('append-section'),
      heading: nonEmptyStringSchema,
      content: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
    }),
    v.object({
      type: v.literal('replace-file'),
      afterContent: v.pipe(v.string(), v.minLength(1), v.maxLength(40_000)),
    }),
  ]),
});

export const learningReviewerOutputSchema = v.object({
  summary: v.pipe(v.string(), v.maxLength(2_000)),
  memoryActions: v.optional(
    v.pipe(v.array(memoryProposalSchema), v.maxLength(maxReviewMemoryActions)),
    [],
  ),
  skillPatches: v.optional(
    v.pipe(v.array(skillPatchProposalSchema), v.maxLength(8)),
    [],
  ),
});

export const conversationReviewInputSchema = v.object({
  sessionId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  trigger: v.optional(v.picklist(['manual', 'turn-threshold'])),
  turnCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const curationReviewInputSchema = v.object({
  mode: v.optional(v.picklist(['off', 'review', 'auto'])),
  reason: v.optional(v.string()),
  trigger: v.optional(v.picklist(['manual', 'turn-threshold', 'overflow'])),
  turnCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
export const prBatchReviewInputSchema = v.object({
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  trigger: v.optional(v.picklist(['manual', 'threshold'])),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const learningReviewOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  reviewId: v.optional(v.string()),
  message: v.string(),
});

export type MemoryProposal = v.InferOutput<typeof memoryProposalSchema>;
export type LearningReviewerOutput = v.InferInput<
  typeof learningReviewerOutputSchema
>;
export type ConversationReviewInput = v.InferInput<
  typeof conversationReviewInputSchema
>;
export type CurationReviewInput = v.InferInput<
  typeof curationReviewInputSchema
>;
export type PrBatchReviewInput = v.InferInput<typeof prBatchReviewInputSchema>;

export type PreparedLearningReview = {
  ok: true;
  reviewId: string;
  kind: LearningReviewKind;
  mode: 'off' | 'review' | 'auto';
  skillMode: 'off' | 'review' | 'auto';
  model: string;
  thinkingLevel: string;
  inputSummary: JsonValue;
  prompt: string;
  allowedMemoryIds: string[];
  allowedProjectRepoIds: Array<string | null>;
  allowedSkillIds: string[];
};
export type FailedLearningReview = {
  ok: false;
  action: string;
  changed: false;
  message: string;
  errors: string[];
  requires?: string[];
};

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isFinite(value) || typeof value !== 'number';
  }

  if (Array.isArray(value)) return value.every(isJsonValue);

  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isBoundedJsonValue(value: unknown): boolean {
  if (!isJsonValue(value)) return false;
  try {
    return JSON.stringify(value).length <= maxReviewValueJsonChars;
  } catch {
    return false;
  }
}
