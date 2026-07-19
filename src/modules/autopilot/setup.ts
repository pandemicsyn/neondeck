import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { updateRepoAutopilotWatchOverride } from '../config';
import {
  addPrWatch,
  listPrWatches,
  removePrWatch,
  setPrWatchPolling,
} from '../watches';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { parseAppConfig, readRuntimeJson } from '../../runtime-home';
import { readRepoRegistrySnapshot } from '../repos';
import { resolvePrReference } from '../watches';
import { ensureAutopilotPrOwner } from './owners';
import { listAutopilotAdmissions } from './admissions';
import { advanceAutopilotAdmission } from './coordination/advance';
import { stopAutopilotAdmission } from './coordination/stop';
import { readAutopilotReadiness } from './readiness';
import {
  modeSchema,
  repoAutopilotPolicyForWatch,
  type AutopilotMode,
} from '../autopilot-policy';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const autopilotSetupInputSchema = v.strictObject({
  ref: nonEmptyStringSchema,
  mode: modeSchema,
  processExisting: v.optional(v.boolean()),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  reason: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
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
  readAutopilotReadiness?: typeof readAutopilotReadiness;
};

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

  // Ask for authority before creating the watch so an unconfirmed setup has no
  // partial durable state to clean up.
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
      `Repository "${resolved.reference.repoId}" is not configured.`,
    );
  const appConfig = await readRuntimeJson(paths.config, parseAppConfig);
  const currentMode = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: resolved.reference.id,
    prNumber: resolved.reference.prNumber,
  }).mode;
  if (
    modeRank(parsed.output.mode) > modeRank(currentMode) &&
    parsed.output.confirm !== true
  ) {
    return {
      ok: false,
      action: 'autopilot_watch_configure',
      changed: false,
      message:
        "Increasing this watch's Autopilot authority requires explicit confirmation.",
      requires: ['confirm'],
    };
  }

  const watchResult = await (dependencies.addPrWatch ?? addPrWatch)(
    {
      ref: parsed.output.ref,
      processExisting: parsed.output.processExisting,
      intervalSeconds: parsed.output.intervalSeconds,
      createdBy: 'autopilot-setup',
    },
    paths,
  );
  if (
    !watchResult.ok ||
    !watchResult.watch ||
    typeof watchResult.watch !== 'object'
  ) {
    return { ...watchResult, action: 'autopilot_watch_configure' };
  }
  const watch = watchResult.watch as {
    id: string;
    repoId: string;
    prNumber: number;
    processExisting: boolean;
    initialEventProcessedAt: string | null;
  };
  const override = await updateRepoAutopilotWatchOverride(
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
  if (!override.ok)
    return { ...override, action: 'autopilot_watch_configure', watch };

  const owner = await ensureAutopilotPrOwner(
    { watchId: watch.id, repoId: watch.repoId, prNumber: watch.prNumber },
    paths,
  );
  if (owner.status !== 'awaiting-event' && owner.status !== 'active') {
    return { ok: false, action: 'autopilot_watch_configure', changed: watchResult.changed || override.changed, message: `Autopilot owner ${owner.id} is ${owner.status}; restore or rotate it before configuring this watch again.`, requires: ['ownerRecovery'], watch };
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

  return {
    ok: true,
    action: 'autopilot_watch_configure',
    changed: watchResult.changed || override.changed,
    message: `Autopilot is configured for ${watch.id} in ${parsed.output.mode} mode. ${processExistingSummary(watch)}`,
    watch,
    mode: parsed.output.mode,
    processExisting: watch.processExisting,
    firstPlannedAction: watch.processExisting ? 'Process current actionable feedback on the next poll.' : 'Baseline current feedback and wait for a later meaningful change.',
    confirmation: { required: modeRank(parsed.output.mode) > modeRank(currentMode), accepted: parsed.output.confirm === true },
    owner: {
      id: owner.id,
      status: owner.status,
      flueInstanceId: owner.flueInstanceId,
      worktreeId: owner.worktreeId,
    },
    readiness,
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
    const watches = await listPrWatches(paths);
    const visible = watchId
      ? (watches.watches ?? []).filter(
          (watch) =>
            watch &&
            typeof watch === 'object' &&
            'id' in watch &&
            watch.id === watchId,
        )
      : watches.watches;
    return {
      ...watches,
      action: `autopilot_watch_${operation}`,
      watches: visible,
      message:
        operation === 'status' && watchId
          ? `Read Autopilot status for watch "${watchId}".`
          : watches.message,
    };
  }
  if (!watchId)
    return {
      ...invalid(`autopilot_watch_${operation}`, 'A watchId is required.'),
      requires: ['watchId'],
    };
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
  return {
    ...removed,
    action: 'autopilot_watch_stop',
    message: removed.ok
      ? `Stopped ${stopped.length} Autopilot admission(s) and removed watch "${watchId}".`
      : removed.message,
    stopped,
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
