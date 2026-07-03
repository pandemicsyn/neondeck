import type { JsonValue } from '@flue/runtime';
import type { NotificationLevel } from '../../app-state';
import type { RuntimePaths } from '../../runtime-home';
import { addPrWatch, refreshPrWatch, refreshRefWatch, type WatchActionResult } from '../watches';
import { fetchCheckSummary } from '../../github';
import * as v from 'valibot';

export type SchedulerResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  outcome?: string;
  jobs?: JsonValue[];
  notifications?: JsonValue[];
  extra?: JsonValue;
  errors?: string[];
  requires?: string[];
};

export type BlueprintKind =
  'morning-briefing' | 'watch-pr' | 'release-watch' | 'review-queue-digest';

export type JobExecutionResult = {
  outcome: 'silent' | 'updated' | 'recorded' | 'failed';
  message: string;
  result?: unknown;
  notifications?: Array<{
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  }>;
};

export type SchedulerDependencies = {
  addPrWatch?: (
    input: Parameters<typeof addPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  refreshPrWatch?: (
    input: Parameters<typeof refreshPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  refreshRefWatch?: (
    input: Parameters<typeof refreshRefWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  fetchCheckSummary?: typeof fetchCheckSummary;
  invokeWorkflow?: (
    workflow: ScheduledWorkflowName,
    input: JsonValue,
  ) => Promise<{ runId: string }>;
  tickLeaseTtlMs?: number;
};

export type ScheduledWorkflowName = 'briefing' | 'command-run';
export type SchedulerTickLease = {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
};
export type SchedulerTickLeaseResult =
  | { acquired: true; owner: string }
  | { acquired: false; reason: 'active' | 'busy' };
export type SchedulerTickLeaseRenewResult = 'renewed' | 'lost' | 'busy';

export const schedulerTickLeaseKey = 'scheduler.tick.lease';
export const defaultSchedulerTickLeaseTtlMs = 5 * 60 * 1000;
export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const blueprintSchema = v.picklist([
  'morning-briefing',
  'watch-pr',
  'release-watch',
  'review-queue-digest',
]);
export const createBlueprintInputSchema = v.object({
  blueprint: blueprintSchema,
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  config: v.optional(v.record(v.string(), v.unknown())),
});
export const schedulerActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  outcome: v.optional(v.string()),
  jobs: v.optional(v.array(v.unknown())),
  notifications: v.optional(v.array(v.unknown())),
  extra: v.optional(v.unknown()),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
});
