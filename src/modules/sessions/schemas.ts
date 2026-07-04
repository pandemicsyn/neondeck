import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (
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

export type ChatSessionKind =
  'main' | 'scratch' | 'general' | 'repo' | 'watch' | 'task' | 'briefing';

export type ChatSessionSummarySource =
  'manual' | 'metadata' | 'agent' | 'transcript-summary';

export type ChatSessionSummaryStatus = 'missing' | 'fresh' | 'stale';

export type NeonSessionStaleReason = {
  type: 'config' | 'memory' | 'model' | 'provider' | 'repo' | 'skill' | 'soul';
  message: string;
  changedAt: string;
  target: string | null;
};

export type ChatSessionRecord = {
  id: string;
  title: string;
  agentName: string;
  kind: ChatSessionKind;
  pinned: boolean;
  archivedAt: string | null;
  linkedRepoId: string | null;
  linkedWatchId: string | null;
  linkedTaskId: string | null;
  staleReasons: NeonSessionStaleReason[];
  uiMetadata: JsonValue | null;
  summary: string | null;
  summaryGeneratedAt: string | null;
  summarySource: ChatSessionSummarySource | null;
  summaryRefreshNote: string | null;
  summaryStatus: ChatSessionSummaryStatus;
  contextLoadedAt: string;
  contextMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};

export type NeonSessionRecord = {
  id: string;
  label: string;
  agentName: string;
  status: 'active' | 'archived';
  reason: string | null;
  createdAt: string;
  activatedAt: string;
  endedAt: string | null;
  updatedAt: string;
};

export type NeonSessionState = {
  ok: boolean;
  action: 'session_status';
  activeSession: NeonSessionRecord;
  activeChatSession: ChatSessionRecord;
  activeSessionId: string;
  surface: string;
  stale: boolean;
  staleReasons: NeonSessionStaleReason[];
  history: NeonSessionRecord[];
  sessions: ChatSessionRecord[];
  fetchedAt: string;
};

export const chatSessionKindSchema = v.picklist([
  'main',
  'scratch',
  'general',
  'repo',
  'watch',
  'task',
  'briefing',
]);
export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const persistedStaleReasonSchema = v.object({
  type: v.picklist([
    'config',
    'memory',
    'model',
    'provider',
    'repo',
    'skill',
    'soul',
  ]),
  message: nonEmptyStringSchema,
  changedAt: nonEmptyStringSchema,
  target: v.nullable(v.string()),
});
export const persistedStaleReasonsSchema = v.array(persistedStaleReasonSchema);
export const persistedJsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Value must be JSON-safe.'),
);
export const titleSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(96));
export const surfaceSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
);
export const nullableLinkSchema = v.optional(v.nullable(nonEmptyStringSchema));
export const jsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Value must be JSON-safe.'),
);
export const sessionListInputSchema = v.object({
  includeArchived: v.optional(v.boolean()),
  kind: v.optional(chatSessionKindSchema),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  ),
  surface: v.optional(surfaceSchema),
});
export const sessionSearchInputSchema = v.object({
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  includeArchived: v.optional(v.boolean()),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
  ),
  surface: v.optional(surfaceSchema),
});
export const sessionReadInputSchema = v.object({
  id: nonEmptyStringSchema,
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
});
export const sessionMessagesInputSchema = v.object({
  id: nonEmptyStringSchema,
  cursor: v.optional(v.string()),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  ),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
  explicitUserRequest: v.optional(v.boolean()),
});
export const summarySourceSchema = v.picklist([
  'manual',
  'metadata',
  'agent',
  'transcript-summary',
]);
export const sessionCreateInputSchema = v.object({
  title: v.optional(titleSchema),
  kind: v.optional(chatSessionKindSchema),
  surface: v.optional(surfaceSchema),
  activate: v.optional(v.boolean()),
  linkedRepoId: nullableLinkSchema,
  linkedWatchId: nullableLinkSchema,
  linkedTaskId: nullableLinkSchema,
  uiMetadata: v.optional(v.nullable(jsonValueSchema)),
  summary: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2_000)))),
  summarySource: v.optional(summarySourceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const sessionSwitchInputSchema = v.object({
  id: nonEmptyStringSchema,
  surface: v.optional(surfaceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const sessionRenameInputSchema = v.object({
  id: nonEmptyStringSchema,
  title: titleSchema,
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const sessionPinInputSchema = v.object({
  id: nonEmptyStringSchema,
  pinned: v.boolean(),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const sessionArchiveInputSchema = v.object({
  id: nonEmptyStringSchema,
  surface: v.optional(surfaceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const sessionLinkContextInputSchema = v.object({
  id: nonEmptyStringSchema,
  kind: v.optional(chatSessionKindSchema),
  linkedRepoId: nullableLinkSchema,
  linkedWatchId: nullableLinkSchema,
  linkedTaskId: nullableLinkSchema,
  uiMetadata: v.optional(v.nullable(jsonValueSchema)),
  summary: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2_000)))),
  summarySource: v.optional(summarySourceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const sessionRefreshSummaryInputSchema = v.object({
  id: nonEmptyStringSchema,
  providedSummary: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
  source: v.optional(summarySourceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
});
export const sessionReferenceInputSchema = v.object({
  id: nonEmptyStringSchema,
  fromSessionId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
  includeRawTranscript: v.optional(v.boolean()),
  explicitUserRequest: v.optional(v.boolean()),
});
export const legacySessionStartInputSchema = v.object({
  label: v.optional(titleSchema),
  reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(160))),
});
export const sessionActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  titleSuggestion: v.optional(
    v.object({
      title: v.string(),
      model: v.string(),
      thinkingLevel: v.string(),
      fallback: v.boolean(),
      invokedModel: v.boolean(),
    }),
  ),
});
