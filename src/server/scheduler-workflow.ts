import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  getRun,
  invoke,
  listRuns,
  type RunRecord,
  type WorkflowInvocationReceipt,
} from '@flue/runtime';
import schedulerTickWorkflow from '../workflows/scheduler-tick';
import { addNotification } from '../modules/app-state';
import type { SchedulerResult } from '../modules/scheduler/schemas';
import { runSchedulerTick } from '../modules/scheduler/service';
import {
  isSqliteBusy,
  readMetadataValue,
  rollbackQuietly,
} from '../modules/scheduler/lease';
import { ensureRuntimeHome, type RuntimePaths } from '../runtime-home';

const schedulerWorkflowName = 'scheduler-tick';
const schedulerWorkflowAdmissionLeaseKey =
  'scheduler.tick.workflow.admission.lease';
const defaultWorkflowWaitTimeoutMs = 5 * 60 * 1000;
const defaultWorkflowAdmissionLeaseTtlMs =
  defaultWorkflowWaitTimeoutMs + 60_000;
const defaultWorkflowPollMs = 250;

type ObservedSchedulerTickResult = SchedulerResult & { runId?: string };
type SchedulerWorkflowAdmissionLease = {
  owner: string;
  runtimeHome: string;
  acquiredAt: string;
  expiresAt: string;
  runId: string | null;
};
type SchedulerWorkflowAdmissionLeaseResult =
  | { acquired: true; lease: SchedulerWorkflowAdmissionLease }
  | { acquired: false; lease: SchedulerWorkflowAdmissionLease | null };

type SchedulerWorkflowDependencies = {
  getRun?: typeof getRun;
  invokeWorkflow?: (paths: RuntimePaths) => Promise<WorkflowInvocationReceipt>;
  listRuns?: typeof listRuns;
  now?: () => Date;
  pollMs?: number;
  sleep?: typeof sleep;
  admissionLeaseTtlMs?: number;
  activeRunTtlMs?: number;
  waitTimeoutMs?: number;
};

const schedulerTickInFlight = new Map<
  string,
  Promise<ObservedSchedulerTickResult>
>();

export async function runObservedSchedulerTick(
  paths: RuntimePaths,
  dependencies: SchedulerWorkflowDependencies = {},
): Promise<ObservedSchedulerTickResult> {
  const key = paths.home;
  const inFlight = schedulerTickInFlight.get(key);
  if (inFlight) return inFlight;
  const next = runObservedSchedulerTickOnce(paths, dependencies).finally(() => {
    schedulerTickInFlight.delete(key);
  });
  schedulerTickInFlight.set(key, next);
  return next;
}

async function runObservedSchedulerTickOnce(
  paths: RuntimePaths,
  dependencies: SchedulerWorkflowDependencies,
): Promise<ObservedSchedulerTickResult> {
  await ensureRuntimeHome(paths);

  const now = currentDate(dependencies);
  let activeRun: RunRecord | null;
  try {
    activeRun = await activeSchedulerTickRun(paths, dependencies, now);
  } catch (error) {
    return runDirectSchedulerTickFallback(paths, error, 'inspection');
  }
  if (activeRun) {
    return resultFromObservedRun(paths, activeRun.runId, dependencies);
  }

  const admission = acquireSchedulerWorkflowAdmissionLease(
    paths,
    now,
    schedulerWorkflowAdmissionLeaseTtlMs(dependencies),
  );
  if (!admission.acquired) {
    if (admission.lease?.runId) {
      return resultFromObservedRun(paths, admission.lease.runId, dependencies);
    }

    return {
      ok: true,
      action: 'scheduler_tick',
      changed: false,
      outcome: 'silent',
      message:
        'Scheduler tick skipped because another process is admitting the observed scheduler workflow.',
      extra: { admissionLease: admission.lease ? 'active' : 'busy' },
    };
  }

  try {
    let receipt: WorkflowInvocationReceipt;
    try {
      receipt = await invokeSchedulerTickWorkflow(paths, dependencies);
    } catch (error) {
      return runDirectSchedulerTickFallback(paths, error, 'admission');
    }
    recordSchedulerWorkflowAdmissionRunId(
      paths,
      admission.lease.owner,
      receipt.runId,
      currentDate(dependencies),
      schedulerWorkflowAdmissionLeaseTtlMs(dependencies),
    );
    return resultFromObservedRun(paths, receipt.runId, dependencies);
  } finally {
    await releaseSchedulerWorkflowAdmissionLease(paths, admission.lease.owner);
  }
}

async function resultFromObservedRun(
  paths: RuntimePaths,
  runId: string,
  dependencies: SchedulerWorkflowDependencies,
) {
  try {
    return resultFromTerminalRun(runId, await waitForRun(runId, dependencies));
  } catch (error) {
    return runDirectSchedulerTickFallback(paths, error, 'inspection');
  }
}

