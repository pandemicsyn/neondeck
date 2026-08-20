import { type JsonValue, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { runtimePaths } from '../../runtime-home';
import {
  addPrWatch,
  canonicalizePrWatchRepoId,
  listPrWatches,
  readWatch,
  resolveWatchId,
  setPrWatchPolling,
  configureWatchAutopilot,
  transitionWatchAutopilot,
} from '../watches';
import type {
  CheckFetcher,
  PrWatch,
  PrWatchInitialEventBaselineFetcher,
  WatchActionResult,
  WatchFetcher,
} from '../watches';
import { modeSchema } from '../autopilot-policy';
import { completeAutopilotWatchIfTerminal } from './owner/lifecycle';
import { gitCurrentSha, gitStatus } from '../../repo-edit/git';
import { readRepoDiff } from '../../repo-edit';
import { readManagedWorktree } from '../worktrees';
import {
  clearPendingAutopilotTurnIfMatches,
  recordPendingAutopilotTurnCorrelationId,
  recordPendingAutopilotTurnError,
  registerPendingAutopilotTurn,
} from './owner/pending';
import {
  dispatchAutopilotOwnerMessage,
  type AutopilotOwnerDispatcher,
} from './owner/dispatch';
import { watchAutopilotOwnerSettlement } from './owner/settlement';

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

const autopilotWatchResultSchema = v.object({
  id: nonEmptyString,
  updatedAt: nonEmptyString,
  autopilotMode: v.picklist([
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ]),
  autopilotStatus: v.picklist([
    'watching',
    'working',
    'waiting',
    'blocked',
    'stopping',
    'complete',
  ]),
});

type StopAutopilotOptions = {
  explicitStop: true;
  confirmPreparedDiff?: true;
};

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
  confirmPreparedDiff: v.optional(v.boolean()),
});

export const prAutopilotOwnerMessageInputSchema = v.object({
  id: v.optional(nonEmptyString),
  ref: v.optional(nonEmptyString),
  message: nonEmptyString,
});

