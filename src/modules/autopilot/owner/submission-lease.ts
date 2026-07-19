type ProcessLease = { settled: Promise<void>; release: () => void };
const activeSubmissionAttempts = new Map<string, ProcessLease>();

export function claimAutopilotSubmissionProcessLease(attemptId: string) {
  if (activeSubmissionAttempts.has(attemptId)) return;
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  activeSubmissionAttempts.set(attemptId, { settled, release: resolve });
}

export function releaseAutopilotSubmissionProcessLease(attemptId: string) {
  const lease = activeSubmissionAttempts.get(attemptId);
  if (!lease) return;
  activeSubmissionAttempts.delete(attemptId);
  lease.release();
}

export function hasAutopilotSubmissionProcessLease(attemptId: string) {
  return activeSubmissionAttempts.has(attemptId);
}

export async function waitForAutopilotSubmissionProcessLease(
  attemptId: string,
) {
  await activeSubmissionAttempts.get(attemptId)?.settled;
}
