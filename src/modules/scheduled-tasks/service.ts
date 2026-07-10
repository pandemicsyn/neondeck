import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import {
  automationTriggerSchema,
  nonEmptyStringSchema,
  scheduledTaskSpecSchema,
} from './schemas';
import {
  deleteScheduledTask,
  listScheduledTasks,
  readLatestScheduledTaskRun,
  readScheduledTask,
  setScheduledTaskEnabled,
  upsertScheduledTask,
} from './store';
import * as v from 'valibot';

const agentTargetSchema = v.variant('kind', [
  v.object({ kind: v.literal('workflow') }),
  v.object({
    kind: v.literal('agent-session'),
    sessionId: nonEmptyStringSchema,
  }),
]);

export const briefingTaskInputSchema = v.object({
  id: nonEmptyStringSchema,
  trigger: automationTriggerSchema,
  enabled: v.optional(v.boolean()),
});

export const agentInstructionTaskInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(8_000)),
  trigger: automationTriggerSchema,
  target: v.optional(agentTargetSchema),
  repoId: v.optional(nonEmptyStringSchema),
  cwd: v.optional(nonEmptyStringSchema),
  skills: v.optional(v.array(nonEmptyStringSchema)),
  enabled: v.optional(v.boolean()),
});

export const scheduledTaskIdInputSchema = v.object({
  id: nonEmptyStringSchema,
});

export type ScheduledTaskActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  task?: ReturnType<typeof asJsonValue>;
  tasks?: ReturnType<typeof asJsonValue>[];
  run?: ReturnType<typeof asJsonValue>;
  errors?: string[];
  requires?: string[];
};

export async function createBriefingTask(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ScheduledTaskActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(briefingTaskInputSchema, rawInput);
  if (!parsed.success)
    return invalidResult('scheduled_task_briefing_create', parsed);
  try {
    const task = await upsertScheduledTask(
      {
        id: `briefing:${parsed.output.id}`,
        spec: { kind: 'run-briefing', briefingId: parsed.output.id },
        trigger: parsed.output.trigger,
        enabled: parsed.output.enabled,
      },
      paths,
    );
    return success(
      'scheduled_task_briefing_create',
      task,
      'Created briefing task.',
    );
  } catch (error) {
    return failure('scheduled_task_briefing_create', error);
  }
}

export async function createAgentInstructionTask(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ScheduledTaskActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(agentInstructionTaskInputSchema, rawInput);
  if (!parsed.success) {
    return invalidResult('scheduled_task_instruction_create', parsed);
  }
  const input = parsed.output;
  try {
    const task = await upsertScheduledTask(
      {
        id: input.id ?? `instruction:${randomUUID()}`,
        spec: v.parse(scheduledTaskSpecSchema, {
          kind: 'run-agent-instruction',
          prompt: input.prompt,
          target: input.target ?? { kind: 'workflow' },
          ...(input.repoId ? { repoId: input.repoId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          skills: input.skills ?? [],
        }),
        trigger: input.trigger,
        enabled: input.enabled,
      },
      paths,
    );
    return success(
      'scheduled_task_instruction_create',
      task,
      'Created agent-instruction task.',
    );
  } catch (error) {
    return failure('scheduled_task_instruction_create', error);
  }
}

export async function listTaskRecords(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const tasks = await listScheduledTasks(paths);
  return {
    ok: true,
    action: 'scheduled_task_list',
    changed: false,
    message: 'Listed scheduled tasks.',
    tasks: await Promise.all(
      tasks.map(async (task) => ({
        ...task,
        lastRun: await readLatestScheduledTaskRun(task.id, paths),
      })),
    ),
  } as const;
}

export async function readTaskRecord(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const task = await readScheduledTask(id, paths);
  if (!task) {
    return {
      ok: false,
      action: 'scheduled_task_read',
      changed: false,
      message: `Scheduled task "${id}" was not found.`,
    } as const;
  }
  return {
    ok: true,
    action: 'scheduled_task_read',
    changed: false,
    message: `Read scheduled task "${id}".`,
    task,
    run: await readLatestScheduledTaskRun(id, paths),
  } as const;
}

export async function setTaskEnabled(
  id: string,
  enabled: boolean,
  paths = runtimePaths(),
) {
  const task = await setScheduledTaskEnabled(id, enabled, paths);
  if (!task) {
    return {
      ok: false,
      action: 'scheduled_task_enabled_update',
      changed: false,
      message: `Scheduled task "${id}" was not found.`,
    } as const;
  }
  return success(
    'scheduled_task_enabled_update',
    task,
    `${enabled ? 'Enabled' : 'Paused'} scheduled task "${id}".`,
  );
}

export async function removeTask(id: string, paths = runtimePaths()) {
  const task = await readScheduledTask(id, paths);
  if (!task) {
    return {
      ok: false,
      action: 'scheduled_task_delete',
      changed: false,
      message: `Scheduled task "${id}" was not found.`,
    } as const;
  }
  await deleteScheduledTask(id, paths);
  return success(
    'scheduled_task_delete',
    task,
    `Deleted scheduled task "${id}".`,
  );
}

function success(
  action: string,
  task: unknown,
  message: string,
): ScheduledTaskActionResult {
  return { ok: true, action, changed: true, message, task: asJsonValue(task) };
}

function invalidResult(
  action: string,
  parsed: { issues?: v.BaseIssue<unknown>[] },
): ScheduledTaskActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: 'Invalid scheduled task input.',
    errors:
      parsed.issues && parsed.issues.length > 0
        ? [
            v.summarize(
              parsed.issues as [
                v.BaseIssue<unknown>,
                ...v.BaseIssue<unknown>[],
              ],
            ),
          ]
        : undefined,
  };
}

function failure(action: string, error: unknown): ScheduledTaskActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: error instanceof Error ? error.message : String(error),
  };
}
