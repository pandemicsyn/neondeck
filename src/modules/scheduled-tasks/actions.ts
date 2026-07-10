import { defineAction } from '@flue/runtime';
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

export const scheduledBriefingTaskCreateAction = defineAction({
  name: 'neondeck_scheduled_task_briefing_create',
  description: 'Create or update a timezone-aware scheduled briefing task.',
  input: briefingTaskInputSchema,
  output: actionOutputSchema,
  async run({ input }) {
    return createBriefingTask(input);
  },
});

export const scheduledInstructionTaskCreateAction = defineAction({
  name: 'neondeck_scheduled_task_instruction_create',
  description:
    'Create or update a scheduled bounded agent instruction. Use an agent-session target only when continuity is explicitly required.',
  input: agentInstructionTaskInputSchema,
  output: actionOutputSchema,
  async run({ input }) {
    return createAgentInstructionTask(input);
  },
});

export const scheduledTaskListAction = defineAction({
  name: 'neondeck_scheduled_task_list',
  description: 'List canonical scheduled tasks and their most recent run.',
  input: v.object({}),
  output: actionOutputSchema,
  async run() {
    return listTaskRecords();
  },
});

export const scheduledTaskReadAction = defineAction({
  name: 'neondeck_scheduled_task_read',
  description: 'Read one canonical scheduled task and its most recent run.',
  input: scheduledTaskIdInputSchema,
  output: actionOutputSchema,
  async run({ input }) {
    return readTaskRecord(input.id);
  },
});

export const scheduledTaskPauseAction = defineAction({
  name: 'neondeck_scheduled_task_pause',
  description: 'Pause a scheduled task without deleting its run history.',
  input: scheduledTaskIdInputSchema,
  output: actionOutputSchema,
  async run({ input }) {
    return setTaskEnabled(input.id, false);
  },
});

export const scheduledTaskResumeAction = defineAction({
  name: 'neondeck_scheduled_task_resume',
  description: 'Resume a scheduled task without immediately executing it.',
  input: scheduledTaskIdInputSchema,
  output: actionOutputSchema,
  async run({ input }) {
    return setTaskEnabled(input.id, true);
  },
});

export const scheduledTaskDeleteAction = defineAction({
  name: 'neondeck_scheduled_task_delete',
  description: 'Delete a scheduled task and its local run history.',
  input: v.object({
    id: scheduledTaskIdInputSchema.entries.id,
    confirm: v.optional(v.boolean()),
  }),
  output: actionOutputSchema,
  async run({ input }) {
    if (input.confirm !== true) {
      return {
        ok: false,
        action: 'scheduled_task_delete',
        changed: false,
        message: 'Deleting a scheduled task requires confirmation.',
        requires: ['confirm'],
      };
    }
    return removeTask(input.id);
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
