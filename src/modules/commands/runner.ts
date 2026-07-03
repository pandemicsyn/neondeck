import * as v from 'valibot';
import { addWorkflowSummary } from '../../app-state';
import { ensureRuntimeHome, runtimePaths, type RuntimePaths } from '../../runtime-home';
import type { CommandDependencies, NeonCommandResult, ParsedNeonCommand } from './schemas';
import { commandRunInputSchema } from './schemas';
import { parseNeonCommand } from './registry';
import {
  briefingCommand,
  devDoctorCommand,
  draftPrDescriptionCommand,
  explainCiCommand,
  memoryCommand,
  preparePrCommand,
  reasoningCommand,
  repoStatusCommand,
  reviewLocalCommand,
  reviewQueueCommand,
  summarizePrCommand,
  watchPrCommand,
  watchReleaseCommand,
} from './handlers';
import { compactCommandSummary, failedCommand } from './summaries';

export async function runNeonCommand(
  input: v.InferInput<typeof commandRunInputSchema>,
  paths = runtimePaths(),
  dependencies: CommandDependencies = {},
): Promise<NeonCommandResult> {
  await ensureRuntimeHome(paths);
  const parsedInput = v.safeParse(commandRunInputSchema, input);
  if (!parsedInput.success) {
    return failedCommand('repo-status', '', 'Invalid command input.', {
      errors: [v.summarize(parsedInput.issues)],
    });
  }

  const parsed = parseNeonCommand(parsedInput.output.command);
  if (!parsed.ok) {
    return failedCommand(
      'repo-status',
      parsedInput.output.command,
      parsed.error,
      {
        requires: parsed.requires,
      },
    );
  }

  const result = await executeCommand(parsed.command, paths, dependencies);
  const workflowSummary = await addWorkflowSummary(
    {
      workflow: `command:${parsed.command.name}`,
      status: result.status,
      summary: compactCommandSummary(result),
    },
    paths,
  );

  return {
    ...result,
    workflowSummary,
  };
}

async function executeCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  if (command.name === 'repo-status') {
    return repoStatusCommand(command, paths);
  }

  if (command.name === 'review-queue') {
    return reviewQueueCommand(command, paths, dependencies);
  }

  if (command.name === 'explain-ci') {
    return explainCiCommand(command, paths, dependencies);
  }

  if (command.name === 'summarize-pr') {
    return summarizePrCommand(command, paths, dependencies);
  }

  if (command.name === 'draft-pr-description') {
    return draftPrDescriptionCommand(command, paths);
  }

  if (command.name === 'prepare-pr') {
    return preparePrCommand(command, paths);
  }

  if (command.name === 'review-local') {
    return reviewLocalCommand(command, paths);
  }

  if (command.name === 'briefing') {
    return briefingCommand(command, paths, dependencies);
  }

  if (command.name === 'reasoning') {
    return reasoningCommand(command, paths);
  }

  if (command.name === 'memory') {
    return memoryCommand(command, paths);
  }

  if (command.name === 'watch-pr') {
    return watchPrCommand(command, paths);
  }

  if (command.name === 'watch-release') {
    return watchReleaseCommand(command, paths);
  }

  return devDoctorCommand(command, paths);
}