async function runDirectSchedulerTickFallback(
  paths: RuntimePaths,
  error: unknown,
  phase: 'inspection' | 'admission',
): Promise<ObservedSchedulerTickResult> {
  const message = errorMessage(error);
  const fallback = await runSchedulerTick(paths);
  await addNotification(
    {
      level: 'attention',
      title: 'Scheduler workflow observation failed',
      message: `Scheduler tick workflow ${phase} failed; ran the direct scheduler tick instead. ${message}`,
      source: 'scheduler',
      sourceId: 'scheduler-tick:workflow-observation-fallback',
      data: {
        phase,
        error: message,
        fallbackOutcome: fallback.outcome ?? null,
      },
    },
    paths,
  );

  return {
    ...fallback,
    changed: true,
    message: `Scheduler tick workflow ${phase} failed; ran direct scheduler tick instead. ${fallback.message}`,
    extra: {
      ...objectField(fallback.extra),
      workflowObservationFallback: true,
      workflowObservationPhase: phase,
      ...(phase === 'admission'
        ? {
            workflowAdmissionFailed: true,
            workflowAdmissionError: message,
          }
        : {
            workflowInspectionFailed: true,
            workflowInspectionError: message,
          }),
    },
  };
}

function resultFromTerminalRun(
  runId: string,
  run: RunRecord | null,
): ObservedSchedulerTickResult {
  if (!run || run.status === 'active') {
    return {
      ok: false,
      action: 'scheduler_tick',
      changed: false,
      outcome: 'failed',
      message: `Scheduler tick workflow ${runId} did not complete within ${defaultWorkflowWaitTimeoutMs}ms.`,
      errors: ['scheduler-tick workflow timed out'],
      extra: { runId, activeWorkflow: true },
      runId,
    };
  }
  if (run.status === 'errored') {
    return {
      ok: false,
      action: 'scheduler_tick',
      changed: false,
      outcome: 'failed',
      message: `Scheduler tick workflow ${runId} failed: ${errorMessage(run.error)}.`,
      errors: [errorMessage(run.error)],
      extra: { runId },
      runId,
    };
  }

  return {
    ...schedulerResultFromRun(run.result),
    runId,
  };
}

export function startSchedulerObservedLoop(
  paths: RuntimePaths,
  intervalMs = 60_000,
  runTick: (paths: RuntimePaths) => Promise<unknown> = runObservedSchedulerTick,
) {
  let tickInFlight = false;
  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void runTick(paths)
      .catch((error) => {
        console.error('[neondeck] scheduler observed tick failed', error);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, intervalMs);

  timer.unref?.();
  return timer;
}

async function invokeSchedulerTickWorkflow(
  paths: RuntimePaths,
  dependencies: SchedulerWorkflowDependencies,
): Promise<WorkflowInvocationReceipt> {
  if (dependencies.invokeWorkflow) return dependencies.invokeWorkflow(paths);
  return invoke(schedulerTickWorkflow, {
    input: { runtimeHome: paths.home },
  });
}

async function activeSchedulerTickRun(
  paths: RuntimePaths,
  dependencies: SchedulerWorkflowDependencies,
  now: Date,
) {
  const active = await (dependencies.listRuns ?? listRuns)({
    workflowName: schedulerWorkflowName,
    status: 'active',
    limit: 50,
  });
  for (const pointer of active.runs) {
    const run = await (dependencies.getRun ?? getRun)(pointer.runId);
    if (!run || run.status !== 'active') continue;
    if (runRuntimeHome(run) !== paths.home) continue;
    if (isStaleActiveRun(run, now, activeRunTtlMs(dependencies))) continue;
    return run;
  }
  return null;
}

async function waitForRun(
  runId: string,
  dependencies: SchedulerWorkflowDependencies,
) {
  const deadline =
    Date.now() + (dependencies.waitTimeoutMs ?? defaultWorkflowWaitTimeoutMs);
  let run: RunRecord | null = null;
  while (Date.now() < deadline) {
    run = await (dependencies.getRun ?? getRun)(runId);
    if (run && run.status !== 'active') return run;
    await (dependencies.sleep ?? sleep)(
      dependencies.pollMs ?? defaultWorkflowPollMs,
    );
  }
  return run;
}

function schedulerResultFromRun(result: unknown): SchedulerResult {
  const record = objectField(result);
  if (typeof record.ok === 'boolean' && typeof record.message === 'string') {
    return record as SchedulerResult;
  }
  return {
    ok: false,
    action: 'scheduler_tick',
    changed: false,
    outcome: 'failed',
    message: 'Scheduler tick workflow returned an invalid result.',
    errors: ['invalid scheduler-tick workflow result'],
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runRuntimeHome(run: RunRecord) {
  const input = objectField(run.input);
  return typeof input.runtimeHome === 'string' && input.runtimeHome
    ? input.runtimeHome
    : null;
}

function acquireSchedulerWorkflowAdmissionLease(
  paths: RuntimePaths,
  now: Date,
  ttlMs: number,
): SchedulerWorkflowAdmissionLeaseResult {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerWorkflowAdmissionLeaseKey);
    const existingLease = parseSchedulerWorkflowAdmissionLease(
      readMetadataValue(existing),
    );
    if (
      existingLease &&
      existingLease.runtimeHome === paths.home &&
      Date.parse(existingLease.expiresAt) > now.getTime()
    ) {
      database.exec('COMMIT;');
      return { acquired: false, lease: existingLease };
    }

    const acquiredAt = now.toISOString();
    const lease: SchedulerWorkflowAdmissionLease = {
      owner: `pid-${process.pid}-${randomUUID()}`,
      runtimeHome: paths.home,
      acquiredAt,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      runId: null,
    };
    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        schedulerWorkflowAdmissionLeaseKey,
        JSON.stringify(lease),
        acquiredAt,
      );
    database.exec('COMMIT;');

    return { acquired: true, lease };
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return { acquired: false, lease: null };
    throw error;
  } finally {
    database.close();
  }
}

