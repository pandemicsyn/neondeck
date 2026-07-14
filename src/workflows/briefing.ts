import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import * as v from 'valibot';
import schedulerWorkflow from '../agents/scheduler-workflow';
import {
  admitBriefing,
  briefingWorkflowInputSchema,
} from '../modules/briefings';
import { updateChatSessionCommandEvent } from '../modules/sessions';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: schedulerWorkflow,
  input: briefingWorkflowInputSchema,
  output: v.object({
    briefingRunId: v.string(),
    dispatchId: v.string(),
    sessionId: v.string(),
    snapshotId: v.string(),
  }),
  async run({ input }) {
    let run: Awaited<ReturnType<typeof admitBriefing>>;
    try {
      run = await admitBriefing({
        profileId: input.profileId ?? 'morning',
        trigger: input.trigger ?? 'scheduled',
        sessionId: input.sessionId,
        commandEventId: input.commandEventId,
      });
    } catch (error) {
      if (input.sessionId && input.commandEventId) {
        await updateChatSessionCommandEvent({
          sessionId: input.sessionId,
          eventId: input.commandEventId,
          status: 'failed',
          result: null,
          reason: 'briefing-workflow-admission-failed',
        });
      }
      throw error;
    }
    if (!run.dispatchId) throw new Error('Briefing dispatch was not recorded.');
    return {
      briefingRunId: run.id,
      dispatchId: run.dispatchId,
      sessionId: run.sessionId,
      snapshotId: run.id,
    };
  },
});
