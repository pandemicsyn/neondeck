import { readRepoRegistrySnapshot } from '../repos';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import {
  deleteScheduledTask,
  listScheduledTasks,
  readScheduledTask,
  setScheduledTaskEnabled,
} from '../scheduled-tasks';
import type {
  CheckFetcher,
  PrWatchInitialEventBaselineFetcher,
  PrWatch,
  RefWatch,
  ResolvedPrReference,
  ResolvedRefReference,
  WatchActionResult,
  WatchFetcher,
} from './schemas';
import type * as v from 'valibot';
import {
  watchPrAddInputSchema,
  watchPrPollingInputSchema,
  watchPrRefreshInputSchema,
  watchPrRemoveInputSchema,
  watchRefAddInputSchema,
  watchRefRefreshInputSchema,
} from './schemas';
import {
  defaultCheckFetcher,
  defaultPrWatchInitialEventBaselineFetcher,
  defaultWatchFetcher,
  fetchWatchDetail,
  meaningfulPrSnapshot,
  refStatusFromChecks,
  meaningfulRefSnapshot,
  resolveRefWatchId,
  resolveWatchId,
  snapshotFromDetail,
  snapshotFromRef,
  statusFromSnapshot,
} from './polling';
import {
  deleteWatch,
  insertRefWatch,
  insertWatch,
  readRefWatch,
  readRefWatches,
  readWatch,
  readWatches,
  updateRefWatch,
  updateWatch,
  markWatchInitialEventProcessed,
  upsertWatchPollingTask,
  watchPollingTaskId,
} from './store';
import { resolvePrReference, resolveRefReference } from './references';
import { failResult, okResult, parseActionInput } from './utils';

