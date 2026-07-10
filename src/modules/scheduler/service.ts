import { addNotification } from '../app-state';
import {
  claimDueScheduledTasks,
  executeScheduledTask,
  listScheduledTasks,
  readLatestScheduledTaskRun,
  settleScheduledTaskRun,
} from '../scheduled-tasks';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import type { SchedulerDependencies, SchedulerResult } from './schemas';
import { defaultSchedulerTickLeaseTtlMs } from './schemas';
import {
  acquireSchedulerTickLease,
  isSchedulerTickLeaseOwned,
  releaseSchedulerTickLease,
  startSchedulerTickLeaseHeartbeat,
} from './lease';
import { errorMessage, okResult } from './utils';

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
        tasks: await listScheduledTasks(paths),
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
        const message = `Scheduled task failed: ${errorMessage(error)}.`;
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
      { tasks: await listScheduledTasks(paths), notifications },
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
