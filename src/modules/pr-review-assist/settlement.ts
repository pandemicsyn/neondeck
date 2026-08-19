import type { FlueObservation } from '@flue/runtime';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  attachPrReviewAttemptRun,
  failPrReview,
  listPrReviewAssistSettlementCandidates,
  readPrReviewAdmissionBinding,
  readPrReviewByRunId,
} from '../pr-reviews';

export type PrReviewAssistSettlementReader = (input: {
  instanceId: string;
  submissionId: string;
}) => Promise<{ failed: boolean }>;

const settlementWatchers = prReviewSettlementWatchers();
const settlementRetryDelayMs = 1_000;

export type PrReviewAssistAdmission = (input: {
  ref: string;
  reviewId: string;
  attemptId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
}) => Promise<{ runId: string }>;

export function prReviewAssistInstanceId(reviewId: string, attemptId: string) {
  return `pr-review:${reviewId}:${attemptId}`;
}

export function watchPrReviewAssistSettlement(
  input: { reviewId: string; attemptId: string; submissionId: string },
  paths: RuntimePaths = runtimePaths(),
  readSettlement: PrReviewAssistSettlementReader,
  options: { retryDelayMs?: number } = {},
) {
  const key = `${paths.home}\n${input.submissionId}`;
  const existing = settlementWatchers.get(key);
  if (existing) return existing;
  const watcher = retryPrReviewAssistSettlement(
    input,
    paths,
    readSettlement,
    options.retryDelayMs ?? settlementRetryDelayMs,
  ).finally(() => {
    settlementWatchers.delete(key);
  });
  settlementWatchers.set(key, watcher);
  return watcher;
}

async function retryPrReviewAssistSettlement(
  input: { reviewId: string; attemptId: string; submissionId: string },
  paths: RuntimePaths,
  readSettlement: PrReviewAssistSettlementReader,
  retryDelayMs: number,
) {
  for (;;) {
    const binding = readPrReviewAdmissionBinding(input.reviewId, paths);
    if (
      !binding ||
      binding.attemptId !== input.attemptId ||
      !['reviewing', 'ready'].includes(binding.status) ||
      (binding.runId !== null && binding.runId !== input.submissionId)
    ) {
      return null;
    }
    try {
      return await reconcilePrReviewAssistSettlement(
        input,
        paths,
        readSettlement,
      );
    } catch (error) {
      console.warn(
        '[neondeck] PR review submission settlement watch will retry',
        error,
      );
      await delay(retryDelayMs);
    }
  }
}

export async function reconcilePrReviewAssistSettlement(
  input: { reviewId: string; attemptId: string; submissionId: string },
  paths: RuntimePaths = runtimePaths(),
  readSettlement: PrReviewAssistSettlementReader,
) {
  const settlement = await readSettlement({
    instanceId: prReviewAssistInstanceId(input.reviewId, input.attemptId),
    submissionId: input.submissionId,
  });
  if (!settlement.failed) return null;
  return failPrReview(
    {
      reviewId: input.reviewId,
      attemptId: input.attemptId,
      runId: input.submissionId,
      allowReady: true,
      message:
        'The Flue PR review submission failed. Inspect its sanitized activity for details.',
    },
    paths,
  );
}

export async function recoverInterruptedPrReviewAssists(
  paths: RuntimePaths = runtimePaths(),
  readSettlement: PrReviewAssistSettlementReader,
  admit: PrReviewAssistAdmission,
) {
  const candidates = listPrReviewAssistSettlementCandidates(paths);
  const recovered: string[] = [];
  const failed: Array<{ reviewId: string; error: string }> = [];
  for (const candidate of candidates) {
    try {
      let submissionId = candidate.submissionId;
      if (!submissionId) {
        if (candidate.status !== 'reviewing') continue;
        const admission = await admit({
          ref: candidate.ref,
          reviewId: candidate.reviewId,
          attemptId: candidate.attemptId,
          repoFullName: candidate.repoFullName,
          prNumber: candidate.prNumber,
          headSha: candidate.headSha,
          baseSha: requireRevisionValue(candidate.baseSha, 'base SHA'),
          baseRef: requireRevisionValue(candidate.baseRef, 'base ref'),
        });
        submissionId = admission.runId;
        const attached = attachPrReviewAttemptRun(
          candidate.reviewId,
          candidate.attemptId,
          submissionId,
          paths,
        );
        if (!attached) continue;
        recovered.push(candidate.reviewId);
      }
      void watchPrReviewAssistSettlement(
        { ...candidate, submissionId },
        paths,
        readSettlement,
      );
    } catch (error) {
      failed.push({
        reviewId: candidate.reviewId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    watching: candidates.map((candidate) => candidate.reviewId),
    recovered,
    failed,
  };
}

export function settlePrReviewAssistObservation(
  event: Extract<FlueObservation, { type: 'submission_settled' }>,
  paths: RuntimePaths = runtimePaths(),
) {
  if (
    event.outcome === 'completed' ||
    (event.agentName && event.agentName !== 'pr-review-assistant')
  ) {
    return null;
  }
  const review = readPrReviewByRunId(event.submissionId, paths);
  if (!review) return null;
  return failPrReview(
    {
      runId: event.submissionId,
      allowReady: true,
      message:
        event.error?.message ??
        `The Flue PR review submission ${event.outcome}. Inspect its sanitized activity for details.`,
    },
    paths,
  );
}

function prReviewSettlementWatchers() {
  const target = globalThis as typeof globalThis & {
    __neondeckPrReviewSettlementWatchers?: Map<
      string,
      Promise<ReturnType<typeof failPrReview>>
    >;
  };
  return (target.__neondeckPrReviewSettlementWatchers ??= new Map());
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function requireRevisionValue(value: string | null, label: string) {
  if (value) return value;
  throw new Error(`The persisted PR review is missing its exact ${label}.`);
}