export const prAutopilotApprovalInputSchema = v.object({
  id: v.optional(nonEmptyString),
  ref: v.optional(nonEmptyString),
  expectedRevisionKey: nonEmptyString,
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
    addWatch?: typeof addPrWatch;
    fetcher?: WatchFetcher;
    checkFetcher?: CheckFetcher;
    initialEventBaselineFetcher?: PrWatchInitialEventBaselineFetcher;
    upsertPollingTask?: NonNullable<
      Parameters<typeof addPrWatch>[5]
    >['upsertPollingTask'];
  } = {},
) {
  const parsed = v.safeParse(configurePrAutopilotInputSchema, input);
  if (!parsed.success) return invalid('autopilot_configure_pr', parsed.issues);
  const resolved = await resolveWatchId(
    { ref: parsed.output.ref },
    paths,
    'autopilot_configure_pr',
  );
  if (!resolved.ok) {
    return { ...resolved.result, action: 'autopilot_configure_pr' };
  }
  const existing = readWatch(paths, resolved.id);
  if (existing?.autopilotStatus === 'stopping') {
    return {
      ...failure(
        'autopilot_configure_pr',
        `Autopilot for "${existing.id}" is stopping and cannot be reconfigured until cleanup finishes.`,
      ),
      watch: existing,
      requires: ['retryStop'],
    };
  }
  const increasesAuthority =
    existing === undefined
      ? parsed.output.mode !== 'notify-only'
      : autopilotModeRank(parsed.output.mode) >
        autopilotModeRank(existing.autopilotMode);
  const rearmsCompletedAuthority =
    existing?.autopilotStatus === 'complete' &&
    parsed.output.mode !== 'notify-only';
  if (
    (increasesAuthority || rearmsCompletedAuthority) &&
    parsed.output.confirm !== true
  ) {
    const message = existing
      ? rearmsCompletedAuthority
        ? `Rearming completed Autopilot in ${parsed.output.mode} mode requires explicit confirmation.`
        : `Increasing Autopilot from ${existing.autopilotMode} to ${parsed.output.mode} requires explicit confirmation.`
      : `Enabling Autopilot in ${parsed.output.mode} mode requires explicit confirmation.`;
    const confirmationRequired = {
      ok: false,
      action: 'autopilot_configure_pr',
      changed: false,
      message,
      requires: ['confirmAutopilotMode'],
      errors: [
        rearmsCompletedAuthority
          ? 'Set confirm=true only after the user explicitly confirms rearming this completed Autopilot watch.'
          : existing
            ? 'Set confirm=true only after the user explicitly confirms this autonomy increase.'
            : 'Set confirm=true only after the user explicitly confirms this autonomy level.',
      ],
    };
    return existing
      ? { ...confirmationRequired, watch: existing }
      : confirmationRequired;
  }

  const addWatchOptions: NonNullable<Parameters<typeof addPrWatch>[5]> = {
    expectedExisting: existing ? autopilotWatchFence(existing) : null,
  };
  if (existing?.autopilotStatus === 'complete') {
    addWatchOptions.rearmAutopilotMode = parsed.output.mode;
  }
  if (dependencies.upsertPollingTask) {
    addWatchOptions.upsertPollingTask = dependencies.upsertPollingTask;
  }

  const watchResult = await (dependencies.addWatch ?? addPrWatch)(
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
    addWatchOptions,
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
  const watchFence = watchFenceFromResult(watchResult);
  if (!watchFence) {
    return failure(
      'autopilot_configure_pr',
      `Watch "${watchId}" did not return the state fence required for safe Autopilot configuration.`,
    );
  }
  const configured = configureWatchAutopilot(
    paths,
    watchId,
    parsed.output.mode,
    { expected: watchFence },
  );
  if (!configured.matched) {
    return {
      ...failure(
        'autopilot_configure_pr',
        `Watch "${watchId}" changed while Autopilot was being configured. Review its current state and retry.`,
      ),
      requires: ['currentAutopilotState'],
    };
  }
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
  dependencies: {
    complete?: typeof completeAutopilotWatchIfTerminal;
  } = {},
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
    const stopOptions: StopAutopilotOptions = { explicitStop: true };
    if (parsed.output.confirmPreparedDiff === true) {
      stopOptions.confirmPreparedDiff = true;
    }
    const stopped = await (
      dependencies.complete ?? completeAutopilotWatchIfTerminal
    )(resolved.id, paths, stopOptions);
    if (stopped.reason === 'prepared-diff-confirmation-required') {
      return {
        ...failure(
          'autopilot_watch_stop',
          `Stopping watch "${resolved.id}" would delete its held unpushed prepared commit. Review the diff and confirm that discard explicitly before stopping.`,
        ),
        watch: stopped.watch,
        requires: ['confirmPreparedDiff'],
      };
    }
    if (stopped.reason === 'polling-disable-failed') {
      return {
        ...failure(
          'autopilot_watch_stop',
          `Watch "${resolved.id}" was not stopped because polling could not be disabled. No worktree cleanup was attempted; retry the stop after polling storage is available.`,
        ),
        watch: stopped.watch,
        requires: ['retryStop'],
      };
    }
    return stopped.complete
      ? {
          ok: true,
          action: 'autopilot_watch_stop',
          changed: true,
          message: stopped.cleanupRecovery
            ? `Stopped Autopilot watch "${resolved.id}". ${stopped.cleanupRecovery}`
            : `Stopped Autopilot watch "${resolved.id}".`,
          watch: stopped.watch,
          cleanup: stopped.cleanup,
          detachedWorktreeId: stopped.detachedWorktreeId,
          cleanupRecovery: stopped.cleanupRecovery,
        }
      : failure(
          'autopilot_watch_stop',
          `Watch "${resolved.id}" could not be stopped because its state changed.`,
        );
  }

  const current = await canonicalizePrWatchRepoId(paths, resolved.id);
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
  dispatchOwner: AutopilotOwnerDispatcher = dispatchAutopilotOwnerMessage,
) {
  const parsed = v.safeParse(prAutopilotOwnerMessageInputSchema, input);
  if (!parsed.success) return invalid('autopilot_owner_message', parsed.issues);
  return dispatchPrAutopilotOwnerTurn(
    parsed.output,
    paths,
    dispatchOwner,
    'autopilot_owner_message',
  );
}