export async function addPrWatch(
  input: v.InferInput<typeof watchPrAddInputSchema>,
  paths = runtimePaths(),
  fetcher: WatchFetcher = defaultWatchFetcher,
  checkFetcher: CheckFetcher = defaultCheckFetcher,
  initialEventBaselineFetcher?: PrWatchInitialEventBaselineFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(watchPrAddInputSchema, input, 'watch_pr_add');
  if (!parsed.ok) return parsed.result;
  const baselineFetcher =
    initialEventBaselineFetcher ?? defaultPrWatchInitialEventBaselineFetcher;

  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(
    parsed.input.ref,
    registry,
    parsed.input.desiredTerminalState,
  );
  if (!resolved.ok) return resolved.result;

  const existing = readWatch(paths, resolved.reference.id);
  if (existing) {
    const task = await readScheduledTask(
      watchPollingTaskId(existing.id),
      paths,
    );
    const desiredTerminalStateChanged =
      existing.desiredTerminalState !== resolved.reference.desiredTerminalState;
    const processExistingChanged =
      parsed.input.processExisting !== undefined &&
      existing.processExisting !== parsed.input.processExisting;
    const terminalWatch = isTerminalPrWatchStatus(existing.status);
    const intervalChanged =
      parsed.input.intervalSeconds !== undefined &&
      (task?.trigger.kind !== 'interval' ||
        task.trigger.everySeconds !== parsed.input.intervalSeconds);
    const missingPollingTask = !task;
    if (
      !desiredTerminalStateChanged &&
      !intervalChanged &&
      !missingPollingTask &&
      !processExistingChanged &&
      !terminalWatch
    ) {
      return okResult(
        'watch_pr_add',
        false,
        'silent',
        `Watch "${existing.id}" already exists. ${initialFeedbackChoiceMessage(existing)}`,
        {
          watch: existing,
        },
      );
    }

    const baseline =
      processExistingChanged && parsed.input.processExisting === false
        ? await fetchInitialEventBaseline(resolved.reference, baselineFetcher)
        : undefined;
    if (baseline && !baseline.ok) return baseline.result;

    let watch: PrWatch = desiredTerminalStateChanged
      ? {
          ...existing,
          desiredTerminalState: resolved.reference.desiredTerminalState,
          status: existing.lastSnapshot
            ? statusFromSnapshot(
                existing.lastSnapshot,
                resolved.reference.desiredTerminalState,
              )
            : existing.status,
          lastOutcome: 'updated',
          updatedAt: new Date().toISOString(),
        }
      : existing;
    if (processExistingChanged) {
      watch = {
        ...watch,
        processExisting: parsed.input.processExisting ?? false,
        initialEventProcessedAt:
          parsed.input.processExisting === false
            ? new Date().toISOString()
            : null,
        lastOutcome: 'updated',
        updatedAt: new Date().toISOString(),
      };
    }

    if (terminalWatch) {
      const detail = await fetchWatchDetail(
        'watch_pr_add',
        resolved.reference,
        fetcher,
      );
      if (!detail.ok) return detail.result;

      const now = new Date().toISOString();
      const snapshot = await snapshotFromDetail(
        detail.detail,
        resolved.reference,
        checkFetcher,
      );
      watch = {
        ...watch,
        status: statusFromSnapshot(
          snapshot,
          resolved.reference.desiredTerminalState,
        ),
        prState: snapshot.state,
        title: snapshot.title,
        url: snapshot.url,
        mergeCommitSha: snapshot.mergeCommitSha,
        lastSnapshot: snapshot,
        lastOutcome: 'updated',
        lastCheckedAt: now,
        updatedAt: now,
      };
      updateWatch(paths, watch, baseline?.watermarks);
    } else if (desiredTerminalStateChanged || processExistingChanged) {
      updateWatch(paths, watch, baseline?.watermarks);
    }
    await upsertWatchPollingTask(
      watch,
      paths,
      parsed.input.intervalSeconds ??
        (task?.trigger.kind === 'interval'
          ? task.trigger.everySeconds
          : undefined),
    );

    return okResult(
      'watch_pr_add',
      true,
      'updated',
      `Updated watch "${watch.id}". ${initialFeedbackChoiceMessage(watch)}`,
      {
        watch,
      },
    );
  }

  const detail = await fetchWatchDetail(
    'watch_pr_add',
    resolved.reference,
    fetcher,
  );
  if (!detail.ok) return detail.result;

  const processExisting = parsed.input.processExisting ?? false;
  const baseline = processExisting
    ? undefined
    : await fetchInitialEventBaseline(resolved.reference, baselineFetcher);
  if (baseline && !baseline.ok) return baseline.result;

  const now = new Date().toISOString();
  const snapshot = await snapshotFromDetail(
    detail.detail,
    resolved.reference,
    checkFetcher,
  );
  const watch: PrWatch = {
    id: resolved.reference.id,
    repoId: resolved.reference.repoId,
    repoFullName: resolved.reference.repoFullName,
    githubOwner: resolved.reference.githubOwner,
    githubName: resolved.reference.githubName,
    prNumber: resolved.reference.prNumber,
    desiredTerminalState: resolved.reference.desiredTerminalState,
    status: statusFromSnapshot(
      snapshot,
      resolved.reference.desiredTerminalState,
    ),
    prState: snapshot.state,
    title: snapshot.title,
    url: snapshot.url,
    mergeCommitSha: snapshot.mergeCommitSha,
    lastSnapshot: snapshot,
    lastOutcome: 'created',
    lastCheckedAt: now,
    createdBy: parsed.input.createdBy ?? null,
    processExisting,
    initialEventProcessedAt: processExisting ? null : now,
    createdAt: now,
    updatedAt: now,
  };

  insertWatch(paths, watch, baseline?.watermarks);
  await upsertWatchPollingTask(watch, paths, parsed.input.intervalSeconds);

  return okResult(
    'watch_pr_add',
    true,
    'created',
    `Watching ${watch.id}. ${initialFeedbackChoiceMessage(watch)}`,
    { watch },
  );
}

