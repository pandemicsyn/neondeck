import { defineAction, type JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  addNotification,
  disableStaleScheduleJobs,
  listJobs,
  type JobRecord,
  type NotificationLevel,
  updateJobRun,
  upsertJob,
} from './app-state';
import { addSchedule } from './config-actions';
import { fetchCheckSummary, type GitHubCheckSummary } from './github';
import { readRepoRegistrySnapshot, repoFullName } from './repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import {
  addPrWatch,
  listRefWatchRecords,
  listPrWatchRecords,
  refreshRefWatch,
  refreshPrWatch,
  type WatchActionResult,
} from './watch-actions';

type SchedulerResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  outcome?: string;
  jobs?: JsonValue[];
  notifications?: JsonValue[];
  extra?: JsonValue;
  errors?: string[];
  requires?: string[];
};

type BlueprintKind =
  'morning-briefing' | 'watch-pr' | 'release-watch' | 'review-queue-digest';

type JobExecutionResult = {
  outcome: 'silent' | 'updated' | 'recorded' | 'failed';
  message: string;
  result?: unknown;
  notifications?: Array<{
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  }>;
};

type SchedulerDependencies = {
  addPrWatch?: (
    input: Parameters<typeof addPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  refreshPrWatch?: (
    input: Parameters<typeof refreshPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  refreshRefWatch?: (
    input: Parameters<typeof refreshRefWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  fetchCheckSummary?: typeof fetchCheckSummary;
  invokeWorkflow?: (
    workflow: ScheduledWorkflowName,
    input: JsonValue,
  ) => Promise<{ runId: string }>;
  tickLeaseTtlMs?: number;
};

type ScheduledWorkflowName = 'briefing' | 'command-run';
type SchedulerTickLease = {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
};
type SchedulerTickLeaseResult =
  | { acquired: true; owner: string }
  | { acquired: false; reason: 'active' | 'busy' };
type SchedulerTickLeaseRenewResult = 'renewed' | 'lost' | 'busy';

const schedulerTickLeaseKey = 'scheduler.tick.lease';
const defaultSchedulerTickLeaseTtlMs = 5 * 60 * 1000;
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const blueprintSchema = v.picklist([
  'morning-briefing',
  'watch-pr',
  'release-watch',
  'review-queue-digest',
]);
const createBlueprintInputSchema = v.object({
  blueprint: blueprintSchema,
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  config: v.optional(v.record(v.string(), v.unknown())),
});
const schedulerActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  outcome: v.optional(v.string()),
  jobs: v.optional(v.array(v.unknown())),
  notifications: v.optional(v.array(v.unknown())),
  extra: v.optional(v.unknown()),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
});

export const scheduleBlueprintCreateAction = defineAction({
  name: 'neondeck_schedule_blueprint_create',
  description:
    'Create a blueprint-backed automation for morning briefing, watch PR, release watch, or review queue digest.',
  input: createBlueprintInputSchema,
  output: schedulerActionOutputSchema,
  async run({ input }) {
    return createScheduleBlueprint(input);
  },
});

export const schedulerTickAction = defineAction({
  name: 'neondeck_scheduler_tick',
  description:
    'Synchronize configured schedules into durable jobs and run jobs that are due.',
  input: v.object({}),
  output: schedulerActionOutputSchema,
  async run({ log }) {
    log.info('Scheduler tick requested');

    const result = await runSchedulerTick();
    const payload = {
      ok: result.ok,
      outcome: result.outcome ?? null,
      changed: result.changed,
      message: result.message,
      jobs: result.jobs?.length ?? 0,
      notifications: result.notifications?.length ?? 0,
    };
    if (result.ok) {
      log.info('Scheduler tick completed', payload);
    } else {
      log.warn('Scheduler tick failed', payload);
    }

    return result;
  },
});

export const schedulerListJobsAction = defineAction({
  name: 'neondeck_scheduler_list_jobs',
  description: 'List durable Neondeck scheduler jobs and last run state.',
  input: v.object({}),
  output: schedulerActionOutputSchema,
  async run() {
    return listSchedulerJobs();
  },
});

export const neondeckSchedulerActions = [
  scheduleBlueprintCreateAction,
  schedulerTickAction,
  schedulerListJobsAction,
];

export async function createScheduleBlueprint(
  rawInput: v.InferInput<typeof createBlueprintInputSchema>,
  paths = runtimePaths(),
  dependencies: SchedulerDependencies = {},
): Promise<SchedulerResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    createBlueprintInputSchema,
    rawInput,
    'schedule_blueprint_create',
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (input.blueprint === 'watch-pr' && !input.ref) {
    return failResult(
      'schedule_blueprint_create',
      'The watch-pr blueprint requires a PR reference.',
      { requires: ['ref'] },
    );
  }

  if (input.blueprint === 'release-watch' && !input.repo) {
    return failResult(
      'schedule_blueprint_create',
      'The release-watch blueprint requires a repo.',
      { requires: ['repo'] },
    );
  }

  const releaseRepo =
    input.blueprint === 'release-watch' && input.repo
      ? await resolveReleaseWatchRepo(input.repo, paths)
      : undefined;
  if (releaseRepo && !releaseRepo.ok) return releaseRepo.result;

  const target = input.ref ?? releaseRepo?.repo.id ?? input.repo;
  const id = input.id ?? defaultBlueprintId(input.blueprint, target);
  const config = {
    ...input.config,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.repo ? { repo: releaseRepo?.repo.id ?? input.repo } : {}),
    intervalSeconds:
      input.intervalSeconds ?? defaultIntervalSeconds(input.blueprint),
  };

  if (input.blueprint === 'watch-pr' && input.ref) {
    const addWatch = dependencies.addPrWatch ?? addPrWatch;
    const watchResult = await addWatch(
      {
        ref: input.ref,
        desiredTerminalState: 'checks',
        intervalSeconds:
          input.intervalSeconds ?? defaultIntervalSeconds(input.blueprint),
      },
      paths,
    );
    if (!watchResult.ok) {
      return failResult('schedule_blueprint_create', watchResult.message, {
        errors: watchResult.errors,
        requires: watchResult.requires,
      });
    }

    return okResult(
      'schedule_blueprint_create',
      true,
      'created',
      `Created watch-pr automation "${id}".`,
      {
        jobs: await listJobs(paths),
        extra: { watch: watchResult },
      },
    );
  }

  const scheduleResult = await addSchedule(
    {
      id,
      type: input.blueprint,
      enabled: true,
      preset: input.blueprint,
      config,
    },
    paths,
  );

  if (!scheduleResult.ok) {
    return failResult('schedule_blueprint_create', scheduleResult.message, {
      errors: scheduleResult.errors,
      requires: scheduleResult.requires,
    });
  }

  await syncScheduledJobs(paths);

  return okResult(
    'schedule_blueprint_create',
    true,
    'created',
    `Created ${input.blueprint} schedule "${id}".`,
    {
      jobs: await listJobs(paths),
      extra: { schedule: scheduleResult.data },
    },
  );
}