function recordSchedulerWorkflowAdmissionRunId(
  paths: RuntimePaths,
  owner: string,
  runId: string,
  now: Date,
  ttlMs: number,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerWorkflowAdmissionLeaseKey);
    const existingLease = parseSchedulerWorkflowAdmissionLease(
      readMetadataValue(existing),
    );
    if (existingLease?.owner !== owner) {
      database.exec('COMMIT;');
      return false;
    }

    const updatedLease: SchedulerWorkflowAdmissionLease = {
      ...existingLease,
      runId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    database
      .prepare(
        `
        UPDATE app_metadata
        SET value = ?, updated_at = ?
        WHERE key = ?;
      `,
      )
      .run(
        JSON.stringify(updatedLease),
        now.toISOString(),
        schedulerWorkflowAdmissionLeaseKey,
      );
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return false;
    throw error;
  } finally {
    database.close();
  }
}

async function releaseSchedulerWorkflowAdmissionLease(
  paths: RuntimePaths,
  owner: string,
) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (releaseSchedulerWorkflowAdmissionLeaseOnce(paths, owner)) return;
    if (attempt < maxAttempts) await sleep(25 * attempt);
  }

  console.warn(
    '[neondeck] scheduler workflow admission lease release was blocked by SQLite; lease will expire automatically.',
  );
  try {
    await addNotification(
      {
        level: 'attention',
        title: 'Scheduler workflow lease release blocked',
        message:
          'Scheduler workflow admission lease release was blocked by SQLite; future observed ticks may wait for the lease TTL before retrying.',
        source: 'scheduler',
        sourceId: 'scheduler-tick:workflow-admission-lease-release',
        data: { owner },
      },
      paths,
    );
  } catch (error) {
    console.warn(
      '[neondeck] failed to persist scheduler workflow lease release warning',
      error,
    );
  }
}

function releaseSchedulerWorkflowAdmissionLeaseOnce(
  paths: RuntimePaths,
  owner: string,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerWorkflowAdmissionLeaseKey);
    const existingLease = parseSchedulerWorkflowAdmissionLease(
      readMetadataValue(existing),
    );
    if (existingLease?.owner === owner) {
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(schedulerWorkflowAdmissionLeaseKey);
    }
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return false;
    throw error;
  } finally {
    database.close();
  }
}

function parseSchedulerWorkflowAdmissionLease(value: string | undefined) {
  if (!value) return;

  try {
    const parsed = objectField(JSON.parse(value));
    if (
      typeof parsed.owner === 'string' &&
      typeof parsed.runtimeHome === 'string' &&
      typeof parsed.acquiredAt === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return {
        owner: parsed.owner,
        runtimeHome: parsed.runtimeHome,
        acquiredAt: parsed.acquiredAt,
        expiresAt: parsed.expiresAt,
        runId: typeof parsed.runId === 'string' ? parsed.runId : null,
      };
    }
  } catch {
    return;
  }
}

function isStaleActiveRun(run: RunRecord, now: Date, ttlMs: number) {
  const startedAt = Date.parse(run.startedAt);
  return Number.isFinite(startedAt) && startedAt + ttlMs <= now.getTime();
}

function schedulerWorkflowAdmissionLeaseTtlMs(
  dependencies: SchedulerWorkflowDependencies,
) {
  return dependencies.admissionLeaseTtlMs ?? defaultWorkflowAdmissionLeaseTtlMs;
}

function activeRunTtlMs(dependencies: SchedulerWorkflowDependencies) {
  return dependencies.activeRunTtlMs ?? defaultWorkflowWaitTimeoutMs;
}

function currentDate(dependencies: SchedulerWorkflowDependencies) {
  return dependencies.now?.() ?? new Date();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
