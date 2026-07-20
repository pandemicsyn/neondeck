import { defineAction, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { updateRepoAutopilotWatchOverride } from '../config';
import {
  addPrWatch,
  listPrWatches,
  removePrWatch,
  refreshPrWatch,
  setPrWatchPolling,
} from '../watches/service';
import { resolveWatchId } from '../watches/polling';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { readRepoRegistrySnapshot } from '../repos';
import { resolvePrReference } from '../watches/references';
import {
  ensureAutopilotPrOwner,
  listAutopilotPrOwners,
  retireAutopilotPrOwnerBinding,
} from './owners';
import { listAutopilotAdmissions } from './admissions';
import { advanceAutopilotAdmission } from './coordination/advance';
import { stopAutopilotAdmission } from './coordination/stop';
import { readAutopilotReadiness } from './readiness';
import {
  beginAutopilotSetupTransaction,
  completeAutopilotSetupTransaction,
  failAutopilotSetupTransaction,
  isAutopilotSetupBlocked,
  readAutopilotSetupTransaction,
  withAutopilotSetupWatchLease,
} from './setup-transactions';
import {
  modeSchema,
  readRepoAutopilotConfig,
  type AutopilotMode,
} from '../autopilot-policy';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const autopilotConfirmationIntentSchema = v.strictObject({
  watchId: nonEmptyStringSchema,
  currentMode: modeSchema,
  mode: modeSchema,
  processExisting: v.boolean(),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  reason: v.optional(nonEmptyStringSchema),
});
export const autopilotSetupInputSchema = v.strictObject({
  ref: nonEmptyStringSchema,
  mode: modeSchema,
  processExisting: v.optional(v.boolean(), true),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  reason: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
  confirmation: v.optional(autopilotConfirmationIntentSchema),
});

export const autopilotControlInputSchema = v.strictObject({
  operation: v.picklist(['list', 'status', 'pause', 'resume', 'stop', 'retry']),
  watchId: v.optional(nonEmptyStringSchema),
  admissionId: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});

const autopilotSetupOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export type AutopilotSetupDependencies = {
  addPrWatch?: typeof addPrWatch;
  updateRepoAutopilotWatchOverride?: typeof updateRepoAutopilotWatchOverride;
  ensureAutopilotPrOwner?: typeof ensureAutopilotPrOwner;
  readAutopilotReadiness?: typeof readAutopilotReadiness;
};

export async function listAutopilotWatchBindings(
  paths: RuntimePaths = runtimePaths(),
) {
  const [watchResult, owners, registry] = await Promise.all([
    listPrWatches(paths),
    listAutopilotPrOwners(paths),
    readRepoRegistrySnapshot(paths),
  ]);
  const watches = (watchResult.watches ?? []).filter(
    (watch): watch is Record<string, JsonValue> =>
      Boolean(watch) && typeof watch === 'object',
  );
  const bindings = await Promise.all(
    watches.map(async (watch) => {
      const watchId = typeof watch.id === 'string' ? watch.id : null;
      const repoId = typeof watch.repoId === 'string' ? watch.repoId : null;
      const prNumber =
        typeof watch.prNumber === 'number' ? watch.prNumber : null;
      if (!watchId || !repoId || !prNumber) return undefined;
      const owner = owners.find(
        (candidate) =>
          candidate.watchId === watchId &&
          candidate.repoId === repoId &&
          candidate.prNumber === prNumber &&
          (candidate.status === 'awaiting-event' ||
            candidate.status === 'active'),
      );
      const repo = registry.repos.find((candidate) => candidate.id === repoId);
      const override = repo && readWatchOverride(repo, watchId, prNumber);
      if (
        !owner ||
        !override ||
        (await isAutopilotSetupBlocked(watchId, paths))
      ) {
        return undefined;
      }
      return { watch, owner, override };
    }),
  );
  return bindings.filter((binding): binding is NonNullable<typeof binding> =>
    Boolean(binding),
  );
}

async function readAutopilotWatchBinding(watchId: string, paths: RuntimePaths) {
  return (await listAutopilotWatchBindings(paths)).find(
    (binding) => binding.owner.watchId === watchId,
  );
}

function readWatchOverride(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  watchId: string,
  prNumber: number,
) {
  const overrides = readRepoAutopilotConfig(repo)?.watchOverrides;
  if (!overrides) return undefined;
  return overrides.find(
    (override) =>
      override.watchId === watchId && override.prNumber === prNumber,
  );
}

/**
 * The one setup contract used by chat, HTTP, CLI, and dashboard.  It binds an
 * awaiting-event owner now; Package 4 remains the sole allocator of the Flue
 * instance and managed worktree when an actionable event is admitted.
 */
export async function configureAutopilotWatch(
  input: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotSetupDependencies = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(autopilotSetupInputSchema, input);
  if (!parsed.success)
    return invalid('autopilot_watch_configure', v.summarize(parsed.issues));

  // Resolve before taking the lease so malformed references fail promptly. The
  // authority baseline itself is deliberately resolved *inside* the lease:
  // only an existing durable owner+override binding can authorize a lower
  // confirmation threshold for this exact watch setup.
  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(parsed.output.ref, registry);
  if (!resolved.ok)
    return { ...resolved.result, action: 'autopilot_watch_configure' };
  return withAutopilotSetupWatchLease(resolved.reference.id, paths, () =>
    configureAutopilotWatchLocked(
      parsed.output,
      paths,
      dependencies,
      resolved.reference,
    ),
  );
}

async function configureAutopilotWatchLocked(
  input: v.InferOutput<typeof autopilotSetupInputSchema>,
  paths: RuntimePaths,
  dependencies: AutopilotSetupDependencies,
  reference: { id: string },
) {
  const parsed = { output: input };
  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(parsed.output.ref, registry);
  if (!resolved.ok)
    return { ...resolved.result, action: 'autopilot_watch_configure' };
  const repo = registry.repos.find(
    (candidate) => candidate.id === resolved.reference.repoId,
  );
  if (!repo)
    return invalid(
      'autopilot_watch_configure',
      'Repository is not configured.',
    );
  // Do not inherit a repo/global policy as though it were already an
  // Autopilot grant. Confirmation is scoped to the exact durable binding that
  // this operation will update, so an unbound ordinary watch always starts at
  // notify-only regardless of broader defaults.
  const currentMode =
    (await readAutopilotWatchBinding(reference.id, paths))?.override.mode ??
    'notify-only';
  const confirmation = setupConfirmationIntent(
    reference.id,
    currentMode,
    parsed.output,
  );
  if (
    modeRank(parsed.output.mode) > modeRank(currentMode) &&
    !hasAcceptedSetupConfirmation(parsed.output, confirmation)
  ) {
    return {
      ok: false,
      action: 'autopilot_watch_configure',
      changed: false,
      message:
        "Increasing this watch's Autopilot authority requires explicit confirmation.",
      requires: ['confirm'],
      confirmation: { required: true, accepted: false, intent: confirmation },
    };
  }

  const previousSetup = await readAutopilotSetupTransaction(
    reference.id,
    paths,
  );
  await beginAutopilotSetupTransaction(reference.id, paths);
  let watchResult: Awaited<ReturnType<typeof addPrWatch>>;
  try {
    watchResult = await (dependencies.addPrWatch ?? addPrWatch)(
      {
        ref: parsed.output.ref,
        processExisting: parsed.output.processExisting,
        intervalSeconds: parsed.output.intervalSeconds,
        createdBy: 'autopilot-setup',
      },
      paths,
    );
  } catch (error) {
    return setupFailure(reference.id, error, paths);
  }
  if (
    !watchResult.ok ||
    !watchResult.watch ||
    typeof watchResult.watch !== 'object'
  ) {
    if (previousSetup) {
      await failAutopilotSetupTransaction(
        reference.id,
        previousSetup.message ?? watchResult.message,
        paths,
      );
    } else {
      await completeAutopilotSetupTransaction(reference.id, paths);
    }
    return { ...watchResult, action: 'autopilot_watch_configure' };
  }
  const watch = watchResult.watch as {
    id: string;
    repoId: string;
    prNumber: number;
    processExisting: boolean;
    initialEventProcessedAt: string | null;
  };
  let override: Awaited<ReturnType<typeof updateRepoAutopilotWatchOverride>>;
  try {
    override = await (
      dependencies.updateRepoAutopilotWatchOverride ??
      updateRepoAutopilotWatchOverride
    )(
      {
        repoId: watch.repoId,
        watchId: watch.id,
        prNumber: watch.prNumber,
        mode: parsed.output.mode,
        reason: parsed.output.reason,
        confirm: parsed.output.confirm,
      },
      paths,
    );
  } catch (error) {
    return setupFailure(watch.id, error, paths, watch);
  }
  if (!override.ok)
    return setupFailure(watch.id, override.message, paths, watch);

  let owner: Awaited<ReturnType<typeof ensureAutopilotPrOwner>>;
  try {
    owner = await (
      dependencies.ensureAutopilotPrOwner ?? ensureAutopilotPrOwner
    )(
      { watchId: watch.id, repoId: watch.repoId, prNumber: watch.prNumber },
      paths,
    );
  } catch (error) {
    return setupFailure(watch.id, error, paths, watch);
  }
  if (owner.status !== 'awaiting-event' && owner.status !== 'active') {
    return setupFailure(
      watch.id,
      `Autopilot owner ${owner.id} is ${owner.status}; restore or rotate it before configuring this watch again.`,
      paths,
      watch,
      ['ownerRecovery'],
    );
  }
  const readiness = await (
    dependencies.readAutopilotReadiness ?? readAutopilotReadiness
  )(
    {
      repoId: watch.repoId,
      prNumber: watch.prNumber,
      mode: parsed.output.mode,
    },
    paths,
  ).catch((error) => ({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    requires: ['autopilot-readiness'],
  }));

  await completeAutopilotSetupTransaction(watch.id, paths);

  return {
    ok: true,
    action: 'autopilot_watch_configure',
    changed: watchResult.changed || override.changed,
    message: `Autopilot is configured for ${watch.id} in ${parsed.output.mode} mode. ${processExistingSummary(watch)}`,
    watch,
    mode: parsed.output.mode,
    processExisting: watch.processExisting,
    firstPlannedAction: watch.processExisting
      ? 'Process current actionable feedback on the next poll.'
      : 'Baseline current feedback and wait for a later meaningful change.',
    confirmation: {
      required: modeRank(parsed.output.mode) > modeRank(currentMode),
      accepted: hasAcceptedSetupConfirmation(parsed.output, confirmation),
      ...(modeRank(parsed.output.mode) > modeRank(currentMode)
        ? { intent: confirmation }
        : {}),
    },
    owner: {
      id: owner.id,
      status: owner.status,
      flueInstanceId: owner.flueInstanceId,
      worktreeId: owner.worktreeId,
    },
    readiness,
  };
}

function setupConfirmationIntent(
  watchId: string,
  currentMode: AutopilotMode,
  input: v.InferOutput<typeof autopilotSetupInputSchema>,
) {
  return {
    watchId,
    currentMode,
    mode: input.mode,
    processExisting: input.processExisting,
    ...(input.intervalSeconds !== undefined
      ? { intervalSeconds: input.intervalSeconds }
      : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

function hasAcceptedSetupConfirmation(
  input: v.InferOutput<typeof autopilotSetupInputSchema>,
  expected: ReturnType<typeof setupConfirmationIntent>,
) {
  return (
    input.confirm === true &&
    JSON.stringify(input.confirmation) === JSON.stringify(expected)
  );
}

async function setupFailure(
  watchId: string,
  error: unknown,
  paths: RuntimePaths,
  watch?: unknown,
  requires = ['retrySetup'],
) {
  const message = error instanceof Error ? error.message : String(error);
  await failAutopilotSetupTransaction(watchId, message, paths);
  return {
    ok: false,
    action: 'autopilot_watch_configure',
    changed: false,
    message: `Autopilot setup did not complete. The watch is fail-closed until this setup is retried: ${message}`,
    requires,
    ...(watch ? { watch } : {}),
  };
}

/** Every operator entry point reaches the same service rather than a route-specific mutation. */
export async function controlAutopilotWatch(
  input: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(autopilotControlInputSchema, input);
  if (!parsed.success)
    return invalid('autopilot_watch_control', v.summarize(parsed.issues));
  const { operation, watchId } = parsed.output;
  if (operation === 'list' || operation === 'status') {
    const bindings = await listAutopilotWatchBindings(paths);
    const visible = watchId
      ? bindings.filter((binding) => binding.owner.watchId === watchId)
      : bindings;
    if (watchId && visible.length === 0) {
      return {
        ...invalid(
          `autopilot_watch_${operation}`,
          `Watch "${watchId}" is not configured for Autopilot.`,
        ),
        requires: ['autopilotWatch'],
      };
    }
    return {
      action: `autopilot_watch_${operation}`,
      ok: true,
      changed: false,
      watches: visible.map((binding) => ({
        ...(binding.watch as Record<string, JsonValue>),
        autopilot: { owner: binding.owner, mode: binding.override.mode },
      })),
      message:
        operation === 'status' && watchId
          ? `Read Autopilot status for watch "${watchId}".`
          : 'Listed Autopilot watches.',
    };
  }
  if (!watchId)
    return {
      ...invalid(`autopilot_watch_${operation}`, 'A watchId is required.'),
      requires: ['watchId'],
    };
  return withAutopilotSetupWatchLease(watchId, paths, () =>
    controlAutopilotWatchWithSetupLease(input, paths),
  );
}

/**
 * Internal route helper for a generic-watch mutation that already holds the
 * same per-watch setup lease. Keeping the implementation here ensures both
 * routes and dedicated Autopilot surfaces share validation and fail-closed
 * semantics without recursively acquiring a non-reentrant filesystem lease.
 */
export async function controlAutopilotWatchWithSetupLease(
  input: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(autopilotControlInputSchema, input);
  if (!parsed.success)
    return invalid('autopilot_watch_control', v.summarize(parsed.issues));
  const { operation, watchId } = parsed.output;
  if (operation === 'list' || operation === 'status') {
    return invalid(
      `autopilot_watch_${operation}`,
      'Read-only Autopilot controls do not acquire a setup lease.',
    );
  }
  if (!watchId)
    return {
      ...invalid(`autopilot_watch_${operation}`, 'A watchId is required.'),
      requires: ['watchId'],
    };
  if (await isAutopilotSetupBlocked(watchId, paths)) {
    return {
      ...invalid(
        `autopilot_watch_${operation}`,
        `Watch "${watchId}" is blocked until its Autopilot setup recovers.`,
      ),
      requires: ['retrySetup'],
    };
  }
  const binding = await readAutopilotWatchBinding(watchId, paths);
  if (!binding) {
    return {
      ...invalid(
        `autopilot_watch_${operation}`,
        `Watch "${watchId}" is not configured for Autopilot.`,
      ),
      requires: ['autopilotWatch'],
    };
  }
  if (operation === 'pause' || operation === 'resume') {
    const result = await setPrWatchPolling(
      { id: watchId, enabled: operation === 'resume' },
      paths,
    );
    return { ...result, action: `autopilot_watch_${operation}` };
  }
  const admissions = (await listAutopilotAdmissions(paths)).filter(
    (admission) => admission.watchId === watchId,
  );
  if (operation === 'retry') {
    const retryAdmissions = parsed.output.admissionId
      ? admissions.filter(
          (admission) => admission.id === parsed.output.admissionId,
        )
      : admissions;
    if (parsed.output.admissionId && retryAdmissions.length === 0) {
      return {
        ...invalid(
          'autopilot_watch_retry',
          `Admission "${parsed.output.admissionId}" does not belong to watch "${watchId}".`,
        ),
        requires: ['admissionId'],
      };
    }
    const retries = await Promise.all(
      retryAdmissions.map((admission) =>
        advanceAutopilotAdmission({ admissionId: admission.id }, paths),
      ),
    );
    return {
      ok: true,
      action: 'autopilot_watch_retry',
      changed: retries.some((result) => result.status === 'reserved'),
      message: retries.length
        ? `Requested retry for ${retries.length} Autopilot admission(s).`
        : `No admissions exist for watch "${watchId}".`,
      retries,
    };
  }
  if (parsed.output.confirm !== true) {
    return {
      ...invalid(
        'autopilot_watch_stop',
        'Stopping a watch and its active Autopilot work requires confirmation.',
      ),
      requires: ['confirm'],
    };
  }
  const stopped = await Promise.all(
    admissions.map((admission) =>
      stopAutopilotAdmission(
        { admissionId: admission.id, reason: 'operator-stopped-watch' },
        paths,
      ),
    ),
  );
  const removed = await removePrWatch({ id: watchId, confirm: true }, paths);
  if (removed.ok) await retireAutopilotPrOwnerBinding(watchId, paths);
  return {
    ...removed,
    action: 'autopilot_watch_stop',
    message: removed.ok
      ? `Stopped ${stopped.length} Autopilot admission(s) and removed watch "${watchId}".`
      : removed.message,
    stopped,
  };
}

/** Generic watch actions use this guard so they cannot bypass an active Autopilot binding. */
export async function removePrWatchWithAutopilotLease(
  input: { id?: string; ref?: string; confirm?: boolean },
  paths: RuntimePaths = runtimePaths(),
) {
  return withAutopilotSafeWatchMutation(
    input,
    'watch_pr_remove',
    'stop',
    paths,
    () => removePrWatch(input, paths),
  );
}

/** Generic add/update surfaces may create ordinary watches, never rewrite an Autopilot binding. */
export async function addPrWatchWithAutopilotLease(
  input: Parameters<typeof addPrWatch>[0],
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(
    input.ref,
    registry,
    input.desiredTerminalState,
  );
  if (!resolved.ok) return addPrWatch(input, paths);
  return withAutopilotSetupWatchLease(
    resolved.reference.id,
    paths,
    async () => {
      if (await isAutopilotSetupBlocked(resolved.reference.id, paths))
        return blockedGenericWatchResult('watch_pr_add', resolved.reference.id);
      if (await readAutopilotWatchBinding(resolved.reference.id, paths)) {
        return {
          ok: false,
          action: 'watch_pr_add',
          changed: false,
          message:
            'This watch is configured for Autopilot. Change it through the Autopilot setup contract.',
          requires: ['autopilotWatchSetup'],
        };
      }
      return addPrWatch(input, paths);
    },
  );
}

/** Generic watch actions use this guard so setup recovery cannot be bypassed. */
export async function setPrWatchPollingWithAutopilotLease(
  input: { id?: string; ref?: string; enabled: boolean },
  paths: RuntimePaths = runtimePaths(),
) {
  return withAutopilotSafeWatchMutation(
    input,
    input.enabled ? 'watch_pr_resume' : 'watch_pr_pause',
    input.enabled ? 'resume' : 'pause',
    paths,
    () => setPrWatchPolling(input, paths),
  );
}

/** Refresh has no Autopilot side effect, but is serialized and fail-closed with setup. */
export async function refreshPrWatchWithAutopilotLease(
  input: { id?: string; ref?: string },
  paths: RuntimePaths = runtimePaths(),
) {
  const idResult = await resolveWatchId(input, paths, 'watch_pr_refresh');
  if (!idResult.ok) return idResult.result;
  return withAutopilotSetupWatchLease(idResult.id, paths, async () => {
    if (await isAutopilotSetupBlocked(idResult.id, paths))
      return blockedGenericWatchResult('watch_pr_refresh', idResult.id);
    return refreshPrWatch(input, paths);
  });
}

async function withAutopilotSafeWatchMutation(
  input: { id?: string; ref?: string; confirm?: boolean },
  action: string,
  operation: 'pause' | 'resume' | 'stop',
  paths: RuntimePaths,
  ordinaryMutation: () => ReturnType<typeof removePrWatch>,
) {
  const idResult = await resolveWatchId(input, paths, action);
  if (!idResult.ok) return idResult.result;
  return withAutopilotSetupWatchLease(idResult.id, paths, async () => {
    if (await isAutopilotSetupBlocked(idResult.id, paths))
      return blockedGenericWatchResult(action, idResult.id);
    const binding = await readAutopilotWatchBinding(idResult.id, paths);
    if (binding) {
      return controlAutopilotWatchWithSetupLease(
        {
          operation,
          watchId: idResult.id,
          ...(operation === 'stop' ? { confirm: input.confirm === true } : {}),
        },
        paths,
      );
    }
    return ordinaryMutation();
  });
}

function blockedGenericWatchResult(action: string, watchId: string) {
  return {
    ok: false,
    action,
    changed: false,
    message: `Watch "${watchId}" is blocked until Autopilot setup recovers.`,
    requires: ['retrySetup'],
  };
}

function processExistingSummary(watch: {
  processExisting: boolean;
  initialEventProcessedAt: string | null;
}) {
  return watch.processExisting
    ? watch.initialEventProcessedAt
      ? 'Existing feedback has already been processed.'
      : 'Existing feedback is queued for the next watch poll.'
    : 'Existing feedback was baselined; only later changes will run.';
}

function invalid(action: string, error: string) {
  return {
    ok: false,
    action,
    changed: false,
    message: 'Invalid Autopilot setup input.',
    errors: [error],
  };
}

function modeRank(mode: AutopilotMode) {
  return [
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ].indexOf(mode);
}

export const configureAutopilotWatchAction = defineAction({
  name: 'neondeck_autopilot_watch_configure',
  description:
    'Configure one PR for Autopilot in a requested mode, optionally process existing feedback, and return owner/readiness facts. Confirmation is required only when the selected mode increases this watch’s authority.',
  input: autopilotSetupInputSchema,
  output: autopilotSetupOutputSchema,
  async run({ input }) {
    return configureAutopilotWatch(input);
  },
});

export const controlAutopilotWatchAction = defineAction({
  name: 'neondeck_autopilot_watch_control',
  description:
    'List, inspect, pause, resume, stop, or retry a configured Autopilot PR watch through the shared control service.',
  input: autopilotControlInputSchema,
  output: autopilotSetupOutputSchema,
  async run({ input }) {
    return controlAutopilotWatch(input);
  },
});