export async function listSchedulerJobs(paths = runtimePaths()) {
  return okResult(
    'scheduler_list_jobs',
    false,
    undefined,
    'Listed scheduler jobs.',
    { jobs: await listJobs(paths) },
  );
}

export async function syncScheduledJobs(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const scheduleConfig = await readRuntimeJson(
    paths.schedules,
    parseScheduleConfig,
  );
  const jobs: JobRecord[] = [];

  for (const schedule of scheduleConfig.schedules) {
    jobs.push(
      await upsertJob(
        {
          id: `schedule:${schedule.id}`,
          type: schedule.type,
          blueprint: schedule.preset ?? schedule.type,
          enabled: schedule.enabled ?? true,
          intervalSeconds: readIntervalSeconds(
            schedule.config,
            schedule.type as BlueprintKind,
          ),
          config: {
            ...schedule.config,
            scheduleId: schedule.id,
          },
        },
        paths,
      ),
    );
  }

  await disableStaleScheduleJobs(
    jobs.map((job) => job.id),
    paths,
  );

  return jobs;
}

export async function runSchedulerTick(
  paths = runtimePaths(),
  now = new Date(),
  dependencies: SchedulerDependencies = {},
): Promise<SchedulerResult> {
  await ensureRuntimeHome(paths);
  const leaseTtlMs =
    dependencies.tickLeaseTtlMs ?? defaultSchedulerTickLeaseTtlMs;
  const lease = acquireSchedulerTickLease(paths, new Date(), leaseTtlMs);
  if (!lease.acquired) {
    return okResult(
      'scheduler_tick',
      false,
      'silent',
      'Scheduler tick skipped because another tick is active.',
      {
        jobs: await listJobs(paths),
        notifications: [],
        extra: { lease: lease.reason },
      },
    );
  }
  const stopLeaseHeartbeat = startSchedulerTickLeaseHeartbeat(
    paths,
    lease.owner,
    leaseTtlMs,
  );

  try {
    await syncScheduledJobs(paths);
    const jobs = (await listJobs(paths)).filter(
      (job) =>
        job.enabled &&
        (!job.nextRunAt || Date.parse(job.nextRunAt) <= now.getTime()),
    );
    const notifications = [];
    let stoppedForLostLease = false;

    for (const job of jobs) {
      if (!isSchedulerTickLeaseOwned(paths, lease.owner, new Date())) {
        stoppedForLostLease = true;
        break;
      }

      const nextRunAt = new Date(
        now.getTime() + job.intervalSeconds * 1000,
      ).toISOString();

      // Advance before external side effects so a crash after admission does
      // not leave the same job immediately due for duplicate admission.
      await updateJobRun(
        job.id,
        {
          outcome: 'started',
          message: 'Scheduler job started.',
          result: job.lastResult,
          nextRunAt,
        },
        paths,
      );

      let result: JobExecutionResult;
      try {
        result = await executeJob(job, paths, dependencies);
      } catch (error) {
        await updateJobRun(
          job.id,
          {
            outcome: 'failed',
            message: `Scheduler job failed: ${errorMessage(error)}.`,
            result: { error: errorMessage(error) },
            nextRunAt: now.toISOString(),
          },
          paths,
        );
        throw error;
      }

      await updateJobRun(
        job.id,
        {
          outcome: result.outcome,
          message: result.message,
          result: result.result,
          nextRunAt,
        },
        paths,
      );

      for (const notification of result.notifications ?? []) {
        notifications.push(await addNotification(notification, paths));
      }
    }

    const changed = notifications.length > 0;
    return okResult(
      'scheduler_tick',
      changed,
      changed ? 'updated' : 'silent',
      jobs.length === 0
        ? 'No scheduled jobs were due.'
        : stoppedForLostLease
          ? 'Scheduler tick stopped because it no longer owns the active lease.'
          : `Ran ${jobs.length} scheduled job${jobs.length === 1 ? '' : 's'}.`,
      {
        jobs: await listJobs(paths),
        notifications,
      },
    );
  } finally {
    stopLeaseHeartbeat();
    await releaseSchedulerTickLease(paths, lease.owner);
  }
}