export async function approvePrAutopilotChange(
  input: v.InferInput<typeof prAutopilotApprovalInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    dispatchOwner?: AutopilotOwnerDispatcher;
    readDiff?: typeof readRepoDiff;
    readWorktree?: typeof readManagedWorktree;
    status?: typeof gitStatus;
  } = {},
) {
  const parsed = v.safeParse(prAutopilotApprovalInputSchema, input);
  if (!parsed.success) {
    return invalid('autopilot_change_approve', parsed.issues);
  }
  const resolved = await resolveWatchId(
    parsed.output,
    paths,
    'autopilot_change_approve',
  );
  if (!resolved.ok) return resolved.result;
  const watch = readWatch(paths, resolved.id);
  if (
    !watch ||
    !watch.ownerInstanceId ||
    !watch.worktreeId ||
    watch.autopilotMode !== 'autofix-with-approval' ||
    watch.autopilotStatus !== 'waiting'
  ) {
    return failure(
      'autopilot_change_approve',
      `Watch "${resolved.id}" does not have a prepared approval-mode change waiting for review.`,
    );
  }
  try {
    const worktree = await (dependencies.readWorktree ?? readManagedWorktree)(
      watch.worktreeId,
      watch.repoId,
      paths,
    );
    const status = await (dependencies.status ?? gitStatus)(worktree.localPath);
    if (!status.clean) {
      return reviewRequired(
        'The managed worktree has uncommitted changes. Refresh and review the current diff before approving.',
      );
    }
    if (!worktree.headSha) {
      return reviewRequired(
        'The managed worktree has no stable base revision to review.',
      );
    }
    const diff = await (dependencies.readDiff ?? readRepoDiff)(
      {
        repoId: watch.repoId,
        worktreeId: watch.worktreeId,
        base: worktree.headSha,
        includePatch: false,
        expectedRevisionKey: parsed.output.expectedRevisionKey,
      },
      paths,
    );
    if (!diff.ok || !diff.files?.length) {
      return reviewRequired(
        diff.ok
          ? 'The managed worktree has no current changes to approve.'
          : 'The reviewed diff is stale or unavailable. Refresh it before approving.',
      );
    }
  } catch (error) {
    return reviewRequired(
      `The reviewed diff could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return dispatchPrAutopilotOwnerTurn(
    {
      id: resolved.id,
      message: `The human approved reviewed revision ${parsed.output.expectedRevisionKey}. Push only that exact held revision to the linked pull request branch.`,
    },
    paths,
    dependencies.dispatchOwner ?? dispatchAutopilotOwnerMessage,
    'autopilot_change_approve',
    parsed.output.expectedRevisionKey,
  );

  function reviewRequired(message: string) {
    return {
      ...failure('autopilot_change_approve', message),
      requires: ['currentReviewedDiff'],
    };
  }
}

async function dispatchPrAutopilotOwnerTurn(
  input: {
    id?: string;
    ref?: string;
    message: string;
  },
  paths: RuntimePaths,
  dispatchOwner: AutopilotOwnerDispatcher,
  action: 'autopilot_owner_message' | 'autopilot_change_approve',
  approvedRevisionKey?: string,
) {
  const resolved = await resolveWatchId(input, paths, action);
  if (!resolved.ok) return resolved.result;
  const watch = readWatch(paths, resolved.id);
  if (
    !watch ||
    !watch.ownerInstanceId ||
    watch.autopilotMode !== 'autofix-with-approval' ||
    watch.autopilotStatus !== 'waiting'
  ) {
    return failure(
      action,
      `Watch "${resolved.id}" is not an approval-mode owner waiting for a direct human message.`,
    );
  }
  const claimed = transitionWatchAutopilot(paths, watch.id, {
    from: 'waiting',
    to: 'working',
  });
  if (!claimed) {
    return failure(
      action,
      `Watch "${watch.id}" changed before the human turn could be claimed.`,
    );
  }
  let pendingTurn: ReturnType<typeof registerPendingAutopilotTurn>;
  try {
    pendingTurn = registerPendingAutopilotTurn(
      paths.home,
      watch.ownerInstanceId,
      undefined,
      watch.autopilotMode,
      'direct-human',
      approvedRevisionKey,
      { messageBody: input.message, watchId: watch.id },
    );
  } catch (error) {
    transitionWatchAutopilot(paths, watch.id, {
      from: 'working',
      to: 'waiting',
    });
    return failure(
      action,
      `The human owner turn could not be reserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const { buildPrAutopilotOwnerRuntime } =
      await import('../../agents/pr-autopilot-owner');
    await buildPrAutopilotOwnerRuntime(watch.ownerInstanceId, paths);
  } catch (error) {
    clearPendingAutopilotTurnIfMatches(
      paths.home,
      watch.ownerInstanceId,
      pendingTurn.turnId,
    );
    transitionWatchAutopilot(paths, watch.id, {
      from: 'working',
      to: 'blocked',
    });
    return failure(
      action,
      `The human owner turn could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let receipt;
  try {
    receipt = await dispatchOwner({
      agent: 'pr-autopilot-owner',
      id: watch.ownerInstanceId,
      input: input.message,
      idempotencyKey: pendingTurn.turnId,
    });
  } catch (error) {
    recordPendingAutopilotTurnError(
      paths.home,
      watch.ownerInstanceId,
      pendingTurn.turnId,
      error instanceof Error ? error.message : String(error),
    );
    return failure(
      action,
      `The human owner admission outcome is uncertain. Its durable reservation remains claimed and will retry with the same idempotency key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  recordPendingAutopilotTurnCorrelationId(
    paths.home,
    watch.ownerInstanceId,
    pendingTurn.turnId,
    receipt.submissionId,
  );
  if (dispatchOwner === dispatchAutopilotOwnerMessage) {
    void watchAutopilotOwnerSettlement(
      watch.ownerInstanceId,
      receipt.submissionId,
      paths,
      undefined,
      pendingTurn.turnId,
    );
  }
  return {
    ok: true,
    action,
    changed: true,
    message: `Sent the human instruction to continuing owner ${watch.ownerInstanceId}.`,
    watch: claimed,
    dispatchId: receipt.submissionId,
  };
}

export const configurePrAutopilotAction = defineTool({
  name: 'neondeck_autopilot_configure_pr',
  description:
    'Put one pull request on Autopilot with an explicit capability mode and an explicit choice to process or baseline current feedback. Enabling or increasing capability above notify-only requires confirm=true after explicit user confirmation.',
  input: configurePrAutopilotInputSchema,
  output: prAutopilotOutputSchema,
  async run({ data: input }) {
    return { output: await configurePrAutopilot(input) };
  },
});

export const prAutopilotStatusAction = defineTool({
  name: 'neondeck_autopilot_watch_status',
  description:
    'Read the minimal one-owner, one-worktree Autopilot state for one or all PR watches.',
  input: prAutopilotStatusInputSchema,
  output: prAutopilotOutputSchema,
  async run({ data: input }) {
    return { output: await readPrAutopilotStatus(input) };
  },
});

export const prAutopilotControlAction = defineTool({
  name: 'neondeck_autopilot_watch_control',
  description:
    'Pause, resume, retry, or stop one PR Autopilot watch using the same deterministic service as the API, CLI, and dashboard. Stop never deletes a held unpushed prepared commit unless confirmPreparedDiff=true is supplied after the user explicitly confirms that discard.',
  input: prAutopilotControlInputSchema,
  output: prAutopilotOutputSchema,
  async run({ data: input }) {
    return { output: await controlPrAutopilot(input) };
  },
});

export const prAutopilotOwnerMessageAction = defineTool({
  name: 'neondeck_autopilot_message_owner',
  description:
    'Send the user’s guidance to the same approval-mode PR owner while its managed worktree is held for review. This does not approve delivery; exact-revision approval happens only through the Active Watches approval control or typed approval API.',
  input: prAutopilotOwnerMessageInputSchema,
  output: prAutopilotOutputSchema,
  async run({ data: input }) {
    return { output: await messagePrAutopilotOwner(input) };
  },
});

export const neondeckPrAutopilotWatchActions = [
  configurePrAutopilotAction,
  prAutopilotStatusAction,
  prAutopilotControlAction,
  prAutopilotOwnerMessageAction,
];

function watchIdFromResult(result: Pick<WatchActionResult, 'watch'>) {
  return parsedAutopilotWatch(result.watch)?.id;
}

function watchFenceFromResult(result: Pick<WatchActionResult, 'watch'>) {
  const watch = parsedAutopilotWatch(result.watch);
  return watch ? autopilotWatchFence(watch) : undefined;
}

function parsedAutopilotWatch(watch: JsonValue | undefined) {
  const parsed = v.safeParse(autopilotWatchResultSchema, watch);
  return parsed.success ? parsed.output : undefined;
}

function autopilotWatchFence(
  watch: Pick<PrWatch, 'autopilotMode' | 'autopilotStatus' | 'updatedAt'>,
) {
  return {
    updatedAt: watch.updatedAt,
    autopilotMode: watch.autopilotMode,
    autopilotStatus: watch.autopilotStatus,
  };
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
