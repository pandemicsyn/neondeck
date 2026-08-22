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
  readScheduledTaskRun,
  readScheduledInstructionSettlement,
  recordScheduledTaskAdmissionRetry,
  releaseUnstartedScheduledTaskClaim,
  settleScheduledTaskRun,
  settleScheduledTaskSubmission,
  collectScheduledWorkspaceResult,
  invalidateScheduledWorkspaceRun,
  failScheduledWorkspaceRun,
  listRecoverableScheduledWorkspaceCleanups,
  listStrandedScheduledWorkspaces,
  reconcileExpiredTerminalCollectionOwners,
  recoverAbandonedScheduledWorkspace,
  recoverOrphanedScheduledWorktreeProvisions,
  retainTaskWorkspace,
  renewTaskWorkspaceLock,
  addScheduledRunArtifact,
  fenceTaskWorkspacePhysicalRelease,
  quarantinePhysicalWorkspace,
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
    await recoverOrphanedScheduledWorktreeProvisions(paths);
    await recoverScheduledWorkspaceCleanups(paths);
    await recoverStrandedScheduledWorkspaceRuns(paths);
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
      let preparedInstruction:
        | Awaited<ReturnType<typeof prepareScheduledInstructionDispatch>>
        | undefined;
      let admissionOutboxPrepared = false;
      try {
        const submissionTask = requiresSubmissionAdmission(task);
        if (
          submissionTask &&
          !(await canAdmitScheduledSubmission(
            task.id,
            paths,
            undefined,
            task.spec.kind === 'run-agent-instruction' &&
              task.spec.workspace?.kind === 'repository' &&
              task.spec.workspace.overlap === 'allow-parallel',
          ))
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
          preparedInstruction = prepared;
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
              ...(prepared.payload.workspaceId
                ? { workspaceId: prepared.payload.workspaceId }
                : {}),
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
          if (submissionTask && result.sessionId && preparedInstruction) {
            watchScheduledInstructionSettlement(
              {
                submissionId: result.submissionId,
                sessionId: result.sessionId,
                workspaceId: preparedInstruction.payload.workspaceId,
                runId: run.id,
                lockOwner: preparedInstruction.payload.lockOwner,
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
        if (
          preparedInstruction?.payload.workspaceId &&
          preparedInstruction.payload.runId &&
          preparedInstruction.payload.lockOwner
        ) {
          await collectScheduledWorkspaceResult(
            {
              runId: preparedInstruction.payload.runId,
              workspaceId: preparedInstruction.payload.workspaceId,
              lockOwner: preparedInstruction.payload.lockOwner,
              response: message,
              failed: true,
            },
            paths,
          );
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
        {
          submissionId: run.submissionId,
          sessionId: run.sessionId,
          workspaceId: run.dispatchPayload?.workspaceId,
          runId: run.id,
          lockOwner: run.dispatchPayload?.lockOwner,
        },
        paths,
        dependencies,
      );
      continue;
    }
    if (!run.dispatchKey || !run.dispatchPayload || !run.sessionId) {
      await terminalizeScheduledWorkspaceRun(
        run,
        'The persisted scheduled instruction outbox is incomplete.',
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
            ...(run.dispatchPayload.workspaceId
              ? { workspaceId: run.dispatchPayload.workspaceId }
              : {}),
          },
        },
        paths,
      );
      watchScheduledInstructionSettlement(
        {
          submissionId: admitted.submissionId,
          sessionId: admitted.sessionId,
          workspaceId: run.dispatchPayload.workspaceId,
          runId: run.id,
          lockOwner: run.dispatchPayload.lockOwner,
        },
        paths,
        dependencies,
      );
    } catch (error) {
      if (Date.now() - Date.parse(run.startedAt) >= 10 * 60_000) {
        await terminalizeScheduledWorkspaceRun(
          run,
          `Scheduled instruction admission exhausted its retry window: ${errorMessage(error)}`,
          paths,
        );
      } else {
        await recordScheduledTaskAdmissionRetry(
          { runId: run.id, message: errorMessage(error) },
          paths,
        );
      }
    }
  }
}

async function recoverScheduledWorkspaceCleanups(paths: RuntimePaths) {
  for (const workspace of await listRecoverableScheduledWorkspaceCleanups(
    paths,
  )) {
    try {
      await recoverAbandonedScheduledWorkspace(workspace.id, paths);
    } catch (error) {
      console.warn(
        `[neondeck] failed to reconcile expired cleanup lease for workspace ${workspace.id}`,
        error,
      );
    }
  }
}

async function recoverStrandedScheduledWorkspaceRuns(paths: RuntimePaths) {
  await reconcileExpiredTerminalCollectionOwners(paths);
  for (const { workspace } of await listStrandedScheduledWorkspaces(paths)) {
    const runId = workspace.owningRunId;
    if (!runId) continue;
    const message =
      'Recovered a scheduled workspace whose run never reached active dispatch; its workspace lifecycle was reconciled.';
    if (workspace.providerId !== 'local' && workspace.lockOwner) {
      const fenced = await fenceTaskWorkspacePhysicalRelease(
        {
          workspaceId: workspace.id,
          runId,
          lockOwner: workspace.lockOwner,
        },
        paths,
      );
      if (!fenced) {
        throw new Error(
          `Could not fence inherited remote workspace lease for ${workspace.id}.`,
        );
      }
      await quarantinePhysicalWorkspace(
        {
          physicalResourceKey: workspace.physicalResourceKey,
          providerId: workspace.providerId,
          source: 'scheduled-run',
          sourceId: runId,
          reason:
            'Restart recovery inherited a remote lease without confirmed operation settlement.',
        },
        paths,
      );
    }
    if (workspace.lockOwner) {
      await failScheduledWorkspaceRun(
        {
          runId,
          workspaceId: workspace.id,
          lockOwner: workspace.lockOwner,
          message,
        },
        paths,
      );
    } else if (workspace.lifecycle === 'existing') {
      await retainTaskWorkspace(
        workspace.id,
        runId,
        'Recovered an abandoned adopted workspace without deleting provider infrastructure.',
        paths,
      );
    } else {
      await recoverAbandonedScheduledWorkspace(workspace.id, paths);
    }
    const run = await readScheduledTaskRun(runId, paths);
    if (!run || !['claimed', 'active'].includes(run.status)) continue;
    const task = await readScheduledTask(run.taskId, paths);
    await settleScheduledTaskRun(
      {
        taskId: run.taskId,
        runId: run.id,
        claimId: task?.claimId ?? '',
        status: 'failed',
        outcome: 'failed',
        message,
        error: message,
      },
      paths,
    );
  }
}