export function startSchedulerLoop(
  paths = runtimePaths(),
  intervalMs = 60_000,
  runTick: (paths: RuntimePaths) => Promise<SchedulerResult> = runSchedulerTick,
) {
  let tickInFlight = false;
  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void runTick(paths)
      .catch((error) => {
        console.error('[neondeck] scheduler tick failed', error);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, intervalMs);

  timer.unref?.();
  return timer;
}

function acquireSchedulerTickLease(
  paths: RuntimePaths,
  now: Date,
  ttlMs: number,
): SchedulerTickLeaseResult {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    if (existingLease && Date.parse(existingLease.expiresAt) > now.getTime()) {
      database.exec('COMMIT;');
      return { acquired: false, reason: 'active' };
    }

    const acquiredAt = now.toISOString();
    const lease: SchedulerTickLease = {
      owner: `pid-${process.pid}-${randomUUID()}`,
      acquiredAt,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
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
      .run(schedulerTickLeaseKey, JSON.stringify(lease), acquiredAt);
    database.exec('COMMIT;');

    return { acquired: true, owner: lease.owner };
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return { acquired: false, reason: 'busy' };
    throw error;
  } finally {
    database.close();
  }
}

function startSchedulerTickLeaseHeartbeat(
  paths: RuntimePaths,
  owner: string,
  ttlMs: number,
) {
  const intervalMs = Math.max(10, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    try {
      const result = renewSchedulerTickLease(paths, owner, new Date(), ttlMs);
      if (result === 'lost') {
        clearInterval(timer);
      }
    } catch (error) {
      console.warn(
        `[neondeck] scheduler tick lease heartbeat failed: ${errorMessage(error)}`,
      );
    }
  }, intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
}

function renewSchedulerTickLease(
  paths: RuntimePaths,
  owner: string,
  now: Date,
  ttlMs: number,
): SchedulerTickLeaseRenewResult {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    if (existingLease?.owner !== owner) {
      database.exec('COMMIT;');
      return 'lost';
    }

    const renewedLease = {
      ...existingLease,
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
        JSON.stringify(renewedLease),
        now.toISOString(),
        schedulerTickLeaseKey,
      );
    database.exec('COMMIT;');
    return 'renewed';
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return 'busy';
    throw error;
  } finally {
    database.close();
  }
}

