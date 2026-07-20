import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { runtimePaths } from '../../runtime-home';
import {
  addPrWatch,
  listPrWatches,
  readWatch,
  removePrWatch,
  resolveWatchId,
  setPrWatchPolling,
  configureWatchAutopilot,
  transitionWatchAutopilot,
} from '../watches';
import type {
  CheckFetcher,
  PrWatchInitialEventBaselineFetcher,
  WatchFetcher,
} from '../watches';
import { modeSchema } from '../autopilot-policy';

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const configurePrAutopilotInputSchema = v.object({
  ref: nonEmptyString,
  mode: modeSchema,
  processExisting: v.boolean(),
});

export const prAutopilotStatusInputSchema = v.object({
  id: v.optional(nonEmptyString),
  ref: v.optional(nonEmptyString),
});

export const prAutopilotControlInputSchema = v.object({
  id: v.optional(nonEmptyString),
  ref: v.optional(nonEmptyString),
  operation: v.picklist(['pause', 'resume', 'retry', 'stop']),
});

export const prAutopilotOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export async function configurePrAutopilot(
  input: v.InferInput<typeof configurePrAutopilotInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    fetcher?: WatchFetcher;
    checkFetcher?: CheckFetcher;
    initialEventBaselineFetcher?: PrWatchInitialEventBaselineFetcher;
  } = {},
) {
  const parsed = v.safeParse(configurePrAutopilotInputSchema, input);
  if (!parsed.success) return invalid('autopilot_configure_pr', parsed.issues);

  const watchResult = await addPrWatch(
    {
      ref: parsed.output.ref,
      processExisting: parsed.output.processExisting,
      createdBy: 'autopilot',
    },
    paths,
    dependencies.fetcher,
    dependencies.checkFetcher,
    dependencies.initialEventBaselineFetcher,
  );
  if (!watchResult.ok) {
    return { ...watchResult, action: 'autopilot_configure_pr' };
  }
  const watchId = watchResult.id ?? watchIdFromResult(watchResult);
  if (!watchId) {
    return failure(
      'autopilot_configure_pr',
      'The PR watch was created without a durable watch id.',
    );
  }
  const configured = configureWatchAutopilot(
    paths,
    watchId,
    parsed.output.mode,
  );
  if (!configured.watch) {
    return failure(
      'autopilot_configure_pr',
      `Watch "${watchId}" could not be reloaded after configuration.`,
    );
  }
  return {
    ok: true,
    action: 'autopilot_configure_pr',
    changed: watchResult.changed || configured.changed,
    message: `${configured.watch.id} is on Autopilot in ${configured.watch.autopilotMode} mode. ${initialFeedbackMessage(configured.watch.processExisting)} Owner and worktree bindings will be created on the first actionable event.`,
    watch: configured.watch,
  };
}

export async function readPrAutopilotStatus(
  input: v.InferInput<typeof prAutopilotStatusInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(prAutopilotStatusInputSchema, input);
  if (!parsed.success) return invalid('autopilot_watch_status', parsed.issues);
  if (!parsed.output.id && !parsed.output.ref) {
    const result = await listPrWatches(paths);
    return { ...result, action: 'autopilot_watch_status' };
  }
  const resolved = await resolveWatchId(
    parsed.output,
    paths,
    'autopilot_watch_status',
  );
  if (!resolved.ok) return resolved.result;
  const watch = readWatch(paths, resolved.id);
  return watch
    ? {
        ok: true,
        action: 'autopilot_watch_status',
        changed: false,
        message: `Read Autopilot watch "${watch.id}".`,
        watch,
      }
    : failure(
        'autopilot_watch_status',
        `Watch "${resolved.id}" does not exist.`,
      );
}

export async function controlPrAutopilot(
  input: v.InferInput<typeof prAutopilotControlInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(prAutopilotControlInputSchema, input);
  if (!parsed.success) return invalid('autopilot_watch_control', parsed.issues);
  const resolved = await resolveWatchId(
    parsed.output,
    paths,
    'autopilot_watch_control',
  );
  if (!resolved.ok) return resolved.result;

  if (parsed.output.operation === 'pause') {
    return setPrWatchPolling({ id: resolved.id, enabled: false }, paths);
  }
  if (parsed.output.operation === 'resume') {
    return setPrWatchPolling({ id: resolved.id, enabled: true }, paths);
  }
  if (parsed.output.operation === 'stop') {
    return removePrWatch({ id: resolved.id, confirm: true }, paths);
  }

  const watch = transitionWatchAutopilot(paths, resolved.id, {
    from: 'blocked',
    to: 'watching',
  });
  if (!watch) {
    const current = readWatch(paths, resolved.id);
    return current
      ? failure(
          'autopilot_watch_retry',
          `Watch "${resolved.id}" is ${current.autopilotStatus}, not blocked.`,
        )
      : failure(
          'autopilot_watch_retry',
          `Watch "${resolved.id}" does not exist.`,
        );
  }
  await setPrWatchPolling({ id: resolved.id, enabled: true }, paths);
  return {
    ok: true,
    action: 'autopilot_watch_retry',
    changed: true,
    message: `Retry armed for "${resolved.id}". Current facts will be fetched before another owner turn.`,
    watch,
  };
}

export const configurePrAutopilotAction = defineAction({
  name: 'neondeck_autopilot_configure_pr',
  description:
    'Put one pull request on Autopilot with an explicit capability mode and an explicit choice to process or baseline current feedback.',
  input: configurePrAutopilotInputSchema,
  output: prAutopilotOutputSchema,
  async run({ input }) {
    return configurePrAutopilot(input);
  },
});

export const prAutopilotStatusAction = defineAction({
  name: 'neondeck_autopilot_watch_status',
  description:
    'Read the minimal one-owner, one-worktree Autopilot state for one or all PR watches.',
  input: prAutopilotStatusInputSchema,
  output: prAutopilotOutputSchema,
  async run({ input }) {
    return readPrAutopilotStatus(input);
  },
});

export const prAutopilotControlAction = defineAction({
  name: 'neondeck_autopilot_watch_control',
  description:
    'Pause, resume, retry, or stop one PR Autopilot watch using the same deterministic service as the API, CLI, and dashboard.',
  input: prAutopilotControlInputSchema,
  output: prAutopilotOutputSchema,
  async run({ input }) {
    return controlPrAutopilot(input);
  },
});

export const neondeckPrAutopilotWatchActions = [
  configurePrAutopilotAction,
  prAutopilotStatusAction,
  prAutopilotControlAction,
];

function watchIdFromResult(result: { watch?: unknown }) {
  if (!result.watch || typeof result.watch !== 'object') return undefined;
  const id = (result.watch as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function initialFeedbackMessage(processExisting: boolean) {
  return processExisting
    ? 'Current actionable feedback will be processed.'
    : 'Current feedback was baselined; only later changes will run.';
}

function invalid(action: string, issues: Parameters<typeof v.summarize>[0]) {
  return failure(action, `Invalid input: ${v.summarize(issues)}`);
}

function failure(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
  };
}
