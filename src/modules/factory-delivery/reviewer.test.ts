import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimePaths } from '../../runtime-home';
import { deliveryReceipt } from './service-records';
import { repairInstructionsFromReceipt } from './delivery-repair-context';
import * as v from 'valibot';
import { artifactHash } from '../coding-runs';
import { describe, it, expect } from 'vitest';
import {
  validateCandidateReview,
  candidateReviewRequestSchema,
  type CandidateReviewRequest,
} from './reviewer-contract';
import { validateReviewerReply } from './reviewer';
const evidence = {
  attemptId: 'a',
  repoId: 'r',
  worktreeId: 'w',
  root: '/fixture',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  revision: 'c'.repeat(40),
  treeSha: 'c'.repeat(40),
  evidenceDigest: 'd'.repeat(64),
  statusHash: 'e'.repeat(64),
  diffHash: 'f'.repeat(64),
  untrackedHash: '0'.repeat(64),
};
const review = {
  evidenceDigest: evidence.evidenceDigest,
  revision: evidence.revision,
  outcome: 'pass',
  findings: [],
  summary: 'Inspected exact revision.',
};
const request: CandidateReviewRequest = {
  id: 'review-fixture',
  model: 'fixture/model',
  brief: 'fixture task',
  evidence,
  checks: {
    evidenceDigest: evidence.evidenceDigest,
    revision: evidence.revision,
    passed: true,
    noWriter: true,
    durationMs: 10,
    checks: [
      {
        command: 'npm test',
        passed: true,
        exitCode: 0,
        truncated: false,
        durationMs: 10,
        evidenceRef: '/private-fixture/output.json',
        outputHash: 'a'.repeat(64),
      },
    ],
  },
  maxTokens: 1000,
  maxDurationMs: 1000,
  deadlineAt: 2000,
};
const reply = () => ({
  submissionId: 'settled-fixture',
  data: { factoryReview: [review] },
  metadata: {
    totalTokens: 50,
    startedAt: 1100,
    completedAt: 1200,
    evidenceDigest: evidence.evidenceDigest,
    revision: evidence.revision,
    requestDigest: artifactHash(
      JSON.stringify(v.parse(candidateReviewRequestSchema, request)),
    ),
  },
});
describe('independent candidate reviewer binding', () => {
  it('accepts one schema-bound settled advisory with usage', () =>
    expect(validateReviewerReply(reply(), request).outcome).toBe('pass'));
  it.each([
    {},
    { ...review, revision: '0'.repeat(40) },
    { ...review, evidenceDigest: '0'.repeat(64) },
    { ...review, approval: true },
    {
      ...review,
      findings: [
        { severity: 'high', path: 'src/a.ts', line: 1, description: 'Broken' },
      ],
    },
    { ...review, outcome: 'findings' },
  ])('rejects malformed, stale or contradictory advisory %#', (raw) =>
    expect(() => validateCandidateReview(raw, evidence)).toThrow(),
  );
  it.each([undefined, 0, -1, 1001, NaN])(
    'rejects missing or invalid usage %s',
    (totalTokens) =>
      expect(() =>
        validateReviewerReply(
          { ...reply(), metadata: { ...reply().metadata, totalTokens } },
          request,
        ),
      ).toThrow(),
  );
  it('rejects missing reviewer and duplicate results', () => {
    expect(() =>
      validateReviewerReply({ ...reply(), data: {} }, request),
    ).toThrow();
    expect(() =>
      validateReviewerReply(
        { ...reply(), data: { factoryReview: [review, review] } },
        request,
      ),
    ).toThrow();
    expect(() =>
      validateReviewerReply({ ...reply(), submissionId: '' }, request),
    ).toThrow();
    expect(() =>
      validateReviewerReply(
        {
          ...reply(),
          metadata: { ...reply().metadata, revision: '0'.repeat(40) },
        },
        request,
      ),
    ).toThrow();
  });
});

it('reads the full persisted producer result as scoped repair instructions', () => {
  const home = mkdtempSync(join(tmpdir(), 'review-repair-receipt-'));
  try {
    const raw = reply();
    const result = validateReviewerReply(
      {
        ...raw,
        data: {
          factoryReview: [
            {
              ...review,
              outcome: 'findings',
              findings: [
                {
                  severity: 'high',
                  path: 'src/a.ts',
                  line: 4,
                  description:
                    'Handle the empty input before reading its first item.',
                },
              ],
            },
          ],
        },
      },
      request,
    );
    const ref = deliveryReceipt(
      'a'.repeat(64),
      {
        producerId: result.submissionId,
        result: 'failed',
        durationMs: result.durationMs,
        details: result,
      },
      runtimePaths(home),
    );
    const instructions = repairInstructionsFromReceipt(ref);
    expect(instructions).toContain('src/a.ts:4 [high] Handle the empty input');
    expect(instructions).not.toContain(home);
    expect(instructions).not.toContain('submissionId');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
