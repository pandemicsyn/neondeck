import { deleteJob, deleteJobsByConfigField } from '../../app-state';
import { readRepoRegistrySnapshot } from '../../repos';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import type {
  CheckFetcher,
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
  watchPrRefreshInputSchema,
  watchPrRemoveInputSchema,
  watchRefAddInputSchema,
  watchRefRefreshInputSchema,
} from './schemas';
import {
  defaultCheckFetcher,
  defaultWatchFetcher,
  fetchWatchDetail,
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
  upsertRefWatchPollingJob,
  upsertReleasePollingJob,
  upsertWatchPollingJob,
  watchPollingJobId,
} from './store';
import {
  resolvePrReference,
  resolveRefReference,
} from './references';
import { failResult, okResult, parseActionInput } from './utils';

export async function addPrWatch(
  input: v.InferInput<typeof watchPrAddInputSchema>,
  paths = runtimePaths(),
  fetcher: WatchFetcher = defaultWatchFetcher,
  checkFetcher: CheckFetcher = defaultCheckFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(watchPrAddInputSchema, input, 'watch_pr_add');
  if (!parsed.ok) return parsed.result;

  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(
    parsed.input.ref,
    registry,
    parsed.input.desiredTerminalState,
  );
  if (!resolved.ok) return resolved.result;

  const existing = readWatch(paths, resolved.reference.id);
  if (existing) {
    return failResult('watch_pr_add', `Watch "${existing.id}" already exists.`);
  }

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
    createdAt: now,
    updatedAt: now,
  };

  insertWatch(paths, watch);
  await upsertWatchPollingJob(watch, paths, parsed.input.intervalSeconds);
  if (watch.desiredTerminalState === 'prod') {
    await upsertReleasePollingJob(watch, paths);
  }

  return okResult('watch_pr_add', true, 'created', `Watching ${watch.id}.`, {
    watch,
  });
}

export async function listPrWatches(
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  return okResult('watch_pr_list', false, undefined, 'Listed PR watches.', {
    watches: readWatches(paths),
  });
}

export async function listPrWatchRecords(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  return readWatches(paths);
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
  await upsertRefWatchPollingJob(watch, paths, parsed.input.intervalSeconds);

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
  await deleteJob(watchPollingJobId(idResult.id), paths);
  await deleteJobsByConfigField('sourceWatchId', idResult.id, paths);
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
    JSON.stringify(watch.lastSnapshot) !== JSON.stringify(snapshot) ||
    watch.status !== nextStatus;
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
