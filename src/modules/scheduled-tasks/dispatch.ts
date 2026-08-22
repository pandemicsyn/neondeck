import { AgentRunError, dispatch, init, type JsonValue } from '@flue/runtime';
import type { NotificationLevel, NotificationRecord } from '../app-state';
import type { RuntimePaths } from '../../runtime-home';
import { selectedRuntimeSkillSessionSnapshotsSync } from '../runtime';
import { refreshWatchTask } from '../scheduler/dispatch';
import type { SchedulerDependencies } from '../scheduler/schemas';
import type { ScheduledTaskRecord } from './schemas';
import { prepareScheduledWorkspace } from './workspace-service';

export type ScheduledTaskExecutionResult = {
  outcome: 'recorded' | 'silent' | 'failed';
  message: string;
  result?: unknown;
  submissionId?: string;
  sessionId?: string;
  notifications?: Array<{
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  }>;
  persistedNotifications?: NotificationRecord[];
};

export async function executeScheduledTask(
  task: ScheduledTaskRecord,
  previousResult: JsonValue | null,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies = {},
): Promise<ScheduledTaskExecutionResult> {
  if (task.spec.kind === 'poll-pr-watch') {
    const result = await refreshWatchTask(
      task.spec.watchId,
      previousResult,
      paths,
      dependencies,
    );
    return {
      ...result,
      outcome: result.outcome === 'updated' ? 'recorded' : result.outcome,
    };
  }

  if (task.spec.kind === 'run-briefing') {
    const admit =
      dependencies.admitBriefing ??
      (await import('../briefings/service')).admitBriefing;
    const run = await admit(
      {
        profileId: task.spec.briefingId,
        trigger: 'scheduled',
        scheduledTaskRunId: dependencies.scheduledTaskRunId,
      },
      paths,
    );
    if (!run.dispatchId) {
      throw new Error('Briefing submission was not recorded.');
    }
    return {
      outcome: 'recorded',
      message: `Admitted briefing ${run.id}.`,
      submissionId: run.dispatchId,
      sessionId: run.sessionId,
      result: {
        briefingRunId: run.id,
        submissionId: run.dispatchId,
        briefingId: task.spec.briefingId,
      },
    };
  }

  const prepared = await prepareScheduledInstructionDispatch(
    task,
    `scheduled-task:${task.id}:${task.claimId ?? task.lastRunAt ?? task.updatedAt}`,
    paths,
  );
  const admitted = dependencies.dispatchInstruction
    ? await dependencies.dispatchInstruction({
        idempotencyKey: prepared.idempotencyKey,
        prompt: prepared.payload.prompt,
        sessionId: prepared.sessionId,
        taskId: prepared.payload.taskId,
      })
    : await dispatchScheduledInstruction(prepared);
  return {
    outcome: 'recorded',
    message: `Dispatched scheduled instruction to session ${admitted.sessionId}.`,
    submissionId: admitted.submissionId,
    sessionId: admitted.sessionId,
    result: {
      submissionId: admitted.submissionId,
      sessionId: admitted.sessionId,
    },
  };
}

export async function prepareScheduledInstructionDispatch(
  task: ScheduledTaskRecord,
  idempotencyKey: string,
  paths: RuntimePaths,
) {
  const preparedPrompt = composeInstructionPrompt(task, paths);
  const workspace = await prepareScheduledWorkspace(
    task,
    idempotencyKey,
    paths,
  );
  return {
    idempotencyKey,
    sessionId: workspace
      ? task.spec.kind === 'run-agent-instruction' &&
        task.spec.target.kind === 'agent-session'
        ? `scheduled-workspace-session:${task.spec.target.sessionId}:${task.id}`
        : `scheduled-workspace:${idempotencyKey}`
      : task.spec.kind === 'run-agent-instruction' &&
          task.spec.target.kind === 'agent-session'
        ? task.spec.target.sessionId
        : `scheduled-instruction:${idempotencyKey}`,
    payload: {
      prompt: preparedPrompt.prompt,
      taskId: task.id,
      skillSnapshots: preparedPrompt.skillSnapshots,
      ...(workspace
        ? {
            runId: idempotencyKey,
            workspaceId: workspace.workspace.id,
            cwd: workspace.cwd,
            lockOwner: workspace.lockOwner,
          }
        : {}),
    },
  };
}

export async function dispatchScheduledInstruction(input: {
  idempotencyKey: string;
  sessionId: string;
  payload: {
    prompt: string;
    taskId: string;
    runId?: string;
    workspaceId?: string;
    cwd?: string;
    lockOwner?: string;
  };
}) {
  const agent = input.payload.workspaceId
    ? (await import('../../agents/scheduled-task-worker')).ScheduledTaskWorker
    : (await import('../../agents/display-assistant')).DisplayAssistant;
  const receipt = await dispatch(agent, {
    id: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    message: {
      kind: 'signal',
      type: input.payload.workspaceId
        ? 'neondeck.scheduled-workspace-instruction'
        : 'neondeck.scheduled-instruction',
      tagName: 'scheduled-instruction',
      body: input.payload.prompt,
      attributes: {
        taskId: input.payload.taskId,
        ...(input.payload.workspaceId
          ? {
              workspaceId: input.payload.workspaceId,
              runId: input.payload.runId as string,
              cwd: input.payload.cwd as string,
            }
          : {}),
      },
    },
  });
  return {
    submissionId: receipt.submissionId,
    sessionId: input.sessionId,
  };
}

export async function readScheduledInstructionSettlement(input: {
  sessionId: string;
  submissionId: string;
  workspaceId?: string;
}) {
  const agent = input.workspaceId
    ? (await import('../../agents/scheduled-task-worker')).ScheduledTaskWorker
    : (await import('../../agents/display-assistant')).DisplayAssistant;
  const handle = init(agent, { id: input.sessionId });
  try {
    const reply = await handle.read(input.submissionId);
    return { failed: false, response: reply.text };
  } catch (error) {
    if (error instanceof AgentRunError) return { failed: true };
    throw error;
  }
}

function composeInstructionPrompt(
  task: ScheduledTaskRecord,
  paths: RuntimePaths,
) {
  if (task.spec.kind !== 'run-agent-instruction') {
    throw new Error(`Task "${task.id}" is not an agent instruction.`);
  }
  const context = [
    'This is a bounded scheduled Neondeck instruction. Complete the requested work, report concrete results, and do not schedule follow-up work yourself.',
    task.spec.workspace?.kind === 'repository'
      ? `Repository id: ${task.spec.workspace.repoId}`
      : task.spec.repoId
        ? `Repository id: ${task.spec.repoId}`
        : null,
    task.spec.workspace?.kind === 'repository'
      ? task.spec.workspace.subdirectory
        ? `Repository subdirectory: ${task.spec.workspace.subdirectory}`
        : null
      : task.spec.cwd
        ? `Requested working directory: ${task.spec.cwd}`
        : null,
  ].filter((line): line is string => Boolean(line));
  const skillSnapshots = selectedRuntimeSkillSessionSnapshotsSync(
    task.spec.skills,
    paths,
  );
  return {
    prompt: `${context.join('\n')}\n\nInstruction:\n${task.spec.prompt}`,
    skillSnapshots,
  };
}