function initialFeedbackChoiceMessage(watch: PrWatch) {
  if (!watch.processExisting) {
    return 'Current feedback was baselined; only later changes will run.';
  }
  return watch.initialEventProcessedAt
    ? 'Current actionable feedback was selected for processing and its initial state has already been handled.'
    : 'Current actionable feedback will be processed before later changes.';
}

async function fetchInitialEventBaseline(
  reference: ResolvedPrReference,
  fetcher: PrWatchInitialEventBaselineFetcher,
): Promise<
  | { ok: true; watermarks: Awaited<ReturnType<typeof fetcher>> }
  | { ok: false; result: WatchActionResult }
> {
  try {
    const watermarks = await fetcher(reference, reference.id);
    const validationError = initialEventBaselineValidationError(watermarks);
    if (validationError) {
      return {
        ok: false,
        result: failResult(
          'watch_pr_add',
          'Could not capture a complete initial PR event baseline before enabling the watch.',
          {
            requires: ['completePrEventFacts'],
            errors: [validationError],
          },
        ),
      };
    }
    return {
      ok: true,
      watermarks,
    };
  } catch (error) {
    return {
      ok: false,
      result: failResult(
        'watch_pr_add',
        'Could not capture the initial PR event baseline before enabling the watch.',
        {
          requires: ['completePrEventFacts'],
          errors: [error instanceof Error ? error.message : String(error)],
        },
      ),
    };
  }
}

const requiredInitialEventBaselineCategories = [
  'commits',
  'review_threads',
  'requested_changes_reviews',
  'conversation_comments',
  'check_suites',
  'check_runs',
  'mergeability',
  'out_of_date_branch',
] as const;

function initialEventBaselineValidationError(
  watermarks: Awaited<ReturnType<PrWatchInitialEventBaselineFetcher>>,
) {
  const byCategory = new Map(
    watermarks.map((watermark) => [watermark.category, watermark]),
  );
  const missing = requiredInitialEventBaselineCategories.filter(
    (category) => !byCategory.has(category),
  );
  if (missing.length > 0) {
    return `Initial PR event baseline is missing categories: ${missing.join(', ')}.`;
  }
  const truncated = requiredInitialEventBaselineCategories.filter(
    (category) => {
      const value = byCategory.get(category)?.value;
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        value.truncated === true
      );
    },
  );
  if (truncated.length > 0) {
    return `Initial PR event baseline is truncated for categories: ${truncated.join(', ')}.`;
  }
  return null;
}

export { markWatchInitialEventProcessed };

export async function listPrWatches(
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const tasks = new Map(
    (await listScheduledTasks(paths)).map((task) => [task.id, task]),
  );
  return okResult('watch_pr_list', false, undefined, 'Listed PR watches.', {
    watches: readWatches(paths).map((watch) => {
      const task = tasks.get(watchPollingTaskId(watch.id));
      return {
        ...watch,
        nextRunAt: task?.nextRunAt ?? null,
        pollingEnabled: task?.enabled ?? false,
        pollIntervalSeconds:
          task?.trigger.kind === 'interval' ? task.trigger.everySeconds : null,
      };
    }),
  });
}

export async function listPrWatchRecords(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  return readWatches(paths);
}

function isTerminalPrWatchStatus(status: PrWatch['status']) {
  return status === 'closed' || status === 'merged' || status === 'green';
}

