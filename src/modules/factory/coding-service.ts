import { withFactorySpan, codingCorrelation } from '../factory-observability';
import {
  codingAdmissionFingerprint,
  readCodingAttention,
  saveCodingAttention,
  clearCodingAttention,
} from './coding-attention';
import { realpathSync } from 'node:fs';
import { codingHandle } from './coding-handle';
export { codingHandle } from './coding-handle';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  codingRunRecordSchema,
  publicCodingRunSnapshot,
  type CodingRunRecord,
  type CodingRunCommand,
} from '../../../shared/coding-runs';
import { factoryCodingRunSchema } from '../../../shared/factory-coding';
import {
  getCodingRun,
  getActiveCodingRun,
  getCodingRunForRelease,
  reserveCodingRun,
  updateCodingRun,
} from '../coding-runs';
import * as localHost from '../coding-runs';
import {
  createWorktree,
  lockWorktree,
  releaseWorktreeLock,
} from '../worktrees';
import { readWorktreeRecord as requireWorktree } from '../worktrees';
import {
  ensurePreparedDiffForWorktree,
  readPreparedDiffByWorktree,
} from '../prepared-diffs';
import type { RuntimePaths } from '../../runtime-home';
import {
  assertCodingSnapshot,
  assertCodingAuthoritySnapshot,
  codingConfig,
  codingDigest,
  codingAuthority,
  codingPrompt,
  codingSnapshot,
  frozenCodingConfig,
  assertReleasedCodingConfig,
  assertPinnedCodingExecutable,
  CodingPreflightError,
} from './coding-context';
import {
  codingReadiness,
  localCodingConfig,
  selectedCodingAuth,
} from './coding-readiness';
import { factoryState, FactoryError } from './service';
import { gitAsync } from './repo-reader';
import { publishFactoryChange } from './events';
export type CodingHost = Pick<
  typeof localHost,
  | 'prepareLocalAttempt'
  | 'launchLocalAttempt'
  | 'inspectLocalAttempt'
  | 'reconcileLocalAttempt'
  | 'cancelLocalAttempt'
  | 'collectLocalAttempt'
>;
export const terminalCodingRun = (run: CodingRunRecord) =>
  ['candidate', 'failed', 'cancelled'].includes(run.status);
