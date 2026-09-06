import { AgentRunError, type AgentReply } from '@flue/runtime';
import type { CandidateReviewRequest } from './reviewer-contract';
export type ReviewerReadHandle = {
  read(id: string, options: { signal: AbortSignal }): Promise<AgentReply>;
  abort(): Promise<void>;
};
type ReviewerWindow = Pick<
  CandidateReviewRequest,
  'maxDurationMs' | 'deadlineAt'
>;
const settlementGraceMs = 1000;
export class ReviewerDeadlineError extends Error {
  constructor() {
    super(
      'Reviewer deadline expired; abort requested, unknown usage retains its reservation',
    );
  }
}
export class ReviewerTerminalError extends Error {
  readonly usageKnown = false;
  constructor(
    readonly terminalOutcome: 'failed' | 'aborted',
    readonly submissionId: string,
    readonly reservedDurationMs: number,
  ) {
    super(
      `Reviewer settled ${terminalOutcome}; usage is unknown, retain conservative reservation accounting`,
    );
  }
}
function terminal(error: unknown, request: ReviewerWindow): never {
  if (error instanceof AgentRunError)
    throw new ReviewerTerminalError(
      error.outcome,
      error.submissionId,
      request.maxDurationMs,
    );
  throw error;
}
function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ReviewerDeadlineError()),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
export function assertReviewerAdmissionWindow(request: ReviewerWindow) {
  const remaining = request.deadlineAt - Date.now();
  if (remaining <= 0 || remaining > request.maxDurationMs)
    throw new ReviewerDeadlineError();
  return remaining;
}
// Flue2.0.3 read cancellation is local. abort() separately persists the abort
// intent; neither a read timeout nor an abort receipt is proof of known usage.
export async function readCandidateReviewWithinDeadline(
  handle: ReviewerReadHandle,
  submissionId: string,
  request: ReviewerWindow,
) {
  const remaining = Math.min(
    request.maxDurationMs,
    request.deadlineAt - Date.now(),
  );
  if (remaining > 0) {
    const signal = AbortSignal.timeout(remaining);
    try {
      return await bounded(handle.read(submissionId, { signal }), remaining);
    } catch (error) {
      if (error instanceof AgentRunError) terminal(error, request);
      if (!signal.aborted && Date.now() < request.deadlineAt) {
        // A broken local read does not stop the provider. Stop durable work
        // before returning transport uncertainty to the coordinator.
        await bounded(handle.abort(), settlementGraceMs);
        throw error;
      }
    }
  }
  // An expired reattachment uses exactly the same deadline. It can retrieve an
  // already-settled valid reply, but it cannot grant another provider window.
  await bounded(handle.abort(), settlementGraceMs);
  try {
    return await bounded(
      handle.read(submissionId, {
        signal: AbortSignal.timeout(settlementGraceMs),
      }),
      settlementGraceMs,
    );
  } catch (error) {
    if (error instanceof AgentRunError) terminal(error, request);
    throw new ReviewerDeadlineError();
  }
}

export async function admitCandidateReviewWithinDeadline<T>(
  handle: ReviewerReadHandle,
  request: ReviewerWindow,
  admit: () => Promise<T>,
) {
  const remaining = assertReviewerAdmissionWindow(request);
  const admission = admit();
  // Even a late transport receipt must not leave newly admitted work running
  // after the original deadline has already expired.
  void admission
    .then(async () => {
      if (Date.now() >= request.deadlineAt)
        await bounded(handle.abort(), settlementGraceMs);
    })
    .catch(() => undefined);
  try {
    return await bounded(admission, remaining);
  } catch (error) {
    await bounded(handle.abort(), settlementGraceMs);
    throw error;
  }
}
