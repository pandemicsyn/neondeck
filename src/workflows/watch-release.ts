import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';
import { createScheduleBlueprint } from '../scheduler';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  input: v.object({
    repo: nonEmptyStringSchema,
    intervalSeconds: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(60)),
    ),
  }),
  async run({ input }) {
    return createScheduleBlueprint({
      blueprint: 'release-watch',
      repo: input.repo,
      intervalSeconds: input.intervalSeconds,
    });
  },
});
