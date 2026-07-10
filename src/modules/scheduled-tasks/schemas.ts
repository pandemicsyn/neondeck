import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

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
      target:
        { kind: 'workflow' } | { kind: 'agent-session'; sessionId: string };
      repoId?: string;
      cwd?: string;
      skills: string[];
      delivery: 'notification' | 'report' | 'session';
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
  status: 'claimed' | 'completed' | 'failed';
  outcome: 'recorded' | 'silent' | 'failed';
  message: string;
  workflowRunId: string | null;
  sessionId: string | null;
  result: JsonValue | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
      v.object({ kind: v.literal('workflow') }),
      v.object({
        kind: v.literal('agent-session'),
        sessionId: nonEmptyStringSchema,
      }),
    ]),
    repoId: v.optional(nonEmptyStringSchema),
    cwd: v.optional(nonEmptyStringSchema),
    skills: v.array(nonEmptyStringSchema),
    delivery: v.picklist(['notification', 'report', 'session']),
  }),
]);
