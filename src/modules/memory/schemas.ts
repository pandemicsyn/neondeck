import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export type ActiveMemoryScope = 'user' | 'local' | 'project';
export type LegacyMemoryScope = 'session' | 'watch';
export type MemoryScope = ActiveMemoryScope | LegacyMemoryScope;
export type MemoryStatus = 'active' | 'archived';
export type MemoryMutationSource = 'user' | 'neon' | 'workflow';

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  key: string;
  value: JsonValue;
  repoId: string | null;
  status: MemoryStatus;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryEventRecord = {
  id: string;
  memoryId: string | null;
  action:
    'created' | 'updated' | 'rewritten' | 'merged' | 'archived' | 'rejected';
  actor: 'user' | 'neon' | 'workflow';
  reason: string | null;
  before: JsonValue | null;
  after: JsonValue | null;
  createdAt: string;
};

export type MemoryCandidateRecord = {
  id: string;
  target: 'memory';
  status: 'proposed' | 'applied' | 'rejected' | 'archived';
  action: 'upsert' | 'rewrite' | 'merge' | 'archive';
  scope: ActiveMemoryScope | null;
  key: string | null;
  value: JsonValue | null;
  repoId: string | null;
  reason: string | null;
  reviewId: string | null;
  patch: JsonValue | null;
  createdAt: string;
  decidedAt: string | null;
};

export const allMemoryScopeSchema = v.picklist([
  'user',
  'local',
  'project',
  'session',
  'watch',
]);
export const activeMemoryScopeSchema = v.picklist(['user', 'local', 'project']);
export const memoryStatusSchema = v.picklist(['active', 'archived']);
export const memoryActorSchema = v.picklist(['user', 'neon', 'workflow']);
export const memoryCandidateActionSchema = v.picklist([
  'upsert',
  'rewrite',
  'merge',
  'archive',
]);
export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const memoryIdentifierSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  scope: v.optional(allMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
});
export const jsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Value must be JSON-safe.'),
);

export const memoryListInputSchema = v.object({
  scope: v.optional(allMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  status: v.optional(memoryStatusSchema),
  includeArchived: v.optional(v.boolean()),
  repoId: v.optional(nonEmptyStringSchema),
});
export const memoryLearnInputSchema = v.object({
  scope: activeMemoryScopeSchema,
  key: nonEmptyStringSchema,
  value: jsonValueSchema,
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
export const memoryRewriteInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  scope: v.optional(activeMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  value: jsonValueSchema,
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
export const memoryMergeInputSchema = v.object({
  targetId: nonEmptyStringSchema,
  sourceIds: v.pipe(v.array(nonEmptyStringSchema), v.minLength(1)),
  value: v.optional(jsonValueSchema),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
export const memoryArchiveInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  scope: v.optional(activeMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
  confirm: v.optional(v.boolean()),
});
export const memoryMarkUsedInputSchema = v.object({
  ids: v.pipe(v.array(nonEmptyStringSchema), v.minLength(1)),
});
export const memoryEventsInputSchema = v.object({
  memoryId: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const memoryCandidateCreateInputSchema = v.object({
  action: memoryCandidateActionSchema,
  scope: v.optional(activeMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  value: v.optional(jsonValueSchema),
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  reviewId: v.optional(nonEmptyStringSchema),
  patch: v.optional(jsonValueSchema),
});
export const memoryCandidateListInputSchema = v.object({
  status: v.optional(
    v.picklist(['proposed', 'applied', 'rejected', 'archived']),
  ),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const memoryCandidateDecideInputSchema = v.object({
  id: nonEmptyStringSchema,
  decision: v.picklist(['apply', 'reject', 'archive']),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
export const memoryCurateInputSchema = v.object({
  mode: v.optional(v.picklist(['off', 'review', 'auto'])),
  reason: v.optional(v.string()),
});

export const memoryActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

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
