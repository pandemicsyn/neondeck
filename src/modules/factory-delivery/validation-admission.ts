import { randomUUID } from 'node:crypto';
import type { ValidationAdmissionAttention } from '../../../shared/factory-coding';
import {
  CandidateEvidenceError,
  type CandidateEvidenceErrorCode,
} from './evidence-errors';

export class ValidationAdmissionError extends Error {
  constructor(
    readonly code: 'policy-changed' | 'usage-unavailable' | 'budget-exhausted',
  ) {
    super(code);
  }
}

type Explanation = Pick<
  ValidationAdmissionAttention,
  'message' | 'recovery' | 'nextAction'
>;
const reasons = {
  'policy-changed': {
    message:
      'The candidate no longer matches its released validation authority.',
    recovery:
      'Review the current plan and release authority before continuing.',
    nextAction: 'review-plan',
  },
  'usage-unavailable': {
    message:
      'Authenticated coding execution usage is unavailable, so the remaining validation budget cannot be established.',
    recovery:
      'Report this blocked run for investigation of its retained execution receipts. Retrying without restored usage evidence cannot admit validation.',
    nextAction: 'inspect-diagnostics',
  },
  'budget-exhausted': {
    message:
      'Coding has consumed the three-hour shared execution budget. Validation cannot start for this release.',
    recovery:
      'Review the task in planning. Retrying this release does not restore its execution budget.',
    nextAction: 'review-plan',
  },
} satisfies Record<string, Explanation>;

const limitRecovery =
  'This candidate exceeds a deterministic snapshot limit. Report the reason code and reference for snapshot support review; retrying the unchanged candidate will hit the same limit.';
const evidenceReasons = {
  'ownership-invalid': {
    message:
      'The candidate workspace or retained evidence ownership could not be verified.',
    recovery:
      'Report this run for investigation of workspace and evidence retention ownership. Retrying without verified ownership cannot admit validation.',
    nextAction: 'inspect-diagnostics',
  },
  'writer-unsettled': {
    message:
      'The candidate writer is not confirmed stopped, so validation cannot safely capture its content.',
    recovery:
      'Wait for the existing writer to settle. If it remains unsettled, report this run for ownership investigation; retry only after writer death is verified.',
    nextAction: 'retry-validation',
  },
  'candidate-unavailable': {
    message: 'Authenticated retained candidate evidence is unavailable.',
    recovery:
      'Report this run for investigation of its retained candidate receipts. Validation cannot proceed without authenticated evidence; do not recreate or edit those receipts manually.',
    nextAction: 'inspect-diagnostics',
  },
  'integrity-failed': {
    message:
      'The retained candidate failed authentication or integrity verification.',
    recovery:
      'Report this run for investigation of its retained evidence and workspace ownership. Retrying unchanged evidence cannot repair failed authentication.',
    nextAction: 'inspect-diagnostics',
  },
  'file-too-large': {
    message:
      'A changed or untracked file exceeds the 2 MiB (2097152 byte) candidate snapshot size limit.',
    recovery: limitRecovery,
    nextAction: 'inspect-diagnostics',
  },
  'total-too-large': {
    message:
      'Changed and untracked candidate content exceeds the 32 MiB (33554432 byte) snapshot budget.',
    recovery: limitRecovery,
    nextAction: 'inspect-diagnostics',
  },
  'file-count-exceeded': {
    message: 'The candidate exceeds the snapshot limit of 10,000 files.',
    recovery: limitRecovery,
    nextAction: 'inspect-diagnostics',
  },
  'scan-budget-exceeded': {
    message:
      'Verifying candidate content exceeds the 1 GiB (1073741824 byte) snapshot scan budget.',
    recovery: limitRecovery,
    nextAction: 'inspect-diagnostics',
  },
  'path-invalid': {
    message: 'A candidate path failed the snapshot containment checks.',
    recovery:
      'Report this run for investigation of the retained workspace. Validation requires verified path ownership; do not edit retained evidence to bypass the check.',
    nextAction: 'inspect-diagnostics',
  },
  'unsupported-file': {
    message:
      'The candidate contains a file or Git index entry that snapshot capture does not support.',
    recovery:
      'Report this run for snapshot support review. Retrying the unchanged candidate cannot make the entry supported.',
    nextAction: 'inspect-diagnostics',
  },
  stale: {
    message:
      'The candidate content or metadata no longer matches its retained evidence, or changed during snapshot capture.',
    recovery:
      'Review this run and its retained evidence in planning before authorizing further work. A retry cannot authenticate changed content as the original candidate.',
    nextAction: 'review-plan',
  },
  'capture-failed': {
    message: 'Candidate snapshot capture could not complete.',
    recovery:
      'Report the reason code and diagnostic reference with this run to investigate local snapshot capture. Retry only after the cause has been resolved.',
    nextAction: 'retry-validation',
  },
} satisfies Record<CandidateEvidenceErrorCode, Explanation>;

/** Public attention contains only application-owned copy, never exception data. */
export function validationAdmissionAttention(
  error: unknown,
  stage: NonNullable<ValidationAdmissionAttention['stage']> = 'preview',
): ValidationAdmissionAttention {
  const reasonCode =
    error instanceof ValidationAdmissionError ||
    error instanceof CandidateEvidenceError
      ? error.code
      : 'unexpected-admission-failure';
  const explanation: Explanation =
    error instanceof ValidationAdmissionError
      ? reasons[error.code]
      : error instanceof CandidateEvidenceError
        ? evidenceReasons[error.code]
        : {
            message:
              'Validation admission failed unexpectedly before the candidate could be admitted.',
            recovery:
              'Report the reason code and diagnostic reference with this run for investigation. Retry only after the cause has been resolved.',
            nextAction: 'retry-validation',
          };
  return {
    blocker:
      reasonCode === 'policy-changed'
        ? 'policy-changed'
        : 'candidate-unavailable',
    ...explanation,
    message:
      explanation.message +
      (error instanceof CandidateEvidenceError
        ? [
            error.details.path
              ? ` File: ${JSON.stringify(error.details.path)}.`
              : '',
            error.details.observedBytes !== undefined
              ? ` Observed: ${error.details.observedBytes} bytes.`
              : '',
            error.details.limitBytes !== undefined
              ? ` Limit: ${error.details.limitBytes} bytes.`
              : '',
          ].join('')
        : ''),
    reasonCode,
    stage,
    diagnosticReference: randomUUID(),
    observedAt: new Date().toISOString(),
  };
}