export async function addRefWatch(
  input: v.InferInput<typeof watchRefAddInputSchema>,
  paths = runtimePaths(),
  checkFetcher: CheckFetcher = defaultCheckFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    watchRefAddInputSchema,
    input,
    'watch_ref_add',
  );
  if (!parsed.ok) return parsed.result;

  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolveRefReference(parsed.input, registry);
  if (!resolved.ok) return resolved.result;

  const existing = readRefWatch(paths, resolved.reference.id);
  if (existing) {
    return failResult(
      'watch_ref_add',
      `Ref watch "${existing.id}" already exists.`,
    );
  }

  const snapshot = await snapshotFromRef(
    resolved.reference,
    checkFetcher,
    'watch_ref_add',
  );
  if (!snapshot.ok) return snapshot.result;

  const now = new Date().toISOString();
  const watch: RefWatch = {
    id: resolved.reference.id,
    repoId: resolved.reference.repoId,
    repoFullName: resolved.reference.repoFullName,
    githubOwner: resolved.reference.githubOwner,
    githubName: resolved.reference.githubName,
    ref: resolved.reference.ref,
    status: refStatusFromChecks(snapshot.snapshot.checks),
    title: `${resolved.reference.repoFullName}@${resolved.reference.ref}`,
    url: snapshot.snapshot.url,
    lastSnapshot: snapshot.snapshot,
    lastOutcome: 'created',
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  insertRefWatch(paths, watch);
  return okResult('watch_ref_add', true, 'created', `Watching ${watch.id}.`, {
    watch,
  });
}

export async function listRefWatches(
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  return okResult('watch_ref_list', false, undefined, 'Listed ref watches.', {
    watches: readRefWatches(paths),
  });
}

export async function listRefWatchRecords(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  return readRefWatches(paths);
}

export async function refreshRefWatch(
  input: v.InferInput<typeof watchRefRefreshInputSchema>,
  paths = runtimePaths(),
  checkFetcher: CheckFetcher = defaultCheckFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    watchRefRefreshInputSchema,
    input,
    'watch_ref_refresh',
  );
  if (!parsed.ok) return parsed.result;

  const idResult = await resolveRefWatchId(
    parsed.input,
    paths,
    'watch_ref_refresh',
  );
  if (!idResult.ok) return idResult.result;

  const watch = readRefWatch(paths, idResult.id);
  if (!watch) {
    return failResult(
      'watch_ref_refresh',
      `Ref watch "${idResult.id}" does not exist.`,
    );
  }

  const reference: ResolvedRefReference = {
    id: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    githubOwner: watch.githubOwner,
    githubName: watch.githubName,
    ref: watch.ref,
  };
  const snapshot = await snapshotFromRef(
    reference,
    checkFetcher,
    'watch_ref_refresh',
  );
  if (!snapshot.ok) return snapshot.result;

  const nextStatus = refStatusFromChecks(snapshot.snapshot.checks);
  const changed =
    meaningfulRefSnapshot(watch.lastSnapshot) !==
      meaningfulRefSnapshot(snapshot.snapshot) || watch.status !== nextStatus;
  const now = new Date().toISOString();
  const nextWatch: RefWatch = {
    ...watch,
    status: nextStatus,
    url: snapshot.snapshot.url,
    lastSnapshot: snapshot.snapshot,
    lastOutcome: changed ? 'updated' : 'silent',
    lastCheckedAt: now,
    updatedAt: now,
  };

  updateRefWatch(paths, nextWatch);

  return okResult(
    'watch_ref_refresh',
    changed,
    changed ? 'updated' : 'silent',
    changed
      ? `Updated ref watch "${watch.id}".`
      : `No change for ref watch "${watch.id}".`,
    { watch: nextWatch },
  );
}

export async function removePrWatch(
  input: v.InferInput<typeof watchPrRemoveInputSchema>,
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    watchPrRemoveInputSchema,
    input,
    'watch_pr_remove',
  );
  if (!parsed.ok) return parsed.result;
  if (parsed.input.confirm !== true) {
    return failResult(
      'watch_pr_remove',
      'Removing a PR watch requires confirmation.',
      {
        requires: ['confirm'],
      },
    );
  }

  const idResult = await resolveWatchId(parsed.input, paths, 'watch_pr_remove');
  if (!idResult.ok) return idResult.result;

  const watch = readWatch(paths, idResult.id);
  if (!watch) {
    return failResult(
      'watch_pr_remove',
      `Watch "${idResult.id}" does not exist.`,
    );
  }

  deleteWatch(paths, idResult.id);
  await deleteScheduledTask(watchPollingTaskId(idResult.id), paths);
  return okResult(
    'watch_pr_remove',
    true,
    'removed',
    `Removed watch "${idResult.id}".`,
    {
      watch,
    },
  );
}