function isSchedulerTickLeaseOwned(
  paths: RuntimePaths,
  owner: string,
  now: Date,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    return (
      existingLease?.owner === owner &&
      Date.parse(existingLease.expiresAt) > now.getTime()
    );
  } catch (error) {
    if (isSqliteBusy(error)) return false;
    throw error;
  } finally {
    database.close();
  }
}

async function releaseSchedulerTickLease(paths: RuntimePaths, owner: string) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const released = releaseSchedulerTickLeaseOnce(paths, owner);
    if (released) return;
    if (attempt < maxAttempts) {
      await sleep(25 * attempt);
    }
  }

  console.warn(
    '[neondeck] scheduler tick lease release was blocked by SQLite; lease will expire automatically.',
  );
}

function releaseSchedulerTickLeaseOnce(paths: RuntimePaths, owner: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    if (existingLease?.owner === owner) {
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(schedulerTickLeaseKey);
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

function parseSchedulerTickLease(value: string | undefined) {
  if (!value) return;

  try {
    const parsed = JSON.parse(value) as Partial<SchedulerTickLease>;
    if (
      typeof parsed.owner === 'string' &&
      typeof parsed.acquiredAt === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return {
        owner: parsed.owner,
        acquiredAt: parsed.acquiredAt,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    return;
  }
}

function readMetadataValue(row: unknown) {
  if (row && typeof row === 'object' && 'value' in row) {
    const value = row.value;
    return typeof value === 'string' ? value : undefined;
  }
}

function rollbackQuietly(database: DatabaseSync) {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // The transaction may already be closed.
  }
}

function isSqliteBusy(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED') ||
    message.includes('database is locked')
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeJob(
  job: JobRecord,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
): Promise<JobExecutionResult> {
  if (job.type === 'watch-pr') {
    return refreshWatchJob(job, paths, dependencies.refreshPrWatch);
  }

  if (job.type === 'watch-ref') {
    return refreshRefWatchJob(job, paths, dependencies.refreshRefWatch);
  }

  if (job.type === 'morning-briefing') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('briefing', {});

    return {
      outcome: 'recorded',
      message: `Admitted morning briefing workflow ${runId}.`,
      result: { runId },
      notifications: [
        {
          level: 'info',
          title: 'Morning briefing queued',
          message: 'A morning briefing workflow was queued for Neon.',
          source: 'scheduler',
          sourceId: job.id,
          data: { runId },
        },
      ],
    };
  }

  if (job.type === 'review-queue-digest') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('command-run', {
      command: '/review-queue',
    });

    return {
      outcome: 'recorded',
      message: `Admitted review queue digest workflow ${runId}.`,
      result: { runId },
      notifications: [
        {
          level: 'info',
          title: 'Review queue digest due',
          message: 'A review queue digest workflow was queued.',
          source: 'scheduler',
          sourceId: job.id,
          data: { runId },
        },
      ],
    };
  }

  if (job.type === 'release-watch') {
    return refreshReleaseWatchJob(job, paths, dependencies.fetchCheckSummary);
  }

  return {
    outcome: 'silent',
    message: `No executor is registered for job type "${job.type}".`,
  };
}

async function invokeScheduledWorkflow(
  workflow: ScheduledWorkflowName,
  input: JsonValue,
) {
  const { invoke } = await import('@flue/runtime');

  if (workflow === 'briefing') {
    const module = await import('./workflows/briefing');
    return invoke(module.default, { input: input as Record<string, never> });
  }

  const module = await import('./workflows/command-run');
  return invoke(module.default, {
    input: input as { command: string },
  });
}

async function refreshReleaseWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  fetchChecks: typeof fetchCheckSummary = fetchCheckSummary,
): Promise<JobExecutionResult> {
  const registry = await readRepoRegistrySnapshot(paths);
  const config = readObjectConfig(job.config);
  const repoRef = typeof config.repo === 'string' ? config.repo : undefined;
  const sourceWatchId =
    typeof config.sourceWatchId === 'string' ? config.sourceWatchId : undefined;
  let sourceWatch:
    Awaited<ReturnType<typeof listPrWatchRecords>>[number] | undefined;
  const repo = repoRef
    ? registry.repos.find(
        (item) =>
          item.id === repoRef ||
          item.github.name === repoRef ||
          repoFullName(item).toLowerCase() === repoRef.toLowerCase(),
      )
    : undefined;

  if (!repo) {
    return {
      outcome: 'failed',
      message: repoRef
        ? `Release watch repository "${repoRef}" is not configured.`
        : 'Release watch requires a configured repository.',
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: repoRef
            ? `Repository "${repoRef}" is not configured.`
            : 'Release watch requires a repository.',
          source: 'release-watch',
          sourceId: job.id,
          data: job.config,
        },
      ],
    };
  }

  if (sourceWatchId) {
    sourceWatch = (await listPrWatchRecords(paths)).find(
      (watch) => watch.id === sourceWatchId,
    );
    if (!sourceWatch) {
      return {
        outcome: 'failed',
        message: `Linked PR watch "${sourceWatchId}" does not exist.`,
        notifications: [
          {
            level: 'attention',
            title: 'Release watch failed',
            message: `Linked PR watch "${sourceWatchId}" does not exist.`,
            source: 'release-watch',
            sourceId: job.id,
            data: job.config,
          },
        ],
      };
    }
    if (!['merged', 'green'].includes(sourceWatch.status)) {
      return {
        outcome: 'silent',
        message: `Release watch is waiting for PR watch "${sourceWatchId}" to merge.`,
        result: {
          repo: repo.id,
          sourceWatchId,
          sourceWatchStatus: sourceWatch.status,
        },
      };
    }
    if (!sourceWatch.mergeCommitSha) {
      return {
        outcome: 'failed',
        message: `Linked PR watch "${sourceWatchId}" has no merge commit SHA.`,
        notifications: [
          {
            level: 'attention',
            title: 'Release watch failed',
            message: `Linked PR watch "${sourceWatchId}" has no merge commit SHA.`,
            source: 'release-watch',
            sourceId: job.id,
            data: job.config,
          },
        ],
      };
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      outcome: 'failed',
      message: 'GITHUB_TOKEN is not configured.',
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: 'GITHUB_TOKEN is not configured.',
          source: 'release-watch',
          sourceId: job.id,
          data: { repo: repo.id, requires: ['GITHUB_TOKEN'] },
        },
      ],
    };
  }

  try {
    const ref = sourceWatch?.mergeCommitSha ?? repo.defaultBranch;
    const checks = await fetchChecks({
      token,
      owner: repo.github.owner,
      repo: repo.github.name,
      ref,
    });
    const snapshot = {
      repo: repo.id,
      repoFullName: repoFullName(repo),
      defaultBranch: repo.defaultBranch,
      ref,
      sourceWatchId: sourceWatch?.id ?? null,
      sourceMergeCommitSha: sourceWatch?.mergeCommitSha ?? null,
      productionTarget: repo.productionTarget ?? null,
      checks,
      checkedAt: new Date().toISOString(),
    };
    const previous = readReleaseWatchResult(job.lastResult);
    const statusChanged = previous?.checks.status !== checks.status;
    const shouldNotify =
      statusChanged &&
      (checks.status === 'success' || checks.status === 'failure');

    return {
      outcome: statusChanged ? 'updated' : 'silent',
      message: statusChanged
        ? `Release watch ${repo.id} ${ref} is ${checks.status}.`
        : `Release watch ${repo.id} ${ref} is unchanged.`,
      result: snapshot,
      notifications: shouldNotify
        ? [releaseWatchNotification(job, snapshot)]
        : undefined,
    };
  } catch (error) {
    return {
      outcome: 'failed',
      message: `Could not fetch release watch checks: ${errorMessage(error)}.`,
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: `Could not fetch checks for ${repoFullName(repo)}@${sourceWatch?.mergeCommitSha ?? repo.defaultBranch}.`,
          source: 'release-watch',
          sourceId: job.id,
          data: { error: errorMessage(error), repo: repo.id },
        },
      ],
    };
  }
}

