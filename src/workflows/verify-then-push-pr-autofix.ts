import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';
import {
  pushPrAutofix,
  verifyPrWorktree,
  type AutopilotActionResult,
} from '../modules/autopilot';
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

    const verification = await verifyPrWorktree({
      worktreeId: preparedDiff.worktreeId,
      lockOwner: 'approval_verify_then_push_verify',
    });
    if (!verification.ok) {
      return {
        ...verification,
        action: 'autopilot_verify_then_push_pr_autofix',
        message: `${verification.message} Push was not dispatched.`,
        data: asJsonValue({
          verification,
          pushDeferred: true,
          nextWorkflow: 'push_pr_autofix',
        }),
      } satisfies AutopilotActionResult;
    }

    const push = await pushPrAutofix({
      preparedDiffId: input.preparedDiffId,
      lockOwner: 'approval_verify_then_push_push',
    });
    return {
      ok: push.ok,
      action: 'autopilot_verify_then_push_pr_autofix',
      changed: true,
      message: push.ok
        ? `Verified prepared diff ${input.preparedDiffId} and dispatched push-back.`
        : `Verified prepared diff ${input.preparedDiffId}, but push-back did not complete: ${push.message}`,
      data: asJsonValue({ verification, push }),
      requires: push.requires,
      errors: push.errors,
    } satisfies AutopilotActionResult;
  },
});
