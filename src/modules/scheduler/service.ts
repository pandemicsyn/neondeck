import { addNotification } from '../app-state';
import {
  activateScheduledTaskSubmission,
  activateScheduledTaskResultSubmission,
  attachScheduledTaskSubmissionId,
  canAdmitScheduledSubmission,
  claimDueScheduledTasks,
  deferUnstartedScheduledTaskClaim,
  dispatchScheduledInstruction,
  executeScheduledTask,
  listRecoverableScheduledBriefingRuns,
  listActiveScheduledInstructionRuns,
  listScheduledTasks,
  prepareScheduledInstructionDispatch,
  readLatestScheduledTaskRun,
  readScheduledTask,
  readScheduledInstructionSettlement,
  recordScheduledTaskAdmissionRetry,
  releaseUnstartedScheduledTaskClaim,
  settleScheduledTaskRun,
  settleScheduledTaskSubmission,
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
import {
  BriefingAdmissionConflictError,
  readBriefingRun,
  recoverRegisteredInterruptedBriefingAdmissions,
} from '../briefings';

declare global {
  var __neondeckScheduledSettlementWatchers:
    Map<string, Promise<void>> | undefined;
}

const scheduledSettlementWatchers = settlementWatchers();

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
    await recoverRegisteredInterruptedBriefingAdmissions(paths);
    await recoverScheduledBriefingSubmissions(paths);
    await recoverScheduledInstructionSubmissions(paths, dependencies);
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
      let admissionOutboxPrepared = false;
      try {
        const submissionTask = requiresSubmissionAdmission(task);
        if (
          submissionTask &&
          !(await canAdmitScheduledSubmission(task.id, paths))
        ) {
          await deferUnstartedScheduledTaskClaim(
            {
              task,
              previous: claim.previous,
              run,
              message:
                'Scheduled task was deferred because the active submission limit is reached.',
            },
            paths,
          );
          continue;
        }
        if (submissionTask) {
          const prepared = await prepareScheduledInstructionDispatch(
            task,
            run.id,
            paths,
          );
          await activateScheduledTaskSubmission(
            {
              taskId: task.id,
              runId: run.id,
              claimId: task.claimId ?? '',
              sessionId: prepared.sessionId,
              dispatchKey: prepared.idempotencyKey,
              dispatchPayload: prepared.payload,
            },
            paths,
          );
          admissionOutboxPrepared = true;
          const admitted = await dispatchPreparedInstruction(
            prepared,
            dependencies,
          );
          result = {
            outcome: 'recorded',
            message: `Dispatched scheduled instruction to session ${admitted.sessionId}.`,
            submissionId: admitted.submissionId,
            sessionId: admitted.sessionId,
            result: {
              submissionId: admitted.submissionId,
              sessionId: admitted.sessionId,
            },
          };
        } else {
          result = await executeScheduledTask(
            task,
            previous?.result ?? null,
            paths,
            { ...dependencies, scheduledTaskRunId: run.id },
          );
        }
        if (result.submissionId) {
          const correlation = {
            runId: run.id,
            submissionId: result.submissionId,
            sessionId: result.sessionId ?? null,
            result: result.result,
          };
          if (submissionTask) {
            await attachScheduledTaskSubmissionId(correlation, paths);
          } else {
            await activateScheduledTaskResultSubmission(
              {
                ...correlation,
                taskId: task.id,
                claimId: task.claimId ?? '',
              },
              paths,
            );
          }
          if (submissionTask && result.sessionId) {
            watchScheduledInstructionSettlement(
              {
                submissionId: result.submissionId,
                sessionId: result.sessionId,
              },
              paths,
              dependencies,
            );
          }
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
        if (error instanceof BriefingAdmissionConflictError) {
          await deferUnstartedScheduledTaskClaim(
            {
              task,
              previous: claim.previous,
              run,
              message: `Scheduled briefing was deferred because conversation ${error.sessionId} already has an active briefing.`,
            },
            paths,
          );
          continue;
        }
        const message = `Scheduled task failed: ${errorMessage(error)}.`;
        if (admissionOutboxPrepared) {
          await recordScheduledTaskAdmissionRetry(
            { runId: run.id, message: errorMessage(error) },
            paths,
          );
          taskChanged = true;
          continue;
        }
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

async function recoverScheduledBriefingSubmissions(paths: RuntimePaths) {
  const candidates = await listRecoverableScheduledBriefingRuns(paths);
  for (const candidate of candidates) {
    if (!candidate.briefingRunId) continue;
    const briefing = await readBriefingRun(candidate.briefingRunId, paths);
    const task = await readScheduledTask(candidate.run.taskId, paths);
    if (!briefing || !task) continue;

    if (candidate.run.status === 'claimed') {
      if (!briefing.dispatchId) {
        if (briefing.status === 'failed') {
          await settleScheduledTaskRun(
            {
              taskId: task.id,
              runId: candidate.run.id,
              claimId: task.claimId ?? '',
              status: 'failed',
              outcome: 'failed',
              message: 'Scheduled briefing admission failed before dispatch.',
              error: briefing.error,
            },
            paths,
          );
        }
        continue;
      }
      await activateScheduledTaskResultSubmission(
        {
          taskId: task.id,
          runId: candidate.run.id,
          claimId: task.claimId ?? '',
          submissionId: briefing.dispatchId,
          sessionId: briefing.sessionId,
          result: {
            briefingRunId: briefing.id,
            submissionId: briefing.dispatchId,
            briefingId: briefing.profileId,
          },
        },
        paths,
      );
    }
    if (briefing.dispatchId && briefing.status !== 'queued') {
      await settleScheduledTaskSubmission(
        {
          submissionId: briefing.dispatchId,
          failed: briefing.status === 'failed',
        },
        paths,
      );
    }
  }
}

function requiresSubmissionAdmission(task: {
  spec: { kind: string; target?: { kind: string } };
}) {
  return (
    task.spec.kind === 'run-agent-instruction' &&
    (task.spec.target?.kind === 'agent' ||
      task.spec.target?.kind === 'agent-session')
  );
}

async function recoverScheduledInstructionSubmissions(
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
) {
  const activeRuns = await listActiveScheduledInstructionRuns(paths);
  for (const run of activeRuns) {
    if (run.submissionId && run.sessionId) {
      watchScheduledInstructionSettlement(
        { submissionId: run.submissionId, sessionId: run.sessionId },
        paths,
        dependencies,
      );
      continue;
    }
    if (!run.dispatchKey || !run.dispatchPayload || !run.sessionId) {
      await recordScheduledTaskAdmissionRetry(
        {
          runId: run.id,
          message: 'The persisted scheduled instruction outbox is incomplete.',
        },
        paths,
      );
      continue;
    }
    try {
      const admitted = await dispatchPreparedInstruction(
        {
          idempotencyKey: run.dispatchKey,
          payload: run.dispatchPayload,
          sessionId: run.sessionId,
        },
        dependencies,
      );
      await attachScheduledTaskSubmissionId(
        {
          runId: run.id,
          submissionId: admitted.submissionId,
          sessionId: admitted.sessionId,
          result: {
            submissionId: admitted.submissionId,
            sessionId: admitted.sessionId,
          },
        },
        paths,
      );
      watchScheduledInstructionSettlement(
        {
          submissionId: admitted.submissionId,
          sessionId: admitted.sessionId,
        },
        paths,
        dependencies,
      );
    } catch (error) {
      await recordScheduledTaskAdmissionRetry(
        { runId: run.id, message: errorMessage(error) },
        paths,
      );
    }
  }
}

function dispatchPreparedInstruction(
  input: {
    idempotencyKey: string;
    payload: { prompt: string; taskId: string };
    sessionId: string;
  },
  dependencies: SchedulerDependencies,
) {
  return dependencies.dispatchInstruction
    ? dependencies.dispatchInstruction({
        idempotencyKey: input.idempotencyKey,
        prompt: input.payload.prompt,
        sessionId: input.sessionId,
        taskId: input.payload.taskId,
      })
    : dispatchScheduledInstruction(input);
}

function watchScheduledInstructionSettlement(
  input: { submissionId: string; sessionId: string },
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
) {
  if (
    dependencies.dispatchInstruction &&
    !dependencies.readInstructionSettlement
  )
    return;
  const key = `${paths.home}\n${input.submissionId}`;
  if (scheduledSettlementWatchers.has(key)) return;
  const readSettlement =
    dependencies.readInstructionSettlement ??
    readScheduledInstructionSettlement;
  const watcher = readSettlement(input)
    .then((settlement) =>
      settleScheduledTaskSubmission(
        { submissionId: input.submissionId, failed: settlement.failed },
        paths,
      ),
    )
    .catch((error) => {
      console.warn(
        '[neondeck] scheduled instruction settlement watch failed',
        error,
      );
    })
    .finally(() => {
      scheduledSettlementWatchers.delete(key);
    });
  scheduledSettlementWatchers.set(key, watcher);
}

function settlementWatchers() {
  return (globalThis.__neondeckScheduledSettlementWatchers ??= new Map());
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
