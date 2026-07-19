const activeSubmissionAttempts = new Set<string>();

export function claimAutopilotSubmissionProcessLease(attemptId: string) {
  activeSubmissionAttempts.add(attemptId);
}

export function releaseAutopilotSubmissionProcessLease(attemptId: string) {
  activeSubmissionAttempts.delete(attemptId);
}

export function hasAutopilotSubmissionProcessLease(attemptId: string) {
  return activeSubmissionAttempts.has(attemptId);
}
