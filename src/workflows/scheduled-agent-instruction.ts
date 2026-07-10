import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  input: v.object({ prompt: v.pipe(v.string(), v.minLength(1)) }),
  output: v.object({ response: v.string() }),
  async run({ harness, input }) {
    const session = await harness.session();
    const response = await session.prompt(input.prompt);
    return { response: response.text };
  },
});
