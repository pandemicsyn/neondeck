import { describe, it, expect } from 'vitest';
import {
  snapshotProgressEvidence,
  validateProgressPacket,
  progressDigest,
} from './progress-evidence-contract';
import {
  progressReviewInputDigest,
  validateProgressRequest,
  validateProgressDecision,
  validateProgressReviewerReply,
  type ProgressReviewRequest,
} from './progress-reviewer-contract';
const h = (c: string) => c.repeat(64);
const revision = {
  runId: 'run',
  attemptId: 'attempt',
  releaseId: 'release',
  specVersion: 1,
  specHash: h('a'),
  candidateDigest: h('b'),
  baseSha: 'c'.repeat(40),
  headSha: 'd'.repeat(40),
  treeSha: 'e'.repeat(40),
};
function fixture(
  diff = 'Implement first partial fix',
  missingEvidence: string[] = [],
) {
  const packet = snapshotProgressEvidence({
    version: 1,
    grantId: 'grant',
    requestId: 'repair-request',
    revision,
    repairOrdinal: 1,
    releasedBrief: 'Keep intended validation and repair both paths.',
    proposedInstructions: 'Fix remaining failing input.',
    candidates: [
      {
        revision,
        diff,
        observations: [
          {
            ref: 'check-1',
            kind: 'verification',
            body: 'One of two checks still fails with an input error',
            fingerprint: progressDigest('input error'),
          },
        ],
      },
    ],
    priorRepairs: [],
    remainingBudget: { durationMs: 180000, repairs: 2 },
    missingEvidence,
    omittedEvidence: [],
  });
  const request: ProgressReviewRequest = {
    id: 'judge',
    binding: {
      assessmentId: 'assessment',
      grantId: 'grant',
      revision,
      repairOrdinal: 1,
      requestId: 'repair-request',
      inputDigest: progressReviewInputDigest(packet, 'synthetic'),
      evidenceDigest: h('f'),
    },
    model: 'synthetic',
    packet,
    maxDurationMs: 180000,
    deadlineAt: 200000,
    maxTokens: 16000,
  };
  return request;
}
function verdict(
  request: ProgressReviewRequest,
  decision: 'continue' | 'change-approach' | 'escalate' = 'continue',
  rationale = 'One path improved; repair the other within scope.',
) {
  return {
    ...request.binding,
    decision,
    rationale,
    evidenceRefs: [`candidate:${revision.candidateDigest}`, 'check-1'],
    nextInstructions:
      decision === 'change-approach'
        ? 'Reproduce the root cause; preserve both validation paths.'
        : null,
  };
}
describe('progress decision protocol — synthetic model decisions, not actual model evaluations', () => {
  it.each([
    ['partial progress', '+fix first path', 'continue'],
    ['repeated failure', 'same failed approach', 'change-approach'],
    ['oscillation', '-prior fix\n+old broken implementation', 'escalate'],
    [
      'weakened tests with green checks',
      '-expect(validation).toThrow()\n+test.skip()',
      'escalate',
    ],
    ['scope expansion', '+unrequested replacement subsystem', 'escalate'],
    ['initial repair without history', '+first candidate', 'continue'],
  ] as const)(
    'accepts a bound synthetic %s decision',
    (scenario, diff, decision) => {
      const request = fixture(diff);
      expect(
        validateProgressDecision(
          verdict(request, decision, scenario),
          validateProgressRequest(request),
        ).decision,
      ).toBe(decision);
    },
  );
  it('never invents history for an initial repair', () =>
    expect(fixture().packet.priorRepairs).toEqual([]));
  it('freezes nested snapshot and rejects changed content or fingerprints', () => {
    const { packet } = fixture();
    expect(Object.isFrozen(packet.candidates[0])).toBe(true);
    expect(() =>
      validateProgressPacket({ ...packet, releasedBrief: 'Changed scope' }),
    ).toThrow();
    expect(() =>
      validateProgressPacket({ ...packet, fingerprints: [] }),
    ).toThrow();
  });
  it('uses exact tree identity even if diff is missing', () => {
    const p = fixture().packet;
    const { fingerprints: _f, evidenceDigest: _d, ...raw } = p;
    const other = {
      ...revision,
      candidateDigest: h('1'),
      treeSha: '2'.repeat(40),
    };
    const result = snapshotProgressEvidence({
      ...raw,
      candidates: [
        { ...p.candidates[0], diff: null },
        { revision: other, diff: null, observations: [] },
      ],
    });
    expect(result.fingerprints[0]?.candidate).not.toBe(
      result.fingerprints[1]?.candidate,
    );
  });
  it('fails closed on missing evidence and allows explicit escalation', () => {
    const request = fixture('diff', ['prior check missing']);
    expect(() => validateProgressDecision(verdict(request), request)).toThrow(
      /Incomplete/,
    );
    expect(
      validateProgressDecision(verdict(request, 'escalate'), request).decision,
    ).toBe('escalate');
  });
  it('rejects stale grant, packet, revision, ordinal and invented references', () => {
    const request = fixture();
    const valid = verdict(request);
    for (const patch of [
      { grantId: 'other' },
      { inputDigest: h('0') },
      { evidenceDigest: h('0') },
      { revision: { ...revision, treeSha: '0'.repeat(40) } },
      { repairOrdinal: 2 },
      { evidenceRefs: ['invented'] },
    ])
      expect(() =>
        validateProgressDecision({ ...valid, ...patch }, request),
      ).toThrow();
  });
  it('requires exactly one valid result and known bounded metadata', () => {
    const request = fixture();
    const reply = {
      submissionId: 'submission',
      data: { factoryProgressReview: [verdict(request)] },
      metadata: {
        startedAt: 21000,
        completedAt: 22000,
        totalTokens: 100,
        requestDigest: progressDigest(request),
      },
    };
    expect(validateProgressReviewerReply(reply, request).durationMs).toBe(1000);
    for (const patch of [
      { data: {} },
      { data: { factoryProgressReview: [] } },
      { data: { factoryProgressReview: [verdict(request), verdict(request)] } },
      { metadata: { ...reply.metadata, totalTokens: 0 } },
      { metadata: { ...reply.metadata, totalTokens: 17000 } },
      { metadata: { ...reply.metadata, completedAt: 200001 } },
      { metadata: { ...reply.metadata, requestDigest: h('0') } },
    ])
      expect(() =>
        validateProgressReviewerReply({ ...reply, ...patch }, request),
      ).toThrow();
  });
  it('does not accept a reset or oversized reserved budget', () => {
    const request = fixture();
    expect(() =>
      validateProgressRequest({ ...request, maxDurationMs: 180001 }),
    ).toThrow();
    expect(() =>
      validateProgressRequest({
        ...request,
        packet: {
          ...request.packet,
          remainingBudget: { durationMs: 0, repairs: 0 },
        },
      }),
    ).toThrow();
  });
});
