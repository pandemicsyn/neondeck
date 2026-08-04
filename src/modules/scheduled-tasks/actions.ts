import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  agentInstructionTaskInputSchema,
  briefingTaskInputSchema,
  createAgentInstructionTask,
  createBriefingTask,
  listTaskRecords,
  readTaskRecord,
  removeTask,
  scheduledTaskIdInputSchema,
  setTaskEnabled,
} from './service';

const actionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const scheduledBriefingTaskCreateAction = defineTool({
  name: 'neondeck_scheduled_task_briefing_create',
  description: 'Create or update a timezone-aware scheduled briefing task.',
  input: briefingTaskInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return { output: await createBriefingTask(input) };
  },
});

export const scheduledInstructionTaskCreateAction = defineTool({
  name: 'neondeck_scheduled_task_instruction_create',
  description:
    'Create or update a scheduled bounded agent instruction. Use an agent-session target only when continuity is explicitly required.',
  input: agentInstructionTaskInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return { output: await createAgentInstructionTask(input) };
  },
});

export const scheduledTaskListAction = defineTool({
  name: 'neondeck_scheduled_task_list',
  description: 'List canonical scheduled tasks and their most recent run.',
  input: v.object({}),
  output: actionOutputSchema,
  async run() {
    return { output: await listTaskRecords() };
  },
});

export const scheduledTaskReadAction = defineTool({
  name: 'neondeck_scheduled_task_read',
  description: 'Read one canonical scheduled task and its most recent run.',
  input: scheduledTaskIdInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return { output: await readTaskRecord(input.id) };
  },
});

export const scheduledTaskPauseAction = defineTool({
  name: 'neondeck_scheduled_task_pause',
  description: 'Pause a scheduled task without deleting its run history.',
  input: scheduledTaskIdInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return { output: await setTaskEnabled(input.id, false) };
  },
});

export const scheduledTaskResumeAction = defineTool({
  name: 'neondeck_scheduled_task_resume',
  description: 'Resume a scheduled task without immediately executing it.',
  input: scheduledTaskIdInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return { output: await setTaskEnabled(input.id, true) };
  },
});

export const scheduledTaskDeleteAction = defineTool({
  name: 'neondeck_scheduled_task_delete',
  description: 'Delete a scheduled task and its local run history.',
  input: v.object({
    id: scheduledTaskIdInputSchema.entries.id,
    confirm: v.optional(v.boolean()),
  }),
  output: actionOutputSchema,
  async run({ data: input }) {
    if (input.confirm !== true) {
      return {
        output: {
          ok: false,
          action: 'scheduled_task_delete',
          changed: false,
          message: 'Deleting a scheduled task requires confirmation.',
          requires: ['confirm'],
        },
      };
    }
    return { output: await removeTask(input.id) };
  },
});

export const neondeckScheduledTaskActions = [
  scheduledBriefingTaskCreateAction,
  scheduledInstructionTaskCreateAction,
  scheduledTaskListAction,
  scheduledTaskReadAction,
  scheduledTaskPauseAction,
  scheduledTaskResumeAction,
  scheduledTaskDeleteAction,
];
