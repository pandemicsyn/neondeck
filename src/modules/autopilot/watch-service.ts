import { defineAction, dispatch } from '@flue/runtime';
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
  PrWatch,
  PrWatchInitialEventBaselineFetcher,
  WatchFetcher,
} from '../watches';
import { modeSchema } from '../autopilot-policy';
import { completeAutopilotWatchIfTerminal } from './owner/lifecycle';
import { gitCurrentSha, gitStatus } from '../../repo-edit/git';
import { readManagedWorktree } from '../worktrees';
import {
  clearPendingAutopilotTurn,
  registerPendingAutopilotTurn,
} from './owner/pending';

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const configurePrAutopilotInputSchema = v.object({
  ref: nonEmptyString,
  mode: modeSchema,
  processExisting: v.boolean(),
  confirm: v.optional(v.boolean()),
  desiredTerminalState: v.optional(v.picklist(['checks', 'merged'])),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  createdBy: v.optional(nonEmptyString),
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

export const prAutopilotOwnerMessageInputSchema = v.object({
  id: v.optional(nonEmptyString),
  ref: v.optional(nonEmptyString),
  message: nonEmptyString,
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
      createdBy: parsed.output.createdBy ?? 'autopilot',
      desiredTerminalState: parsed.output.desiredTerminalState,
      intervalSeconds: parsed.output.intervalSeconds,
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
  const current = readWatch(paths, watchId);
  if (!current) {
    return failure(
      'autopilot_configure_pr',
      `Watch "${watchId}" could not be read before configuration.`,
    );
  }
  if (
    autopilotModeRank(parsed.output.mode) >
      autopilotModeRank(current.autopilotMode) &&
    parsed.output.confirm !== true
  ) {
    return {
      ok: false,
      action: 'autopilot_configure_pr',
      changed: watchResult.changed,
      message: `Increasing Autopilot from ${current.autopilotMode} to ${parsed.output.mode} requires explicit confirmation.`,
      watch: current,
      requires: ['confirmAutopilotMode'],
      errors: [
        'Set confirm=true only after the user explicitly confirms this autonomy increase.',
      ],
    };
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
    const stopped = await completeAutopilotWatchIfTerminal(resolved.id, paths, {
      explicitStop: true,
    });
    return stopped.complete
      ? {
          ok: true,
          action: 'autopilot_watch_stop',
          changed: true,
          message: `Stopped Autopilot watch "${resolved.id}".`,
          watch: stopped.watch,
          cleanup: stopped.cleanup,
        }
      : failure(
          'autopilot_watch_stop',
          `Watch "${resolved.id}" could not be stopped because its state changed.`,
        );
  }

  const current = readWatch(paths, resolved.id);
  if (
    current?.autopilotStatus === 'blocked' &&
    current.autopilotMode === 'autofix-with-approval' &&
    current.worktreeId
  ) {
    try {
      const worktree = await readManagedWorktree(
        current.worktreeId,
        current.repoId,
        paths,
      );
      const [status, currentSha] = await Promise.all([
        gitStatus(worktree.localPath),
        gitCurrentSha(worktree.localPath),
      ]);
      if (
        status.clean &&
        currentSha !== worktree.headSha &&
        currentSha !== worktree.lastPushedSha
      ) {
        const waiting = transitionWatchAutopilot(paths, current.id, {
          from: 'blocked',
          to: 'waiting',
        });
        if (!waiting) {
          return failure(
            'autopilot_watch_retry',
            `Watch "${current.id}" changed before the held approval turn could be restored.`,
          );
        }
        await setPrWatchPolling({ id: current.id, enabled: true }, paths);
        return {
          ok: true,
          action: 'autopilot_watch_retry',
          changed: true,
          message: `Restored "${current.id}" to human review with its prepared commit held steady.`,
          watch: waiting,
        };
      }
    } catch (error) {
      return failure(
        'autopilot_watch_retry',
        `Could not inspect the held approval worktree safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

export async function messagePrAutopilotOwner(
  input: v.InferInput<typeof prAutopilotOwnerMessageInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dispatchOwner: typeof dispatch = dispatch,
) {
  const parsed = v.safeParse(prAutopilotOwnerMessageInputSchema, input);
  if (!parsed.success) return invalid('autopilot_owner_message', parsed.issues);
  const resolved = await resolveWatchId(
    parsed.output,
    paths,
    'autopilot_owner_message',
  );
  if (!resolved.ok) return resolved.result;
  const watch = readWatch(paths, resolved.id);
  if (
    !watch ||
    !watch.ownerInstanceId ||
    watch.autopilotMode !== 'autofix-with-approval' ||
    watch.autopilotStatus !== 'waiting'
  ) {
    return failure(
      'autopilot_owner_message',
      `Watch "${resolved.id}" is not an approval-mode owner waiting for a direct human message.`,
    );
  }
  const claimed = transitionWatchAutopilot(paths, watch.id, {
    from: 'waiting',
    to: 'working',
  });
  if (!claimed) {
    return failure(
      'autopilot_owner_message',
      `Watch "${watch.id}" changed before the human turn could be claimed.`,
    );
  }
  registerPendingAutopilotTurn(
    paths.home,
    watch.ownerInstanceId,
    undefined,
    watch.autopilotMode,
    'direct-human',
  );
  let receipt;
  try {
    receipt = await dispatchOwner({
      agent: 'pr-autopilot-owner',
      id: watch.ownerInstanceId,
      input: parsed.output.message,
    });
  } catch (error) {
    clearPendingAutopilotTurn(paths.home, watch.ownerInstanceId);
    transitionWatchAutopilot(paths, watch.id, {
      from: 'working',
      to: 'blocked',
    });
    return failure(
      'autopilot_owner_message',
      `The human owner turn could not be dispatched: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    ok: true,
    action: 'autopilot_owner_message',
    changed: true,
    message: `Sent the human instruction to continuing owner ${watch.ownerInstanceId}.`,
    watch: claimed,
    dispatchId: receipt.dispatchId,
  };
}

export const configurePrAutopilotAction = defineAction({
  name: 'neondeck_autopilot_configure_pr',
  description:
    'Put one pull request on Autopilot with an explicit capability mode and an explicit choice to process or baseline current feedback. Enabling or increasing capability above notify-only requires confirm=true after explicit user confirmation.',
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

export const prAutopilotOwnerMessageAction = defineAction({
  name: 'neondeck_autopilot_message_owner',
  description:
    'Send the user’s direct instruction to the same approval-mode PR owner while its managed worktree is held for review. This is the authority-bearing human turn.',
  input: prAutopilotOwnerMessageInputSchema,
  output: prAutopilotOutputSchema,
  async run({ input }) {
    return messagePrAutopilotOwner(input);
  },
});

export const neondeckPrAutopilotWatchActions = [
  configurePrAutopilotAction,
  prAutopilotStatusAction,
  prAutopilotControlAction,
  prAutopilotOwnerMessageAction,
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

function autopilotModeRank(mode: PrWatch['autopilotMode']) {
  return [
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ].indexOf(mode);
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
