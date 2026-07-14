import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export const defaultBriefingProfileId = 'morning';
export const defaultBriefingInstructions =
  'Summarize what needs my attention today. Prioritize review requests, failing checks, blocked automation, and time-sensitive follow-up. Keep the briefing concise and distinguish observed facts from inference.';
export const defaultBriefingSchedule = '0 8 * * 1-5';

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const timezoneSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Timezone must be a valid IANA timezone.'),
);

export const briefingProfileUpdateSchema = v.object({
  id: v.optional(v.pipe(nonEmptyStringSchema, v.maxLength(64))),
  name: v.optional(v.pipe(nonEmptyStringSchema, v.maxLength(96))),
  enabled: v.optional(v.boolean()),
  instructions: v.optional(v.pipe(nonEmptyStringSchema, v.maxLength(8_000))),
  schedule: v.optional(v.pipe(nonEmptyStringSchema, v.maxLength(160))),
  timezone: v.optional(timezoneSchema),
});

export const briefingRunNowSchema = v.object({
  profileId: v.optional(v.pipe(nonEmptyStringSchema, v.maxLength(64))),
  sessionId: v.optional(nonEmptyStringSchema),
  commandEventId: v.optional(nonEmptyStringSchema),
  trigger: v.optional(v.picklist(['manual', 'dashboard'])),
});

export const briefingWorkflowInputSchema = v.object({
  profileId: v.optional(v.pipe(nonEmptyStringSchema, v.maxLength(64))),
  taskId: v.optional(nonEmptyStringSchema),
  sessionId: v.optional(nonEmptyStringSchema),
  commandEventId: v.optional(nonEmptyStringSchema),
  trigger: v.optional(v.picklist(['manual', 'scheduled', 'dashboard'])),
});

export const briefingSnapshotSchema = v.object({
  version: v.literal(1),
  collectedAt: nonEmptyStringSchema,
  byteSize: v.pipe(v.number(), v.integer(), v.minValue(0)),
  truncated: v.boolean(),
  sources: v.record(
    v.string(),
    v.object({
      status: v.picklist(['ok', 'partial', 'unavailable']),
      fetchedAt: nonEmptyStringSchema,
      truncated: v.boolean(),
      error: v.optional(v.string()),
      data: v.nullable(v.unknown()),
    }),
  ),
});

export type BriefingSourceStatus = {
  status: 'ok' | 'partial' | 'unavailable';
  fetchedAt: string;
  truncated: boolean;
  error?: string;
};

export type BriefingSnapshotSource = BriefingSourceStatus & {
  data: JsonValue | null;
};

export type BriefingSnapshot = {
  version: 1;
  collectedAt: string;
  byteSize: number;
  truncated: boolean;
  sources: Record<string, BriefingSnapshotSource>;
};

export type BriefingProfile = {
  id: string;
  name: string;
  enabled: boolean;
  instructions: string;
  instructionsVersion: number;
  schedule: string;
  timezone: string;
  sessionId: string | null;
  compatibility: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BriefingRunStatus = 'queued' | 'ready' | 'failed';

export type BriefingRun = {
  id: string;
  profileId: string | null;
  trigger: 'manual' | 'scheduled' | 'dashboard';
  snapshot: BriefingSnapshot;
  instructions: string;
  instructionsVersion: number;
  sessionId: string;
  commandEventId: string | null;
  dispatchId: string | null;
  workflowRunId: string | null;
  status: BriefingRunStatus;
  error: string | null;
  queuedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BriefingRunMetadata = Omit<
  BriefingRun,
  'snapshot' | 'instructions'
> & {
  snapshot: Pick<
    BriefingSnapshot,
    'version' | 'collectedAt' | 'byteSize' | 'truncated'
  >;
};
