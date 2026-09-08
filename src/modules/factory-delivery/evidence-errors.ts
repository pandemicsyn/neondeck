const messages = {
  'file-too-large':
    'A changed or untracked candidate file exceeds the 2 MiB (2097152 byte) snapshot size limit.',
  'total-too-large':
    'Changed and untracked candidate content exceeds the 32 MiB (33554432 byte) snapshot byte budget.',
  'file-count-exceeded': 'Candidate file count exceeds the snapshot budget.',
  'scan-budget-exceeded':
    'Candidate content exceeds the 1 GiB (1073741824 byte) snapshot verification budget.',
  'path-invalid': 'Candidate path escaped or traversed symlink.',
  'unsupported-file': 'Unsupported candidate file or index entry.',
  stale:
    'Stale candidate: content, metadata, or evidence digest changed during snapshot capture.',
  'ownership-invalid':
    'Candidate workspace or evidence retention ownership could not be verified.',
  'writer-unsettled':
    'Candidate writer is not settled; wait for the existing attempt to finish.',
  'candidate-unavailable':
    'An authenticated retained candidate is required for validation.',
  'integrity-failed':
    'Candidate authentication or integrity could not be verified.',
  'capture-failed': 'Candidate snapshot capture failed safely.',
} as const;
export type CandidateEvidenceErrorCode = keyof typeof messages;

export type CandidateEvidenceErrorDetails = Readonly<{
  path?: string;
  observedBytes?: number;
  limitBytes?: number;
}>;

/** Safe diagnostics contract: fixed text only, never paths or subprocess output. */
export class CandidateEvidenceError extends Error {
  readonly details: CandidateEvidenceErrorDetails;
  constructor(
    readonly code: CandidateEvidenceErrorCode,
    details: CandidateEvidenceErrorDetails = {},
  ) {
    super(messages[code]);
    this.name = 'CandidateEvidenceError';
    const path = details.path;
    this.details = Object.freeze({
      ...(path &&
      path.length <= 512 &&
      !/[^\x20-\x7e]/.test(path) &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !path.split('/').some((part) => part === '..' || part === '.' || !part)
        ? { path }
        : {}),
      ...(Number.isSafeInteger(details.observedBytes) &&
      details.observedBytes! >= 0
        ? { observedBytes: details.observedBytes }
        : {}),
      ...(Number.isSafeInteger(details.limitBytes) && details.limitBytes! >= 0
        ? { limitBytes: details.limitBytes }
        : {}),
    });
  }
}
