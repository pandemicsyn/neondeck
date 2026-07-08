import type { JsonValue } from '@flue/runtime';
import type { ScheduledWorkflowName } from './schemas';

export async function invokeScheduledWorkflow(
  workflow: ScheduledWorkflowName,
  input: JsonValue,
) {
  const { invoke } = await import('@flue/runtime');

  if (workflow === 'briefing') {
    const module = await import('../../workflows/briefing');
    return invoke(module.default, { input: input as Record<string, never> });
  }

  if (workflow === 'triage-pr-event') {
    const module = await import('../../workflows/triage-pr-event');
    return invoke(module.default, {
      input: input as never,
    });
  }

  const module = await import('../../workflows/command-run');
  return invoke(module.default, {
    input: input as { command: string },
  });
}
