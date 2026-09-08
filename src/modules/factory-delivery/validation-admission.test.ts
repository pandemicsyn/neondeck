import { expect, it } from 'vitest';
import * as v from 'valibot';
import { validationAdmissionAttentionSchema } from '../../../shared/factory-coding';
import { CandidateEvidenceError } from './evidence-errors';
import {
  ValidationAdmissionError,
  validationAdmissionAttention,
} from './validation-admission';

it.each([
  'file-too-large',
  'total-too-large',
  'file-count-exceeded',
  'scan-budget-exceeded',
  'unsupported-file',
] as const)('does not prescribe unchanged retry for %s', (code) => {
  const result = validationAdmissionAttention(new CandidateEvidenceError(code));
  expect(v.parse(validationAdmissionAttentionSchema, result)).toEqual(result);
  expect(result.reasonCode).toBe(code);
  expect(result.nextAction).toBe('inspect-diagnostics');
  expect(result.recovery).toMatch(/unchanged/);
});
it.each([
  new Error('credential=secret /private/source.ts'),
  'credential=secret',
  { code: 'file-too-large', message: 'credential=secret' },
])('never persists raw or structurally spoofed exceptions', (error) => {
  const result = validationAdmissionAttention(error);
  expect(result.reasonCode).toBe('unexpected-admission-failure');
  expect(JSON.stringify(result)).not.toMatch(/credential|private|source.ts/);
  expect(result.diagnosticReference).toMatch(/^[a-f0-9-]{36}$/);
});
it('ignores even typed error message/source fields', () => {
  const error = new CandidateEvidenceError('stale');
  error.message = 'secret source and credentials';
  const result = validationAdmissionAttention(error);
  expect(result.nextAction).toBe('review-plan');
  expect(JSON.stringify(result)).not.toContain('secret');
});
it.each(['usage-unavailable', 'budget-exhausted', 'policy-changed'] as const)(
  'gives a safe service-owned reason for %s',
  (code) => {
    const result = validationAdmissionAttention(
      new ValidationAdmissionError(code),
    );
    expect(result.reasonCode).toBe(code);
    expect(result.nextAction).not.toBe('retry-validation');
  },
);
it('keeps old attention readable without inventing a current reason', () => {
  expect(
    v.parse(validationAdmissionAttentionSchema, {
      blocker: 'candidate-unavailable',
      message: 'Old diagnostic',
      observedAt: '2026-09-07T00:00:00.000Z',
      nextAction: 'retry-validation',
    }).reasonCode,
  ).toBeUndefined();
});
it.each([
  'ownership-invalid',
  'integrity-failed',
  'candidate-unavailable',
  'path-invalid',
] as const)('keeps %s blocked for investigation', (code) => {
  const result = validationAdmissionAttention(
    new CandidateEvidenceError(code),
    'authorization',
  );
  expect(result).toMatchObject({
    reasonCode: code,
    nextAction: 'inspect-diagnostics',
    stage: 'authorization',
  });
});
it('renders only validated relative-path and byte metadata', () => {
  const result = validationAdmissionAttention(
    new CandidateEvidenceError('file-too-large', {
      path: 'assets/example.png',
      observedBytes: 3000000,
      limitBytes: 2097152,
    }),
  );
  expect(result.message).toContain('assets/example.png');
  expect(result.message).toContain('Observed: 3000000 bytes');
  expect(result.message).toContain('Limit: 2097152 bytes');
  const invalid = validationAdmissionAttention(
    new CandidateEvidenceError('file-too-large', {
      path: '/private/token',
      observedBytes: Infinity,
      limitBytes: -1,
    }),
  );
  expect(invalid.message).not.toMatch(/private|Infinity|Limit: -1/);
});
