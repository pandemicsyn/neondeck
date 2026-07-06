import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { listWorkflowSummaries } from '../app-state';
import { runNeonCommand } from './runner';
import { supportedCommands } from './registry';
import {
  commandActionOutputSchema,
  commandRunInputSchema,
  commandRunOutputSchema,
} from './schemas';

export const commandRunAction = defineAction({
  name: 'neondeck_command_run',
  description:
    'Run a Neon slash command such as /repo-status, /review-queue, /review-pr, /explain-ci, /summarize-pr, /draft-pr-description, /prepare-pr, /review-local, /briefing, /reasoning, /memory, /watch-pr, /watch-release, or /dev-doctor and persist a workflow summary.',
  input: commandRunInputSchema,
  output: commandRunOutputSchema,
  async run({ input, log }) {
    log.info('Neon command requested', { command: input.command });

    const result = await runNeonCommand(input);
    const payload = {
      status: result.status,
      ok: result.ok,
      command: result.command,
      message: result.message,
      workflowSummaryId: result.workflowSummary?.id ?? null,
    };
    if (result.ok) {
      log.info('Neon command completed', payload);
    } else {
      log.warn('Neon command failed', payload);
    }

    return result;
  },
});

export const commandsListAction = defineAction({
  name: 'neondeck_commands_list',
  description: 'List supported Neon slash commands.',
  input: v.object({}),
  output: commandActionOutputSchema,
  async run() {
    return {
      ok: true,
      action: 'commands_list',
      changed: false,
      commands: supportedCommands(),
    };
  },
});

export const workflowSummariesListAction = defineAction({
  name: 'neondeck_workflow_summaries_list',
  description:
    'List recently persisted Neondeck workflow and command summaries for follow-up questions.',
  input: v.object({}),
  output: commandActionOutputSchema,
  async run() {
    return {
      ok: true,
      action: 'workflow_summaries_list',
      changed: false,
      summaries: await listWorkflowSummaries(),
    };
  },
});

export const neondeckCommandActions = [
  commandRunAction,
  commandsListAction,
  workflowSummariesListAction,
];
