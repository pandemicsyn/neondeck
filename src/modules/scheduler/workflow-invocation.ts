import type { JsonValue } from '@flue/runtime';
import type { ScheduledWorkflowName } from './schemas';

export async function invokeScheduledWorkflow(
  workflow: ScheduledWorkflowName,
  input: JsonValue,
) {
  const { invoke } = await import('@flue/runtime');

  if (workflow === 'scheduled-agent-instruction') {
    const module = await import('../../workflows/scheduled-agent-instruction');
    return invoke(module.default, {
      input: input as { prompt: string },
    });
  }

  const module = await import('../../workflows/command-run');
  return invoke(module.default, {
    input: input as { command: string },
  });
}
