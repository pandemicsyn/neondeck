import { randomUUID } from 'node:crypto';
import type { RuntimePaths } from '../../runtime-home';
import {
  type FactoryWorker,
  type FactoryWorkerHealth,
} from '../../../shared/factory-observability';
import { readWorker, saveWorker } from './store';
import {
  bestEffort,
  withFactorySpan,
  diagnosticsDegraded,
  markDiagnosticsDegraded,
} from './spans';
import { classifyFactoryError } from './errors';
const processInstance = randomUUID();
// Distinguishes a live local loop from persisted evidence from a previous process.
const active = new Map<string, string>();
const key = (paths: RuntimePaths, worker: FactoryWorker) =>
  `${paths.neondeckDatabase}:${worker}`;
const empty = (worker: FactoryWorker): FactoryWorkerHealth => ({
  worker,
  status: 'not-running',
  ownerPid: null,
  lastHeartbeatAt: null,
  instanceId: null,
  startedAt: null,
  lastTickAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  nextTickAt: null,
  consecutiveFailures: 0,
  totalFailures: 0,
  staleAfterMs: 60000,
  lastError: null,
  diagnosticsDegraded: false,
});
export function getFactoryWorkerHealth(
  paths: RuntimePaths,
): FactoryWorkerHealth[] {
  return (['github', 'coding', 'delivery'] as const).map((worker) => {
    const row = readWorker(paths, worker) ?? empty(worker);
    if (row.status === 'stopped' || row.status === 'not-running') return row;
    let alive = row.ownerPid !== null;
    if (row.ownerPid) {
      try {
        process.kill(row.ownerPid, 0);
      } catch (error) {
        alive = !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ESRCH'
        );
      }
    }
    if (!alive) return { ...row, status: 'not-running', nextTickAt: null };
    const expected = row.lastHeartbeatAt ?? row.lastTickAt ?? row.startedAt;
    if (expected && Date.now() - Date.parse(expected) > row.staleAfterMs)
      return { ...row, status: 'stale' };
    if (
      row.status === 'waiting' &&
      row.nextTickAt &&
      Date.now() - Date.parse(row.nextTickAt) > row.staleAfterMs
    )
      return { ...row, status: 'stale' };
    return row;
  });
}
export function startFactoryWorker(
  paths: RuntimePaths,
  worker: FactoryWorker,
  intervalMs: number,
) {
  let previous: FactoryWorkerHealth | null = null;
  if (
    !bestEffort(() => {
      previous = readWorker(paths, worker);
    })
  )
    markDiagnosticsDegraded(paths);
  const instanceId = `${processInstance}:${randomUUID()}`;
  let row: FactoryWorkerHealth = {
    ...(previous ?? empty(worker)),
    worker,
    instanceId,
    ownerPid: process.pid,
    lastHeartbeatAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    status: 'waiting',
    nextTickAt: null,
    staleAfterMs: Math.max(60000, intervalMs * 3),
  };
  active.set(key(paths, worker), instanceId);
  const save = () => {
    if (active.get(key(paths, worker)) !== instanceId) return;
    row = {
      ...row,
      diagnosticsDegraded:
        row.diagnosticsDegraded || diagnosticsDegraded(paths),
    };
    if (!bestEffort(() => saveWorker(paths, row))) {
      row = { ...row, diagnosticsDegraded: true };
      markDiagnosticsDegraded(paths);
    }
  };
  save();
  const heartbeat = setInterval(() => {
    row = { ...row, lastHeartbeatAt: new Date().toISOString() };
    save();
  }, 15000);
  heartbeat.unref();
  let failed = false;
  return {
    async tick(run: () => Promise<void>) {
      failed = false;
      row = {
        ...row,
        status: 'running',
        lastTickAt: new Date().toISOString(),
        nextTickAt: null,
      };
      save();
      try {
        await withFactorySpan(paths, `${worker}.tick`, {}, run, 'phase');
        if (!failed)
          row = {
            ...row,
            lastSuccessAt: new Date().toISOString(),
            consecutiveFailures: 0,
            lastError: null,
          };
      } catch (error) {
        this.failure(error);
      } finally {
        save();
      }
    },
    failure(error: unknown) {
      if (!failed)
        row = {
          ...row,
          consecutiveFailures: row.consecutiveFailures + 1,
          totalFailures: row.totalFailures + 1,
        };
      failed = true;
      row = {
        ...row,
        lastFailureAt: new Date().toISOString(),
        lastError: classifyFactoryError(error),
      };
      save();
    },
    scheduled() {
      row = {
        ...row,
        status: 'waiting',
        nextTickAt: new Date(Date.now() + intervalMs).toISOString(),
      };
      save();
    },
    stopped() {
      clearInterval(heartbeat);
      row = { ...row, status: 'stopped', nextTickAt: null };
      save();
      if (active.get(key(paths, worker)) === instanceId)
        active.delete(key(paths, worker));
    },
  };
}
