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
  cleanupTaskRunWorkspace,
  scheduledWorkspaceCleanupInputSchema,
  scheduledWorkspaceQuarantineClearInputSchema,
  listScheduledWorkspaceQuarantines,
  clearScheduledWorkspaceQuarantine,
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
    'Create a scheduled bounded agent instruction. Recurring trusted-workspace or delivery-labelled shell authority requires confirm=true after explicit operator approval.',
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

export const scheduledWorkspaceCleanupAction = defineTool({
  name: 'neondeck_scheduled_workspace_cleanup',
  description:
    'Destructively clean up a settled managed scheduled workspace, or detach an adopted existing workspace without deleting its infrastructure. Requires confirm=true.',
  input: scheduledWorkspaceCleanupInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return {
      output: await cleanupTaskRunWorkspace(input.runId, {
        confirm: input.confirm,
      }),
    };
  },
});

export const scheduledWorkspaceQuarantineListAction = defineTool({
  name: 'neondeck_scheduled_workspace_quarantine_list',
  description:
    'List physical remote workspaces blocked because command or mutation settlement is uncertain.',
  input: v.object({}),
  output: actionOutputSchema,
  async run() {
    return { output: await listScheduledWorkspaceQuarantines() };
  },
});

export const scheduledWorkspaceQuarantineClearAction = defineTool({
  name: 'neondeck_scheduled_workspace_quarantine_clear',
  description:
    'Clear one durable remote-workspace quarantine only after the operator confirms no remote process is still mutating it.',
  input: scheduledWorkspaceQuarantineClearInputSchema,
  output: actionOutputSchema,
  async run({ data: input }) {
    return { output: await clearScheduledWorkspaceQuarantine(input) };
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
  scheduledWorkspaceCleanupAction,
  scheduledWorkspaceQuarantineListAction,
  scheduledWorkspaceQuarantineClearAction,
];
