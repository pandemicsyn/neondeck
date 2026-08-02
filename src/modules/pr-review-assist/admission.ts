import { randomUUID } from 'node:crypto';
import { AgentRunError, init } from '@flue/runtime';
import * as v from 'valibot';
import { PrReviewAssistant } from '../../agents/pr-review-assistant';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { resolvePullRequestTarget } from '../pr-events';
import { readPrReviewAdmissionBinding } from '../pr-reviews/store';
import { prReviewAssistInputSchema } from './schemas';
import { watchPrReviewAssistSettlement } from './settlement';

export async function readPrReviewAssistSettlement(input: {
  instanceId: string;
  submissionId: string;
}) {
  const handle = init(PrReviewAssistant, { id: input.instanceId });
  try {
    await handle.read(input.submissionId);
    return { failed: false };
  } catch (error) {
    if (error instanceof AgentRunError) return { failed: true };
    throw error;
  }
}

export async function admitPrReviewAssist(
  input: v.InferInput<typeof prReviewAssistInputSchema>,
) {
  const parsed = v.parse(prReviewAssistInputSchema, input);
  const paths = runtimePaths();
  await ensureRuntimeHome(paths);
  let initialData = parsed;
  if (parsed.reviewId || parsed.attemptId) {
    if (
      !parsed.reviewId ||
      !parsed.attemptId ||
      !parsed.ref ||
      !parsed.repoFullName ||
      !parsed.prNumber ||
      !parsed.headSha ||
      !parsed.baseSha ||
      !parsed.baseRef
    ) {
      throw new Error(
        'A durable PR review admission requires its attempt binding and exact revision.',
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
      target.target.number !== binding.prNumber ||
      parsed.repoFullName.toLowerCase() !==
        binding.repoFullName.toLowerCase() ||
      parsed.prNumber !== binding.prNumber
    ) {
      throw new Error(
        `PR review "${parsed.reviewId}" is bound to ${binding.repoFullName}#${binding.prNumber}, not ${target.target.repoFullName}#${target.target.number}.`,
      );
    }
    if (
      parsed.headSha !== binding.headSha ||
      parsed.baseSha !== binding.baseSha ||
      parsed.baseRef !== binding.baseRef
    ) {
      throw new Error(
        `PR review "${parsed.reviewId}" exact revision no longer matches its admitted attempt.`,
      );
    }
    initialData = {
      ...parsed,
      ref: `${binding.repoFullName}#${binding.prNumber}`,
      repo: binding.repoFullName,
      repoFullName: binding.repoFullName,
      prNumber: binding.prNumber,
      headSha: binding.headSha,
      baseSha: parsed.baseSha,
      baseRef: parsed.baseRef,
    };
  }
  const instanceId =
    parsed.reviewId && parsed.attemptId
      ? `pr-review:${parsed.reviewId}:${parsed.attemptId}`
      : `pr-review:${randomUUID()}`;
  const handle = init(PrReviewAssistant, { id: instanceId, uid: null });
  const receipt = await handle.dispatch({
    ...(parsed.reviewId && parsed.attemptId
      ? {
          idempotencyKey: `pr-review-assist:${parsed.reviewId}:${parsed.attemptId}`,
        }
      : {}),
    initialData,
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
  if (parsed.reviewId && parsed.attemptId) {
    void watchPrReviewAssistSettlement(
      {
        reviewId: parsed.reviewId,
        attemptId: parsed.attemptId,
        submissionId: receipt.submissionId,
      },
      paths,
      readPrReviewAssistSettlement,
    );
  }
  return {
    agentId: instanceId,
    submissionId: receipt.submissionId,
    runId: receipt.submissionId,
  };
}