export async function setPrWatchPolling(
  input: v.InferInput<typeof watchPrPollingInputSchema>,
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const action = input.enabled ? 'watch_pr_resume' : 'watch_pr_pause';
  const parsed = parseActionInput(watchPrPollingInputSchema, input, action);
  if (!parsed.ok) return parsed.result;

  const idResult = await resolveWatchId(parsed.input, paths, action);
  if (!idResult.ok) return idResult.result;

  const watch = readWatch(paths, idResult.id);
  if (!watch) {
    return failResult(action, `Watch "${idResult.id}" does not exist.`);
  }

  const task = await setScheduledTaskEnabled(
    watchPollingTaskId(idResult.id),
    parsed.input.enabled,
    paths,
  );
  if (!task) {
    return failResult(
      action,
      `Polling task for watch "${idResult.id}" does not exist.`,
    );
  }

  return okResult(
    action,
    true,
    'updated',
    parsed.input.enabled
      ? `Resumed polling for "${idResult.id}".`
      : `Paused polling for "${idResult.id}".`,
    {
      watch: {
        ...watch,
        nextRunAt: task.nextRunAt,
        pollingEnabled: task.enabled,
        pollIntervalSeconds:
          task.trigger.kind === 'interval' ? task.trigger.everySeconds : null,
      },
    },
  );
}

export async function refreshPrWatch(
  input: v.InferInput<typeof watchPrRefreshInputSchema>,
  paths = runtimePaths(),
  fetcher: WatchFetcher = defaultWatchFetcher,
  checkFetcher: CheckFetcher = defaultCheckFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    watchPrRefreshInputSchema,
    input,
    'watch_pr_refresh',
  );
  if (!parsed.ok) return parsed.result;

  const idResult = await resolveWatchId(
    parsed.input,
    paths,
    'watch_pr_refresh',
  );
  if (!idResult.ok) return idResult.result;

  const watch = readWatch(paths, idResult.id);
  if (!watch) {
    return failResult(
      'watch_pr_refresh',
      `Watch "${idResult.id}" does not exist.`,
    );
  }

  const reference: ResolvedPrReference = {
    id: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    githubOwner: watch.githubOwner,
    githubName: watch.githubName,
    prNumber: watch.prNumber,
    desiredTerminalState: watch.desiredTerminalState,
  };
  const detail = await fetchWatchDetail('watch_pr_refresh', reference, fetcher);
  if (!detail.ok) return detail.result;

  const snapshot = await snapshotFromDetail(
    detail.detail,
    reference,
    checkFetcher,
  );
  const nextStatus = statusFromSnapshot(snapshot, watch.desiredTerminalState);
  const changed =
    meaningfulPrSnapshot(watch.lastSnapshot) !==
      meaningfulPrSnapshot(snapshot) || watch.status !== nextStatus;
  const now = new Date().toISOString();
  const nextWatch: PrWatch = {
    ...watch,
    status: nextStatus,
    prState: snapshot.state,
    title: snapshot.title,
    url: snapshot.url,
    mergeCommitSha: snapshot.mergeCommitSha,
    lastSnapshot: snapshot,
    lastOutcome: changed ? 'updated' : 'silent',
    lastCheckedAt: now,
    updatedAt: now,
  };

  updateWatch(paths, nextWatch);

  return okResult(
    'watch_pr_refresh',
    changed,
    changed ? 'updated' : 'silent',
    changed
      ? `Updated watch "${watch.id}".`
      : `No change for watch "${watch.id}".`,
    { watch: nextWatch },
  );
}
