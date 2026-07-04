import {
  defineWorkflow,
  type JsonValue,
  type WorkflowRunsHandler,
} from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';
import { summarizeKiloSession } from '../modules/kilo';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  input: v.object({
    taskId: v.optional(nonEmptyStringSchema),
    sessionId: v.optional(nonEmptyStringSchema),
    titleQuery: v.optional(nonEmptyStringSchema),
  }),
  async run({ input }) {
    const result = await summarizeKiloSession(input);
    return JSON.parse(JSON.stringify(result)) as JsonValue;
  },
});
