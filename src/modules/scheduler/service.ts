import {
  addNotification,
  disableStaleScheduleJobs,
  listJobs,
  updateJobRun,
  upsertJob,
  type JobRecord,
} from '../app-state';
import { addSchedule } from '../config';
import {
  ensureRuntimeHome,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { addPrWatch } from '../watches';
import type {
  BlueprintKind,
  JobExecutionResult,
  SchedulerDependencies,
  SchedulerResult,
} from './schemas';
import {
  createBlueprintInputSchema,
  defaultSchedulerTickLeaseTtlMs,
} from './schemas';
import {
  defaultBlueprintId,
  defaultIntervalSeconds,
  executeJob,
  readIntervalSeconds,
  resolveReleaseWatchRepo,
} from './dispatch';
import {
  acquireSchedulerTickLease,
  isSchedulerTickLeaseOwned,
  releaseSchedulerTickLease,
  startSchedulerTickLeaseHeartbeat,
} from './lease';
import { errorMessage, failResult, okResult, parseActionInput } from './utils';
import type * as v from 'valibot';

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
