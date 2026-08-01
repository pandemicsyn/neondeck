import { randomUUID } from 'node:crypto';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { PrReviewAssistant } from '../../agents/pr-review-assistant';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { resolvePullRequestTarget } from '../pr-events';
import { readPrReviewAdmissionBinding } from '../pr-reviews/store';
import { prReviewAssistInputSchema } from './schemas';

export async function admitPrReviewAssist(
  input: v.InferInput<typeof prReviewAssistInputSchema>,
) {
  const parsed = v.parse(prReviewAssistInputSchema, input);
  const paths = runtimePaths();
  await ensureRuntimeHome(paths);
  if (parsed.reviewId || parsed.attemptId) {
    if (!parsed.reviewId || !parsed.attemptId || !parsed.ref) {
      throw new Error(
        'A durable PR review admission requires reviewId, attemptId, and ref.',
      );
    }
    const binding = readPrReviewAdmissionBinding(parsed.reviewId, paths);
    if (!binding) {
      throw new Error(`PR review "${parsed.reviewId}" was not found.`);
    }
    if (
      binding.status !== 'reviewing' ||
      binding.attemptId !== parsed.attemptId
    ) {
      throw new Error(
        `PR review "${parsed.reviewId}" is not bound to the active attempt.`,
      );
    }
    const target = await resolvePullRequestTarget(
      { ref: parsed.ref },
      paths,
      'pr_review_admission',
    );
    if (!target.ok) throw new Error(target.result.message);
    if (
      target.target.repoFullName.toLowerCase() !==
        binding.repoFullName.toLowerCase() ||
      target.target.number !== binding.prNumber
    ) {
      throw new Error(
        `PR review "${parsed.reviewId}" is bound to ${binding.repoFullName}#${binding.prNumber}, not ${target.target.repoFullName}#${target.target.number}.`,
      );
    }
  }
  const instanceId =
    parsed.reviewId && parsed.attemptId
      ? `pr-review:${parsed.reviewId}:${parsed.attemptId}`
      : `pr-review:${randomUUID()}`;
  const handle = init(PrReviewAssistant, { id: instanceId, uid: null });
  const receipt = await handle.dispatch({
    initialData: parsed,
    message: {
      kind: 'signal',
      type: 'neondeck.pr-review.requested',
      body: 'Prepare the bound pull-request review artifacts for human review.',
      attributes: {
        operation: 'pr-review-assist',
        ...(parsed.reviewId ? { reviewId: parsed.reviewId } : {}),
        ...(parsed.attemptId ? { attemptId: parsed.attemptId } : {}),
      },
    },
  });
  return {
    agentId: instanceId,
    submissionId: receipt.submissionId,
    runId: receipt.submissionId,
  };
}
