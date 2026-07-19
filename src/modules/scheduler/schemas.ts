import type { JsonValue } from '@flue/runtime';
import type { RuntimePaths } from '../../runtime-home';
import type { addNotification } from '../app-state';
import { refreshPrWatch, type WatchActionResult } from '../watches';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
} from '../pr-events';
import { checkAutopilotConcurrency } from '../autopilot-policy';
import { fetchCheckSummary } from '../github';
import * as v from 'valibot';

export type SchedulerResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  outcome?: string;
  tasks?: JsonValue[];
  notifications?: JsonValue[];
  extra?: JsonValue;
  errors?: string[];
  requires?: string[];
};

export type { AutomationExecutionResult } from '../app-state';

export type SchedulerDependencies = {
  addNotification?: typeof addNotification;
  refreshPrWatch?: (
    input: Parameters<typeof refreshPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  refreshPrWatchEventState?: (
    input: Parameters<typeof refreshPrWatchEventState>[0],
    paths: RuntimePaths,
  ) => ReturnType<typeof refreshPrWatchEventState>;
  listPrWatchEventWatermarks?: (
    input: Parameters<typeof listPrWatchEventWatermarks>[0],
    paths: RuntimePaths,
  ) => ReturnType<typeof listPrWatchEventWatermarks>;
  checkAutopilotConcurrency?: typeof checkAutopilotConcurrency;
  fetchCheckSummary?: typeof fetchCheckSummary;
  invokeWorkflow?: (
    workflow: ScheduledWorkflowName,
    input: JsonValue,
  ) => Promise<{ runId: string }>;
  beforePrWatchEventIntakeAcknowledged?: (input: {
    watchId: string;
    eventId: string;
    outcome: 'admission' | 'notification' | 'no-op';
  }) => void | Promise<void>;
  tickLeaseTtlMs?: number;
};

export type ScheduledWorkflowName =
  | 'briefing'
  | 'command-run'
  | 'scheduled-agent-instruction'
  | 'prepare-pr-worktree'
  | 'triage-pr-event';
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
export const schedulerActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  outcome: v.optional(v.string()),
  tasks: v.optional(v.array(v.unknown())),
  notifications: v.optional(v.array(v.unknown())),
  extra: v.optional(v.unknown()),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
});
