import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export const scheduledTaskExternalValueSchema = v.unknown();
export type ScheduledTaskExternalValue = v.InferInput<
  typeof scheduledTaskExternalValueSchema
>;
const jsonScalarSchema = v.union([
  v.null(),
  v.string(),
  v.pipe(v.number(), v.finite()),
  v.boolean(),
]);
export const scheduledTaskJsonValueSchema: v.GenericSchema<
  ScheduledTaskExternalValue,
  JsonValue
> = v.lazy(() =>
  v.union([
    jsonScalarSchema,
    v.array(scheduledTaskJsonValueSchema),
    v.record(v.string(), scheduledTaskJsonValueSchema),
  ]),
);

export type AutomationTrigger =
  | { kind: 'interval'; everySeconds: number }
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string };

export type ScheduledTaskSpec =
  | { kind: 'poll-pr-watch'; watchId: string }
  | { kind: 'run-briefing'; briefingId: string }
  | {
      kind: 'run-agent-instruction';
      prompt: string;
      target: { kind: 'agent' } | { kind: 'agent-session'; sessionId: string };
      repoId?: string;
      cwd?: string;
      skills: string[];
    };

export type ScheduledTaskRecord = {
  id: string;
  spec: ScheduledTaskSpec;
  trigger: AutomationTrigger;
  enabled: boolean;
  nextRunAt: string | null;
  claimId: string | null;
  claimExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
};

export type ScheduledTaskRunRecord = {
  id: string;
  taskId: string;
  status: 'claimed' | 'active' | 'completed' | 'failed';
  outcome: 'recorded' | 'silent' | 'failed';
  message: string;
  submissionId: string | null;
  sessionId: string | null;
  dispatchKey: string | null;
  dispatchPayload: ScheduledInstructionDispatchPayload | null;
  result: JsonValue | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledInstructionDispatchPayload = {
  prompt: string;
  taskId: string;
};

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const automationTriggerSchema = v.variant('kind', [
  v.object({
    kind: v.literal('interval'),
    everySeconds: v.pipe(v.number(), v.integer(), v.minValue(60)),
  }),
  v.object({
    kind: v.literal('once'),
    at: nonEmptyStringSchema,
  }),
  v.object({
    kind: v.literal('cron'),
    expression: nonEmptyStringSchema,
    timezone: nonEmptyStringSchema,
  }),
]);

export const scheduledTaskSpecSchema = v.variant('kind', [
  v.object({
    kind: v.literal('poll-pr-watch'),
    watchId: nonEmptyStringSchema,
  }),
  v.object({
    kind: v.literal('run-briefing'),
    briefingId: nonEmptyStringSchema,
  }),
  v.object({
    kind: v.literal('run-agent-instruction'),
    prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(8_000)),
    target: v.variant('kind', [
      v.object({ kind: v.literal('agent') }),
      v.object({
        kind: v.literal('agent-session'),
        sessionId: nonEmptyStringSchema,
      }),
    ]),
    repoId: v.optional(nonEmptyStringSchema),
    cwd: v.optional(nonEmptyStringSchema),
    skills: v.array(nonEmptyStringSchema),
  }),
]);
export const scheduledInstructionDispatchPayloadSchema = v.object({
  prompt: v.string(),
  taskId: v.string(),
});
export const scheduledTaskRunStatusSchema = v.picklist([
  'claimed',
  'active',
  'completed',
  'failed',
]);
export const scheduledTaskRunOutcomeSchema = v.picklist([
  'recorded',
  'silent',
  'failed',
]);
