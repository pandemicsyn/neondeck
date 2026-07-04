/* eslint-disable no-unused-vars */
import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { checkAutopilotPolicy } from '../../autopilot-policy';
import { asJsonValue } from './utils';
import {
  commentPrAutofixResultInputSchema,
  fixPrCiFailureInputSchema,
  fixPrReviewFeedbackInputSchema,
  nonEmptyStringSchema,
  preparePrWorktreeInputSchema,
  pushPrAutofixInputSchema,
  triagePrEventInputSchema,
  verifyPrWorktreeInputSchema,
  autopilotOutputSchema,
} from './schemas';
import { triagePrEvent } from './triage';
import { preparePrWorktree, verifyPrWorktree } from './worktree';
import { pushPrAutofix } from './push';
import { fixPrCiFailure } from './ci-fix';
import { fixPrReviewFeedback } from './review-feedback';
import { commentPrAutofixResult } from './comments';

export const triagePrEventAction = defineAction({
  name: 'neondeck_autopilot_triage_pr_event',
  description:
    'Classify a structured PR watch delta into no-op, notify-only, explain-only, draft-fix, auto-fix-no-push, or auto-fix-push-after-checks without applying fixes.',
  input: triagePrEventInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return triagePrEvent(input);
  },
});

export const preparePrWorktreeAction = defineAction({
  name: 'neondeck_autopilot_prepare_pr_worktree',
  description:
    'Create, sync, lock, and inspect an isolated PR worktree while gathering deterministic PR and check facts.',
  input: preparePrWorktreeInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return preparePrWorktree(input);
  },
});

export const autopilotPolicyCheckAction = defineAction({
  name: 'neondeck_autopilot_policy_check',
  description:
    'Classify an autopilot worktree diff against repo policy limits, high-risk file classes, push destination rules, and concurrency settings.',
  input: v.strictObject({
    repoId: v.optional(nonEmptyStringSchema),
    worktreeId: v.optional(nonEmptyStringSchema),
    diffBaseRef: v.optional(nonEmptyStringSchema),
    pushDestination: v.optional(nonEmptyStringSchema),
    forcePush: v.optional(v.boolean()),
  }),
  output: autopilotOutputSchema,
  async run({ input }) {
    const result = await checkAutopilotPolicy(input);
    return {
      ok: result.ok,
      action: result.action,
      changed: false,
      message: result.message,
      data: asJsonValue(result),
      requires: result.requires,
    };
  },
});

export const verifyPrWorktreeAction = defineAction({
  name: 'neondeck_autopilot_verify_pr_worktree',
  description:
    'Run configured repo checks for a PR worktree through Neondeck execution approval policy and summarize pass, fail, or approval-blocked results.',
  input: verifyPrWorktreeInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return verifyPrWorktree(input);
  },
});

export const pushPrAutofixAction = defineAction({
  name: 'neondeck_autopilot_push_pr_autofix',
  description:
    'Push an approved and verified prepared diff back to the PR head branch only when autopilot policy, GitHub permissions, and clean committed worktree state allow it.',
  input: pushPrAutofixInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return pushPrAutofix(input);
  },
});

export const fixPrCiFailureAction = defineAction({
  name: 'neondeck_autopilot_fix_pr_ci_failure',
  description:
    'Fetch failing check facts/logs for a managed PR worktree, run approved diagnostics, optionally apply a scoped repo-edit patch, commit locally, and create a prepared diff.',
  input: fixPrCiFailureInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return fixPrCiFailure(input);
  },
});

export const fixPrReviewFeedbackAction = defineAction({
  name: 'neondeck_autopilot_fix_pr_review_feedback',
  description:
    'Fetch unresolved PR review feedback, group it by file/topic, read affected files through repo-edit, apply bounded caller-supplied repo-edit replacements or patches in an isolated worktree, commit locally, and prepare a diff for operator review.',
  input: fixPrReviewFeedbackInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return fixPrReviewFeedback(input);
  },
});

export const commentPrAutofixResultAction = defineAction({
  name: 'neondeck_autopilot_comment_pr_autofix_result',
  description:
    'Post a concise GitHub PR comment from deterministic prepared-diff/autopilot result facts and persist a human-readable audit summary.',
  input: commentPrAutofixResultInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return commentPrAutofixResult(input);
  },
});

export const neondeckAutopilotActions = [
  triagePrEventAction,
  preparePrWorktreeAction,
  autopilotPolicyCheckAction,
  verifyPrWorktreeAction,
  pushPrAutofixAction,
  fixPrCiFailureAction,
  fixPrReviewFeedbackAction,
  commentPrAutofixResultAction,
];
