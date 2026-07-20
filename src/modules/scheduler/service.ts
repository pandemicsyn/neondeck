import { addNotification } from '../app-state';
import {
  activateScheduledTaskWorkflowRun,
  attachScheduledTaskWorkflowRunId,
  canAdmitScheduledWorkflow,
  claimDueScheduledTasks,
  deferUnstartedScheduledTaskClaim,
  executeScheduledTask,
  listScheduledTasks,
  readLatestScheduledTaskRun,
  releaseUnstartedScheduledTaskClaim,
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
    const persistNotification = dependencies.addNotification ?? addNotification;

    for (const [index, claim] of claimedTasks.entries()) {
      const { task, run } = claim;
      if (!isSchedulerTickLeaseOwned(paths, lease.owner, new Date())) {
        stoppedForLostLease = true;
        const message =
          'Scheduled task was released because the scheduler tick lost its lease before execution.';
        await Promise.all(
          claimedTasks
            .slice(index)
            .map((unstarted) =>
              releaseUnstartedScheduledTaskClaim(
                { ...unstarted, message },
                paths,
              ),
            ),
        );
        break;
      }
      const previous = await readLatestScheduledTaskRun(task.id, paths);
      let result: Awaited<ReturnType<typeof executeScheduledTask>>;
      try {
        const workflowTask = requiresWorkflowAdmission(task);
        if (
          workflowTask &&
          !(await canAdmitScheduledWorkflow(task.id, paths))
        ) {
          await deferUnstartedScheduledTaskClaim(
            {
              task,
              previous: claim.previous,
              run,
              message:
                'Scheduled task was deferred because the active workflow limit is reached.',
            },
            paths,
          );
          continue;
        }
        if (workflowTask) {
          await activateScheduledTaskWorkflowRun(
            {
              taskId: task.id,
              runId: run.id,
              claimId: task.claimId ?? '',
            },
            paths,
          );
        }
        result = await executeScheduledTask(
          task,
          previous?.result ?? null,
          paths,
          dependencies,
        );
        if (result.workflowRunId) {
          await attachScheduledTaskWorkflowRunId(
            { runId: run.id, workflowRunId: result.workflowRunId },
            paths,
          );
        } else {
          await settleScheduledTaskRun(
            {
              taskId: task.id,
              runId: run.id,
              claimId: task.claimId ?? '',
              status: 'completed',
              outcome: result.outcome,
              message: result.message,
              sessionId: result.sessionId,
              result: result.result,
            },
            paths,
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
        try {
          notifications.push(
            await persistNotification(
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
        } catch (notificationError) {
          console.warn(
            '[neondeck] failed to persist scheduled task failure notification',
            notificationError,
          );
        }
        continue;
      }

      if (result.outcome !== 'silent') taskChanged = true;
      for (const notification of result.notifications ?? []) {
        try {
          notifications.push(
            await persistNotification(
              {
                ...notification,
                source: notification.source ?? 'scheduled-task',
                sourceId: notification.sourceId ?? task.id,
              },
              paths,
            ),
          );
        } catch (notificationError) {
          console.warn(
            '[neondeck] failed to persist scheduled task notification',
            notificationError,
          );
        }
      }
      notifications.push(...(result.persistedNotifications ?? []));
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

function requiresWorkflowAdmission(task: {
  spec: { kind: string; target?: { kind: string } };
}) {
  return (
    task.spec.kind === 'run-briefing' ||
    (task.spec.kind === 'run-agent-instruction' &&
      task.spec.target?.kind === 'workflow')
  );
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