export function requireCodingRun(id: string, paths: RuntimePaths) {
  const run = getCodingRun(id, paths);
  if (!run) throw new FactoryError(404, 'Coding run not found.');
  return run;
}
/** Actual signed host execution time; delayed controller collection is never usage. */
export async function readCodingExecutionUsage(
  input: unknown,
  paths: RuntimePaths,
): Promise<number | null> {
  const run = v.parse(codingRunRecordSchema, input);
  if (!terminalCodingRun(run) || !run.deadProof) return null;
  if (run.deadProof.kind === 'never-started' && !run.host) return 0;
  return localHost.localAttemptExecutionDuration(codingHandle(run, paths));
}
export function changeCodingRun(
  run: CodingRunRecord,
  action: CodingRunCommand['action'],
  paths: RuntimePaths,
) {
  const next = updateCodingRun(
    {
      runId: run.runId,
      attemptId: run.attemptId,
      ownershipToken: run.ownershipToken,
      expectedVersion: run.version,
      action,
    },
    paths,
  );
  publishFactoryChange();
  return next;
}
export function publicCodingRun(input: CodingRunRecord, paths: RuntimePaths) {
  const run = v.parse(codingRunRecordSchema, input);
  const {
    ownershipToken: _token,
    host: _host,
    deadProof: _proof,
    workspace: _workspace,
    ...safeRecord
  } = run;
  const record = {
    ...safeRecord,
    snapshot: publicCodingRunSnapshot(run.snapshot),
    workspace: run.workspace ? { worktreeId: run.workspace.worktreeId } : null,
  };
  const prepared = run.workspace
    ? readPreparedDiffByWorktree(run.workspace.worktreeId, paths)
    : null;
  return v.parse(factoryCodingRunSchema, {
    record,
    displayStatus:
      run.cancelRequestedAt &&
      !terminalCodingRun(run) &&
      run.status !== 'needs-reconcile'
        ? 'cancelling'
        : run.status === 'candidate'
          ? 'candidate-awaiting-review'
          : run.status,
    diff: prepared
      ? { worktreeId: prepared.worktreeId, preparedDiffId: prepared.id }
      : null,
  });
}
async function quarantine(id: string, paths: RuntimePaths) {
  const run = requireCodingRun(id, paths);
  if (terminalCodingRun(run)) return run;
  return changeCodingRun(
    run,
    {
      type: 'quarantine',
      reason:
        'Execution boundary is uncertain. Retained ownership; reconcile required.',
    },
    paths,
  );
}
// One synchronous compare-and-swap claim precedes every external resource. Replays
// observe the claim and may reconcile; they never create or launch another job.
export async function dispatchCodingWork(
  workId: string,
  paths: RuntimePaths,
  host: CodingHost = localHost,
  readiness = codingReadiness,
) {
  const fingerprint = codingAdmissionFingerprint(workId, paths);
  if (readCodingAttention(workId, paths)?.inputFingerprint === fingerprint)
    return null;
  try {
    assertReleasedCodingConfig(workId, paths);
  } catch (error) {
    saveCodingAttention(
      workId,
      fingerprint,
      error instanceof CodingPreflightError
        ? error.message
        : 'Coding release authority is unavailable.',
      paths,
    );
    return null;
  }
  const existing = getCodingRunForRelease(
    codingAuthority(workId, paths).release.id,
    paths,
  );
  if (existing) return launchReservedCodingRun(existing, paths, host);
  const ready = await readiness(paths);
  if (!ready.ready || !ready.installedVersion) return null;
  let snapshot: Awaited<ReturnType<typeof codingSnapshot>>;
  try {
    snapshot = await codingSnapshot(workId, ready.installedVersion, paths);
    await assertCodingSnapshot(snapshot, paths);
    // Reservation is admission: recheck current reviewed settings after every
    // asynchronous preflight, before the synchronous durable reservation.
    const authority = assertCodingAuthoritySnapshot(snapshot, paths);
    assertReleasedCodingConfig(workId, paths);
    if (
      codingDigest(authority.coding) !==
      codingDigest(codingConfig(paths).coding)
    )
      throw new CodingPreflightError(
        'Coding settings changed during admission preflight. Review the current settings before release.',
      );
  } catch (error) {
    saveCodingAttention(
      workId,
      fingerprint,
      error instanceof CodingPreflightError
        ? error.message
        : 'Coding admission context changed or could not be verified. Review the local repository and refresh/release the brief.',
      paths,
    );
    return null;
  }
  clearCodingAttention(workId, paths);
  // Keep reservation conflicts outside the preflight catch: an occupied writer
  // is an admission conflict, not stale context. Concurrent admissions reuse the
  // durable snapshot and the ordinary launch/recovery guards without refetching.
  const reserved =
    getCodingRunForRelease(snapshot.releaseId, paths) ??
    reserveCodingRun(snapshot, paths);
  return launchReservedCodingRun(reserved, paths, host);
}

