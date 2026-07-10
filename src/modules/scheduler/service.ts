import {
  addNotification,
  disableStaleScheduleJobs,
  listJobs,
  upsertJob,
  type JobRecord,
} from '../app-state';
import { addSchedule } from '../config';
import {
  claimDueScheduledTasks,
  executeScheduledTask,
  listScheduledTasks,
  readLatestScheduledTaskRun,
  settleScheduledTaskRun,
} from '../scheduled-tasks';
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

  if (
    (input.blueprint === 'docs-drift' || input.blueprint === 'issue-triage') &&
    !input.repo
  ) {
    return failResult(
      'schedule_blueprint_create',
      `The ${input.blueprint} blueprint requires a repo.`,
      { requires: ['repo'] },
    );
  }

  const releaseRepo =
    (input.blueprint === 'release-watch' ||
      input.blueprint === 'docs-drift' ||
      input.blueprint === 'issue-triage') &&
    input.repo
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
    const claimedTasks = await claimDueScheduledTasks(paths, now);
    const notifications = [];
    let taskChanged = false;
    let stoppedForLostLease = false;

    for (const { task, run } of claimedTasks) {
      if (!isSchedulerTickLeaseOwned(paths, lease.owner, new Date())) {
        stoppedForLostLease = true;
        break;
      }
      const previous = await readLatestScheduledTaskRun(task.id, paths);
      try {
        const result = await executeScheduledTask(
          task,
          previous?.result ?? null,
          paths,
          dependencies,
        );
        await settleScheduledTaskRun(
          {
            taskId: task.id,
            runId: run.id,
            claimId: task.claimId ?? '',
            status: 'completed',
            outcome: result.outcome,
            message: result.message,
            workflowRunId: result.workflowRunId,
            sessionId: result.sessionId,
            result: result.result,
          },
          paths,
        );
        if (result.outcome !== 'silent') taskChanged = true;
        for (const notification of result.notifications ?? []) {
          notifications.push(
            await addNotification(
              {
                ...notification,
                source: notification.source ?? 'scheduled-task',
                sourceId: notification.sourceId ?? task.id,
              },
              paths,
            ),
          );
        }
      } catch (error) {
        const message = `Scheduler job failed: ${errorMessage(error)}.`;
        await settleScheduledTaskRun(
          {
            taskId: task.id,
            runId: run.id,
            claimId: task.claimId ?? '',
            status: 'failed',
            outcome: 'failed',
            message,
            error: errorMessage(error),
          },
          paths,
        );
        taskChanged = true;
        notifications.push(
          await addNotification(
            {
              level: 'attention',
              title: 'Scheduled task failed',
              message,
              source: 'scheduler',
              sourceId: task.id,
            },
            paths,
          ),
        );
      }
    }

    const changed = taskChanged || notifications.length > 0;
    const message =
      claimedTasks.length === 0
        ? 'No scheduled tasks were due.'
        : stoppedForLostLease
          ? 'Scheduler tick stopped because it no longer owns the active lease.'
          : `Ran ${claimedTasks.length} scheduled task${claimedTasks.length === 1 ? '' : 's'}.`;
    return okResult(
      'scheduler_tick',
      changed,
      changed ? 'updated' : 'silent',
      message,
      {
        tasks: await listScheduledTasks(paths),
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