function releaseWatchNotification(
  job: JobRecord,
  snapshot: {
    repo: string;
    repoFullName: string;
    defaultBranch: string;
    ref: string;
    sourceWatchId: string | null;
    sourceMergeCommitSha: string | null;
    productionTarget: string | null;
    checks: GitHubCheckSummary;
    checkedAt: string;
  },
) {
  const failed = snapshot.checks.status === 'failure';
  const titleTarget = snapshot.sourceMergeCommitSha
    ? 'merge commit'
    : snapshot.defaultBranch;
  return {
    level: failed ? ('urgent' as const) : ('ready' as const),
    title: failed
      ? 'Release watch needs attention'
      : `Release watch ${titleTarget} green`,
    message: failed
      ? `${snapshot.repoFullName}@${snapshot.ref} checks failed.`
      : `${snapshot.repoFullName}@${snapshot.ref} checks are green.`,
    source: 'release-watch',
    sourceId: job.id,
    data: snapshot,
  };
}

function readReleaseWatchResult(value: JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const checks = (value as { checks?: unknown }).checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    return undefined;
  }
  const status = (checks as { status?: unknown }).status;
  return typeof status === 'string'
    ? { checks: { status } as GitHubCheckSummary }
    : undefined;
}

async function refreshWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  refreshWatch: SchedulerDependencies['refreshPrWatch'] = refreshPrWatch,
): Promise<JobExecutionResult> {
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.ref === 'string'
        ? { ref: config.ref }
        : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listPrWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} PR watch${failures.length === 1 ? '' : 'es'}.`,
      result: { results },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'PR watch refresh failed',
        message: result.message,
        source: 'watch-pr',
        sourceId: failedWatchSourceId(result, target),
        data: result,
      })),
    };
  }

  const changed = results.filter((result) => result.changed);
  const notifications = changed.map((result) => {
    const watch = result.watch as { id?: string; status?: string } | undefined;
    const level: NotificationLevel =
      watch?.status === 'closed' || watch?.status === 'attention-needed'
        ? 'attention'
        : watch?.status === 'merged' || watch?.status === 'green'
          ? 'ready'
          : 'info';
    const title =
      watch?.status === 'green'
        ? 'PR watch green'
        : watch?.status === 'attention-needed'
          ? 'PR watch needs attention'
          : watch?.status === 'merged'
            ? 'PR watch merged'
            : watch?.status === 'closed'
              ? 'PR watch closed'
              : 'PR watch changed';

    return {
      level,
      title,
      message: result.message,
      source: 'watch-pr',
      sourceId: watch?.id,
      data: result.watch,
    };
  });

  return {
    outcome: changed.length > 0 ? 'updated' : 'silent',
    message:
      changed.length > 0
        ? `Updated ${changed.length} PR watch${changed.length === 1 ? '' : 'es'}.`
        : 'PR watch refresh had no changes.',
    result: { results },
    notifications,
  };
}

async function refreshRefWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  refreshWatch: SchedulerDependencies['refreshRefWatch'] = refreshRefWatch,
): Promise<JobExecutionResult> {
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.repo === 'string' && typeof config.ref === 'string'
        ? { repo: config.repo, ref: config.ref }
        : typeof config.target === 'string'
          ? { target: config.target }
          : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listRefWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} ref watch${failures.length === 1 ? '' : 'es'}.`,
      result: { results },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'Ref watch refresh failed',
        message: result.message,
        source: 'watch-ref',
        sourceId: failedWatchSourceId(result, target),
        data: result,
      })),
    };
  }

  const changed = results.filter((result) => result.changed);
  const notifications = changed.map((result) => {
    const watch = result.watch as { id?: string; status?: string } | undefined;
    const level: NotificationLevel =
      watch?.status === 'attention-needed'
        ? 'attention'
        : watch?.status === 'green'
          ? 'ready'
          : 'info';
    const title =
      watch?.status === 'green'
        ? 'Ref watch green'
        : watch?.status === 'attention-needed'
          ? 'Ref watch needs attention'
          : 'Ref watch changed';

    return {
      level,
      title,
      message: result.message,
      source: 'watch-ref',
      sourceId: watch?.id,
      data: result.watch,
    };
  });

  return {
    outcome: changed.length > 0 ? 'updated' : 'silent',
    message:
      changed.length > 0
        ? `Updated ${changed.length} ref watch${changed.length === 1 ? '' : 'es'}.`
        : 'Ref watch refresh had no changes.',
    result: { results },
    notifications,
  };
}

