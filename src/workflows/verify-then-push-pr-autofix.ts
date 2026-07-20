import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';
import { type AutopilotActionResult } from '../modules/autopilot';
import { readPreparedDiff } from '../modules/prepared-diffs';
import { asJsonValue } from '../lib/action-result';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  input: v.strictObject({
    preparedDiffId: nonEmptyStringSchema,
    worktreeId: nonEmptyStringSchema,
  }),
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    changed: v.boolean(),
    message: v.string(),
  }),
  async run({ input }) {
    const preparedDiff = readPreparedDiff(input.preparedDiffId);
    if (!preparedDiff) {
      return {
        ok: false,
        action: 'autopilot_verify_then_push_pr_autofix',
        changed: false,
        message: `Prepared diff "${input.preparedDiffId}" was not found.`,
        requires: ['preparedDiffId'],
      } satisfies AutopilotActionResult;
    }
    if (preparedDiff.worktreeId !== input.worktreeId) {
      return {
        ok: false,
        action: 'autopilot_verify_then_push_pr_autofix',
        changed: false,
        message: `Prepared diff "${input.preparedDiffId}" is linked to worktree "${preparedDiff.worktreeId}", not "${input.worktreeId}".`,
        requires: ['worktreeId'],
      } satisfies AutopilotActionResult;
    }

    return {
      ok: false,
      action: 'autopilot_verify_then_push_pr_autofix',
      changed: false,
      message:
        'Verification and push are coordinator-owned stages. Request advancement through the Autopilot admission instead of dispatching this legacy combined workflow.',
      data: asJsonValue({
        preparedDiffId: preparedDiff.id,
        worktreeId: preparedDiff.worktreeId,
      }),
      requires: ['autopilotCoordinator'],
    } satisfies AutopilotActionResult;
  },
});
