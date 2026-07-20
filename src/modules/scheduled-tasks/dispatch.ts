import { dispatch, type JsonValue } from '@flue/runtime';
import type { NotificationLevel } from '../app-state';
import type { RuntimePaths } from '../../runtime-home';
import { loadRuntimeSkill } from '../runtime';
import { refreshWatchTask } from '../scheduler/dispatch';
import type { SchedulerDependencies } from '../scheduler/schemas';
import { invokeScheduledWorkflow } from '../scheduler/workflow-invocation';
import { isAutopilotSetupBlocked } from '../autopilot/setup-transactions';
import type { ScheduledTaskRecord } from './schemas';

export type ScheduledTaskExecutionResult = {
  outcome: 'recorded' | 'silent' | 'failed';
  message: string;
  result?: unknown;
  workflowRunId?: string;
  sessionId?: string;
  notifications?: Array<{
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  }>;
};

export async function executeScheduledTask(
  task: ScheduledTaskRecord,
  previousResult: JsonValue | null,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies = {},
): Promise<ScheduledTaskExecutionResult> {
  if (task.spec.kind === 'poll-pr-watch') {
    if (await isAutopilotSetupBlocked(task.spec.watchId, paths)) {
      return {
        outcome: 'silent',
        message: `Watch ${task.spec.watchId} is waiting for Autopilot setup recovery.`,
      };
    }
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
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('briefing', {
      profileId: task.spec.briefingId,
      taskId: task.id,
    });
    return {
      outcome: 'recorded',
      message: `Admitted briefing workflow ${runId}.`,
      workflowRunId: runId,
      result: { runId, briefingId: task.spec.briefingId },
    };
  }

  const prompt = await composeInstructionPrompt(task, paths);
  if (task.spec.target.kind === 'workflow') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('scheduled-agent-instruction', {
      prompt,
    });
    return {
      outcome: 'recorded',
      message: `Admitted scheduled instruction workflow ${runId}.`,
      workflowRunId: runId,
      result: { runId },
    };
  }

  const receipt = await dispatch({
    agent: 'display-assistant',
    id: task.spec.target.sessionId,
    input: prompt,
  });
  return {
    outcome: 'recorded',
    message: `Dispatched scheduled instruction to session ${task.spec.target.sessionId}.`,
    sessionId: task.spec.target.sessionId,
    result: { dispatchId: receipt.dispatchId, acceptedAt: receipt.acceptedAt },
  };
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