function failedWatchSourceId(
  result: unknown,
  target: { id?: string; ref?: string } | undefined,
) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const watch = (result as { watch?: unknown }).watch;
    if (watch && typeof watch === 'object' && !Array.isArray(watch)) {
      const id = (watch as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
  }

  return target?.id ?? target?.ref ?? 'all-watches';
}

function readIntervalSeconds(config: unknown, type: BlueprintKind | string) {
  const record = readObjectConfig(config);
  const value = record.intervalSeconds;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 60) {
    return value;
  }

  return defaultIntervalSeconds(type);
}

function defaultIntervalSeconds(type: BlueprintKind | string) {
  if (type === 'watch-pr') return 300;
  if (type === 'release-watch') return 900;
  if (type === 'review-queue-digest') return 3_600;
  return 86_400;
}

function defaultBlueprintId(blueprint: BlueprintKind, target?: string) {
  const suffix = target
    ? target
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    : 'default';
  return `${blueprint}-${suffix}`;
}

async function resolveReleaseWatchRepo(repoRef: string, paths: RuntimePaths) {
  const registry = await readRepoRegistrySnapshot(paths);
  const matches = registry.repos.filter(
    (repo) =>
      repo.id === repoRef ||
      repo.github.name === repoRef ||
      repoFullName(repo).toLowerCase() === repoRef.toLowerCase(),
  );

  if (matches.length === 1) {
    return { ok: true as const, repo: matches[0] };
  }

  if (matches.length > 1) {
    return {
      ok: false as const,
      result: failResult(
        'schedule_blueprint_create',
        `Repository "${repoRef}" is ambiguous.`,
        { requires: ['repo'] },
      ),
    };
  }

  return {
    ok: false as const,
    result: failResult(
      'schedule_blueprint_create',
      `Repository "${repoRef}" is not configured.`,
      { requires: ['repo'] },
    ),
  };
}

function readObjectConfig(config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
) {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true as const, input: result.output };

  return {
    ok: false as const,
    result: failResult(action, 'Invalid action input.', {
      errors: [v.summarize(result.issues)],
    }),
  };
}

function okResult(
  action: string,
  changed: boolean,
  outcome: string | undefined,
  message: string,
  data: {
    jobs?: JobRecord[];
    notifications?: unknown[];
    extra?: unknown;
  } = {},
): SchedulerResult {
  return {
    ok: true,
    action,
    changed,
    ...(outcome ? { outcome } : {}),
    message,
    ...(data.jobs ? { jobs: data.jobs.map(asJsonValue) } : {}),
    ...(data.notifications
      ? { notifications: data.notifications.map(asJsonValue) }
      : {}),
    ...(data.extra ? { extra: asJsonValue(data.extra) } : {}),
  } as SchedulerResult;
}

function failResult(
  action: string,
  message: string,
  details: Pick<SchedulerResult, 'errors' | 'requires'> = {},
): SchedulerResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
