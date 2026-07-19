export const autopilotRetryBackoffMs = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;
export const maxAutopilotStageAttempts = 5;

const permanentErrorCodes = new Set([
  'approval-required',
  'credentials-missing',
  'feedback-missing',
  'facts-truncated',
  'policy-blocked',
  'permission-denied',
  'unapproved-execution',
]);

const transientErrorCodes = new Set([
  'github-unavailable',
  'network-error',
  'rate-limited',
  'runner-unavailable',
  'timeout',
  'workflow-admission-unavailable',
]);

export type AutopilotRetryClassification = {
  kind: 'transient' | 'permanent' | 'uncertain';
  code: string;
  reason: string;
};

export function classifyAutopilotRetry(input: {
  code?: string;
  error?: unknown;
  effectMayHaveCompleted?: boolean;
  idempotent?: boolean;
}): AutopilotRetryClassification {
  const code = input.code ?? errorCode(input.error);
  const message = errorMessage(input.error).toLowerCase();
  if (permanentErrorCodes.has(code) || permanentMessage(message)) {
    return {
      kind: 'permanent',
      code,
      reason:
        'The stage is blocked until policy, credentials, facts, or operator input changes.',
    };
  }
  if (input.effectMayHaveCompleted && !input.idempotent) {
    return {
      kind: 'uncertain',
      code: code || 'effect-uncertain',
      reason:
        'The external effect may have completed and is not proven idempotent; automatic retry is unsafe.',
    };
  }
  if (transientErrorCodes.has(code) || transientMessage(message)) {
    return {
      kind: 'transient',
      code,
      reason:
        'The failure is transient and may be retried with bounded backoff.',
    };
  }
  return {
    kind: input.idempotent ? 'transient' : 'uncertain',
    code: code || 'unknown-error',
    reason: input.idempotent
      ? 'The idempotent stage may be retried with bounded backoff.'
      : 'The failure is not classified as safely retryable.',
  };
}

export function autopilotRetryDecision(
  attemptNumber: number,
  classification: AutopilotRetryClassification,
  now = new Date(),
) {
  if (
    classification.kind !== 'transient' ||
    attemptNumber >= maxAutopilotStageAttempts
  ) {
    return {
      automatic: false,
      nextAttemptAt: null,
      exhausted: attemptNumber >= maxAutopilotStageAttempts,
    } as const;
  }
  const delay =
    autopilotRetryBackoffMs[
      Math.min(attemptNumber - 1, autopilotRetryBackoffMs.length - 1)
    ];
  return {
    automatic: true,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    exhausted: false,
  } as const;
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; type?: unknown };
    if (typeof value.code === 'string') return value.code;
    if (typeof value.type === 'string') return value.type;
  }
  return 'unknown-error';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? '');
}

function permanentMessage(message: string) {
  return /approval|credential|permission|policy|missing feedback|truncated|not preapproved/.test(
    message,
  );
}

function transientMessage(message: string) {
  return /network|timeout|timed out|rate limit|temporar|unavailable|econn|fetch failed/.test(
    message,
  );
}
