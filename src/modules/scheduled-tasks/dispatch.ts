import { AgentRunError, dispatch, init, type JsonValue } from '@flue/runtime';
import type { NotificationLevel, NotificationRecord } from '../app-state';
import type { RuntimePaths } from '../../runtime-home';
import { loadRuntimeSkill } from '../runtime';
import { refreshWatchTask } from '../scheduler/dispatch';
import type { SchedulerDependencies } from '../scheduler/schemas';
import type { ScheduledTaskRecord } from './schemas';

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
      },
      paths,
    );
    if (!run.dispatchId) {
      throw new Error('Briefing submission was not recorded.');
    }
    return {
      outcome: 'recorded',
      message: `Admitted briefing ${run.id}.`,
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
  const prompt = await composeInstructionPrompt(task, paths);
  return {
    idempotencyKey,
    sessionId:
      task.spec.kind === 'run-agent-instruction' &&
      task.spec.target.kind === 'agent-session'
        ? task.spec.target.sessionId
        : `scheduled-instruction:${idempotencyKey}`,
    payload: { prompt, taskId: task.id },
  };
}

export async function dispatchScheduledInstruction(input: {
  idempotencyKey: string;
  sessionId: string;
  payload: { prompt: string; taskId: string };
}) {
  const { DisplayAssistant } = await import('../../agents/display-assistant');
  const receipt = await dispatch(DisplayAssistant, {
    id: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    message: {
      kind: 'signal',
      type: 'neondeck.scheduled-instruction',
      tagName: 'scheduled-instruction',
      body: input.payload.prompt,
      attributes: { taskId: input.payload.taskId },
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
}) {
  const { DisplayAssistant } = await import('../../agents/display-assistant');
  const handle = init(DisplayAssistant, { id: input.sessionId });
  try {
    await handle.read(input.submissionId);
    return { failed: false };
  } catch (error) {
    if (error instanceof AgentRunError) return { failed: true };
    throw error;
  }
}

async function composeInstructionPrompt(
  task: ScheduledTaskRecord,
  paths: RuntimePaths,
) {
  if (task.spec.kind !== 'run-agent-instruction') {
    throw new Error(`Task "${task.id}" is not an agent instruction.`);
  }
  const context = [
    'This is a bounded scheduled Neondeck instruction. Complete the requested work, report concrete results, and do not schedule follow-up work yourself.',
    task.spec.repoId ? `Repository id: ${task.spec.repoId}` : null,
    task.spec.cwd ? `Requested working directory: ${task.spec.cwd}` : null,
  ].filter((line): line is string => Boolean(line));
  const skills = [];
  for (const id of task.spec.skills) {
    const loaded = await loadRuntimeSkill({ id }, paths);
    if (!loaded.ok) throw new Error(loaded.error);
    skills.push(`\n\nSkill "${id}":\n${loaded.skill.content}`);
  }
  return `${context.join('\n')}\n\nInstruction:\n${task.spec.prompt}${skills.join('')}`;
}