async function terminalizeScheduledWorkspaceRun(
  run: Awaited<ReturnType<typeof readScheduledTaskRun>> & {},
  message: string,
  paths: RuntimePaths,
) {
  if (!run) return;
  const payload = run.dispatchPayload;
  if (payload?.workspaceId && payload.runId && payload.lockOwner) {
    await failScheduledWorkspaceRun(
      {
        runId: payload.runId,
        workspaceId: payload.workspaceId,
        lockOwner: payload.lockOwner,
        message,
      },
      paths,
    );
  }
  const task = await readScheduledTask(run.taskId, paths);
  await settleScheduledTaskRun(
    {
      taskId: run.taskId,
      runId: run.id,
      claimId: task?.claimId ?? '',
      status: 'failed',
      outcome: 'failed',
      message,
      error: message,
    },
    paths,
  );
}

function dispatchPreparedInstruction(
  input: {
    idempotencyKey: string;
    payload: {
      prompt: string;
      taskId: string;
      runId?: string;
      workspaceId?: string;
      cwd?: string;
      lockOwner?: string;
    };
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
        runId: input.payload.runId,
        workspaceId: input.payload.workspaceId,
        cwd: input.payload.cwd,
        lockOwner: input.payload.lockOwner,
      })
    : dispatchScheduledInstruction(input);
}

function watchScheduledInstructionSettlement(
  input: {
    submissionId: string;
    sessionId: string;
    workspaceId?: string;
    runId?: string;
    lockOwner?: string;
  },
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
  const stopWorkspaceHeartbeat =
    input.workspaceId && input.runId && input.lockOwner
      ? startScheduledWorkspaceHeartbeat(
          {
            workspaceId: input.workspaceId,
            runId: input.runId,
            owner: input.lockOwner,
          },
          paths,
        )
      : () => undefined;
  const watcher = readSettlement(input)
    .then(async (settlement) => {
      if (input.workspaceId && input.runId && input.lockOwner) {
        const collected = await collectScheduledWorkspaceResult(
          {
            runId: input.runId,
            workspaceId: input.workspaceId,
            lockOwner: input.lockOwner,
            response: settlement.response,
            failed: settlement.failed,
          },
          paths,
        );
        if (!collected) return;
      }
      if (!input.workspaceId && settlement.response !== undefined) {
        await addScheduledRunArtifact(
          {
            runId: input.runId ?? '',
            workspaceId: null,
            kind: 'response',
            summary: 'Final agent response',
            content: settlement.response,
            truncated: false,
          },
          paths,
        );
      }
      await settleScheduledTaskSubmission(
        {
          submissionId: input.submissionId,
          failed: settlement.failed,
          response: settlement.response,
        },
        paths,
      );
    })
    .catch(async (error) => {
      const message = `Scheduled instruction settlement failed: ${errorMessage(error)}`;
      if (input.workspaceId && input.runId && input.lockOwner) {
        await failScheduledWorkspaceRun(
          {
            runId: input.runId,
            workspaceId: input.workspaceId,
            lockOwner: input.lockOwner,
            message,
          },
          paths,
        );
      }
      await settleScheduledTaskSubmission(
        { submissionId: input.submissionId, failed: true },
        paths,
      );
      console.warn(
        '[neondeck] scheduled instruction settlement watch failed',
        error,
      );
    })
    .finally(() => {
      stopWorkspaceHeartbeat();
      if (input.workspaceId && input.runId) {
        invalidateScheduledWorkspaceRun({
          workspaceId: input.workspaceId,
          runId: input.runId,
        });
      }
      scheduledSettlementWatchers.delete(key);
    });
  scheduledSettlementWatchers.set(key, watcher);
}

function startScheduledWorkspaceHeartbeat(
  input: { workspaceId: string; runId: string; owner: string },
  paths: RuntimePaths,
) {
  const renew = () => {
    void renewTaskWorkspaceLock(input, paths)
      .then((renewed) => {
        if (!renewed) {
          clearInterval(timer);
          invalidateScheduledWorkspaceRun(input);
        }
      })
      .catch((error) => {
        clearInterval(timer);
        invalidateScheduledWorkspaceRun(input);
        console.warn(
          '[neondeck] scheduled workspace lease renewal failed',
          error,
        );
      });
  };
  const timer = setInterval(renew, 60_000);
  timer.unref?.();
  renew();
  return () => clearInterval(timer);
}

function settlementWatchers() {
  const target = globalThis as typeof globalThis & {
    __neondeckScheduledSettlementWatchers?: Map<string, Promise<void>>;
  };
  return (target.__neondeckScheduledSettlementWatchers ??= new Map());
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