/** Shared resource lifecycle; callers must reserve authority atomically first. */
export async function launchReservedCodingRun(
  input: CodingRunRecord,
  paths: RuntimePaths,
  host: CodingHost = localHost,
  options: {
    prepareWorkspace?: (root: string) => Promise<void>;
    assertAuthority?: () => Promise<void>;
    prompt?: string;
    wallTimeMs?: number;
  } = {},
) {
  let run = v.parse(codingRunRecordSchema, input);
  const snapshot = run.snapshot;
  const workId = snapshot.workItemId;
  if (
    run.host ||
    terminalCodingRun(run) ||
    run.status !== 'reserved' ||
    run.cancelRequestedAt
  )
    return run;
  run = changeCodingRun(
    run,
    {
      type: 'bind-host',
      host: {
        hostId: 'local-cli',
        jobId: join(realpathSync(paths.home), 'coding-attempts', run.attemptId),
      },
    },
    paths,
  );
  try {
    await assertCodingSnapshot(snapshot, paths);
    const coding = frozenCodingConfig(snapshot);
    const expectedExecutableIdentity =
      await assertPinnedCodingExecutable(snapshot);
    const selectedAuth = selectedCodingAuth(coding);
    const branch = `agent/factory-${run.attemptId}`;
    const created = await createWorktree(
      {
        repoId: snapshot.repoId,
        headSha: snapshot.baseSha,
        baseRef: snapshot.baseSha,
        headRef: branch,
        storage: 'home',
        workflowRunId: run.runId,
        createdBy: 'neondeck',
        directPushAllowed: false,
      },
      paths,
      run,
    );
    if (!created.ok || !('worktree' in created) || !created.changed)
      throw new Error('Dedicated worktree creation failed.');
    const worktree = created.worktree;
    const locked = await lockWorktree(
      {
        worktreeId: worktree.id,
        owner: `factory:${run.runId}`,
        workflowRunId: run.runId,
        ttlSeconds: 86400,
      },
      paths,
      run,
    );
    if (!locked.ok || !('lock' in locked))
      throw new Error('Workspace lock failed.');
    run = changeCodingRun(
      requireCodingRun(run.runId, paths),
      {
        type: 'bind-workspace',
        workspace: { worktreeId: worktree.id, lockId: locked.lock.id },
      },
      paths,
    );
    await gitAsync(
      worktree.localPath,
      ['checkout', '-b', branch, snapshot.baseSha],
      AbortSignal.timeout(5000),
    );
    await options.prepareWorkspace?.(worktree.localPath);
    const { repo } = codingAuthority(workId, paths);
    const handle = codingHandle(run, paths);
    await mkdir(join(paths.home, 'coding-attempts'), {
      recursive: true,
      mode: 0o700,
    });
    const config = localCodingConfig(coding, snapshot.harness.version);
    if (options.wallTimeMs !== undefined)
      config.wallTimeMs = Math.min(
        config.wallTimeMs,
        v.parse(
          v.pipe(v.number(), v.integer(), v.minValue(1)),
          options.wallTimeMs,
        ),
      );
    await withFactorySpan(
      paths,
      'coding.prepare',
      codingCorrelation(run),
      async () =>
        host.prepareLocalAttempt({
          ...handle,
          attemptId: run.attemptId,
          ownedWorktree: {
            id: worktree.id,
            repoId: worktree.repoId,
            root: await realpath(worktree.localPath),
            storageRoot: await realpath(paths.worktrees),
            sourceRoot: await realpath(repo.path),
            branch,
            baseSha: snapshot.baseSha,
          },
          config,
          expectedExecutableIdentity,
          prompt: options.prompt ?? codingPrompt(snapshot),
          selectedAuth,
        }),
    );
    await assertCodingSnapshot(snapshot, paths);
    await options.assertAuthority?.();
    if (
      JSON.stringify(selectedCodingAuth(coding)) !==
      JSON.stringify(selectedAuth)
    )
      throw new Error('Selected credential changed before launch.');
    const current = requireCodingRun(run.runId, paths);
    if (
      current.version !== run.version ||
      current.cancelRequestedAt ||
      current.status !== 'reserved'
    )
      throw new Error('Launch authority changed.');
    run = changeCodingRun(current, { type: 'running' }, paths);
    await withFactorySpan(paths, 'coding.launch', codingCorrelation(run), () =>
      host.launchLocalAttempt(handle),
    );
    return await reconcileCodingRun(run.runId, paths, host);
  } catch {
    const current = requireCodingRun(run.runId, paths);
    if (!terminalCodingRun(current)) {
      const cancelled = current.cancelRequestedAt
        ? current
        : changeCodingRun(
            current,
            {
              type: 'cancel',
              reason:
                'Preparation or launch was fenced; reconcile retained resources.',
            },
            paths,
          );
      await host
        .cancelLocalAttempt(codingHandle(cancelled, paths))
        .catch(() => undefined);
    }
    return quarantine(run.runId, paths);
  }
}
export async function reconcileCodingRun(
  id: string,
  paths: RuntimePaths,
  host: CodingHost = localHost,
) {
  let run = requireCodingRun(id, paths);
  if (terminalCodingRun(run)) return run;
  try {
    try {
      await assertCodingSnapshot(run.snapshot, paths);
    } catch {
      run = requireCodingRun(id, paths);
      if (!run.cancelRequestedAt)
        run = changeCodingRun(
          run,
          {
            type: 'cancel',
            reason:
              'Release, configuration, source, repository or frozen context changed.',
          },
          paths,
        );
    }
    run = requireCodingRun(id, paths);
    if (!run.host) return quarantine(id, paths);
    const handle = codingHandle(run, paths);
    if (run.cancelRequestedAt)
      await withFactorySpan(
        paths,
        'coding.cancel',
        codingCorrelation(run),
        () => host.cancelLocalAttempt(handle),
      );
    let state = await withFactorySpan(
      paths,
      'coding.inspect',
      codingCorrelation(run),
      () => host.inspectLocalAttempt(handle),
    );
    if (state.state === 'needs-reconcile')
      state = await withFactorySpan(
        paths,
        'coding.reconcile',
        codingCorrelation(run),
        () => host.reconcileLocalAttempt(handle),
      );
    if (state.state === 'needs-reconcile') return quarantine(id, paths);
    run = requireCodingRun(id, paths);
    if (state.receipt.sessionId && !run.providerSessionId)
      run = changeCodingRun(
        run,
        { type: 'bind-session', providerSessionId: state.receipt.sessionId },
        paths,
      );
    if (state.state !== 'finished' || !state.receipt.noWriter) return run;
    if (run.status === 'running')
      run = changeCodingRun(run, { type: 'collecting' }, paths);
    const evidence = await withFactorySpan(
      paths,
      'coding.collect',
      codingCorrelation(run),
      () => host.collectLocalAttempt(handle),
    );
    if (!evidence.receipt.noWriter)
      throw new Error('Writer death is unconfirmed.');
    run = requireCodingRun(id, paths);
    if (!run.workspace) throw new Error('Workspace association missing.');
    await ensurePreparedDiffForWorktree(
      requireWorktree(run.workspace.worktreeId, paths),
      paths,
      {
        createdBy: 'factory',
        title: `Factory candidate: ${run.snapshot.workItemId}`,
      },
    );
    // Recheck at the final state boundary; invalidation wins over a success receipt.
    try {
      await assertCodingSnapshot(run.snapshot, paths);
    } catch {
      run = requireCodingRun(id, paths);
      if (!run.cancelRequestedAt)
        run = changeCodingRun(
          run,
          {
            type: 'cancel',
            reason: 'Authority changed before evidence acceptance.',
          },
          paths,
        );
    }
    run = requireCodingRun(id, paths);
    const workspace = run.workspace;
    if (!workspace) throw new Error('Workspace association missing.');
    const candidate =
      !run.cancelRequestedAt &&
      evidence.receipt.terminal === 'completed' &&
      evidence.receipt.exitCode === 0 &&
      evidence.receipt.reason === null &&
      ['removed', 'absent'].includes(evidence.receipt.authCleanup) &&
      !!run.providerSessionId;
    const proof = {
      runId: run.runId,
      attemptId: run.attemptId,
      ownershipToken: run.ownershipToken,
      host: run.host,
      kind: 'verified-dead' as const,
      evidenceRef: join(handle.directory, 'candidate.json'),
    };
    const result = changeCodingRun(
      run,
      {
        type: 'finish',
        status: run.cancelRequestedAt
          ? 'cancelled'
          : candidate
            ? 'candidate'
            : 'failed',
        proof,
        ...(candidate
          ? {
              candidate: {
                baseSha: evidence.baseSha,
                headSha: evidence.headSha,
                worktreeId: workspace.worktreeId,
                statusRef: evidence.statusRef,
                diffRef: evidence.diffRef,
                includesUntracked: true as const,
              },
            }
          : {}),
        reason: candidate
          ? 'Candidate awaiting human review. No acceptance or publishing performed.'
          : run.cancelRequestedAt
            ? 'Cancelled; evidence and workspace retained.'
            : `Execution failed (${safeHostFailure(evidence.receipt.reason, evidence.receipt.authCleanup)}); evidence and workspace retained.`,
      },
      paths,
    );
    await releaseWorktreeLock(
      {
        lockId: workspace.lockId,
        owner: `factory:${run.runId}`,
        finalStatus: 'prepared-diff',
      },
      paths,
      run,
    );
    return result;
  } catch {
    return quarantine(id, paths);
  }
}
export async function tickFactoryCoding(
  paths: RuntimePaths,
  host: CodingHost = localHost,
) {
  const active = getActiveCodingRun(paths);
  if (active) await reconcileCodingRun(active.runId, paths, host);
  if (getActiveCodingRun(paths)) return;
  for (const work of factoryState(paths).items.filter(
    (w) => w.lifecycle === 'queued',
  )) {
    try {
      const { release } = codingAuthority(work.id, paths);
      if (!getCodingRunForRelease(release.id, paths))
        await dispatchCodingWork(work.id, paths, host);
      if (getActiveCodingRun(paths)) return;
    } catch {
      /* Disabled/ineligible/busy stays queued; never automatic retry of an attempt. */
    }
  }
}

function safeHostFailure(reason: string | null, authCleanup: string) {
  const known = new Set([
    'cancelled',
    'provider-spawn-failed',
    'wall-time-limit',
    'supervisor-ownership-or-io-uncertain',
    'host-preflight-failed',
    'provider-exit-failed',
    'provider-terminal-missing-or-failed',
    'credential-cleanup-failed',
    'line-limit',
    'malformed-provider-output',
    'output-limit',
    'truncated-provider-output',
    'supervisor-lost',
    'output-io-failed',
  ]);
  if (reason && known.has(reason)) return reason;
  return !['removed', 'absent'].includes(authCleanup)
    ? 'credential-cleanup-incomplete'
    : 'invalid-completion-evidence';
}
