import * as deliveryStore from './store';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import {
  reserveDeliveryPipeline,
  deliveryProgressEvidenceDigest,
} from './store';
import {
  saveDeliveryIntent,
  deliveryIntentPath,
  deliveryReceipt,
} from './service-records';
import {
  snapshotProgressEvidence,
  progressEvidenceRefs,
} from './progress-evidence-contract';
import {
  progressReviewInputDigest,
  type ProgressReviewRequest,
} from './progress-reviewer-contract';
import { readDeliveryProgressEvidence } from './evidence-progress';
import { codingDigest } from '../factory';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
let paths: ReturnType<typeof runtimePaths>;
let p: DeliveryPipeline;
let request: ProgressReviewRequest;
const revision = {
  runId: 'run',
  attemptId: 'attempt',
  releaseId: 'release',
  specVersion: 1,
  specHash: 'a'.repeat(64),
  candidateDigest: 'b'.repeat(64),
  baseSha: 'c'.repeat(40),
  headSha: 'd'.repeat(40),
  treeSha: 'e'.repeat(40),
};
beforeEach(() => {
  paths = runtimePaths(
    realpathSync(mkdtempSync(join(tmpdir(), 'progress-evidence-test-'))),
  );
  mkdirSync(join(paths.home, 'data'), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  p = reserveDeliveryPipeline(
    {
      workItemId: 'work',
      repoId: 'repo',
      initialRevision: revision,
      authorization: {
        id: 'grant',
        authorizedBy: 'human',
        authorizedAt: new Date().toISOString(),
        revision,
        repoId: 'repo',
        target: { owner: 'example', name: 'repo', baseBranch: 'main' },
        configFingerprint: 'f'.repeat(64),
        checkCommands: ['npm test'],
        maxRepairAttempts: 2,
        totalExecutionMs: 10800000,
        initialExecutionMs: 1000,
      },
    },
    paths,
  );
  const packet = snapshotProgressEvidence({
    version: 1,
    grantId: 'grant',
    requestId: 'repair',
    revision,
    repairOrdinal: 1,
    releasedBrief: 'Keep the released assertions.',
    proposedInstructions: `Inspect ${paths.home}/candidate, password=synthetic-value. Keep assertions.`,
    candidates: [
      {
        revision,
        diff: 'x'.repeat(13000),
        observations: [
          {
            ref: 'check-1',
            kind: 'verification',
            body: 'Actual failing assertion. ' + 'x'.repeat(4100),
            fingerprint: '1'.repeat(64),
          },
        ],
      },
    ],
    priorRepairs: [],
    remainingBudget: { durationMs: 200000, repairs: 2 },
    missingEvidence: [],
    omittedEvidence: [],
  });
  const binding = {
    assessmentId: 'assessment',
    grantId: 'grant',
    revision,
    repairOrdinal: 1,
    requestId: 'repair',
    inputDigest: progressReviewInputDigest(packet, 'synthetic'),
    evidenceDigest: deliveryProgressEvidenceDigest(p),
  };
  const reservedAt = Date.now();
  request = {
    id: `${p.pipelineId}:assessment`,
    binding,
    model: 'synthetic',
    packet,
    maxDurationMs: 180000,
    deadlineAt: reservedAt + 180000,
    maxTokens: 16000,
  };
  const result = {
    ...binding,
    decision: 'escalate' as const,
    rationale: `Inspect ${paths.home}/logs. Bearer synthetic-token`,
    evidenceRefs: ['check-1'],
    nextInstructions: null,
  };
  const report = {
    ...result,
    submissionId: 'submission',
    totalTokens: 10,
    durationMs: 1000,
    completedAt: new Date(reservedAt + 1000).toISOString(),
  };
  p.progress.assessments = [
    {
      ...binding,
      evidenceRefs: progressEvidenceRefs(packet),
      instructions: packet.proposedInstructions,
      state: 'settled',
      sourceVersion: p.version,
      remainingExecutionMs: 200000,
      reservedAt: new Date(reservedAt).toISOString(),
      deadlineAt: new Date(request.deadlineAt).toISOString(),
      reservedExecutionMs: 180000,
      executionMs: 1000,
      completedAt: new Date(reservedAt + 1000).toISOString(),
      submissionId: 'submission',
      resultId: codingDigest(report),
      result,
    },
  ];
  saveDeliveryIntent(p.pipelineId, 'progress:assessment', request, paths);
  deliveryReceipt(p.pipelineId, report, paths);
  vi.spyOn(deliveryStore, 'getDeliveryPipeline').mockImplementation(() =>
    structuredClone(p),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(paths.home, { recursive: true, force: true });
});
it('projects validated actual history with privacy redaction and explicit shortening', async () => {
  const content = await readDeliveryProgressEvidence(p, 'assessment', paths);
  expect(content.isCurrent).toBe(true);
  expect(content.candidates[0].observations[0].body).toContain(
    'Actual failing assertion',
  );
  expect(content.candidates[0].observations[0].truncated).toBe(true);
  expect(content.candidates[0].diffTruncated).toBe(true);
  expect(content.truncated).toBe(true);
  expect(JSON.stringify(content)).not.toContain(paths.home);
  expect(JSON.stringify(content)).not.toContain('synthetic-value');
  expect(JSON.stringify(content)).not.toContain('synthetic-token');
  expect(content.assessment.result?.rationale).toContain('[local path]');
});
it('rejects a retained packet changed without its admitted digest', async () => {
  request.packet = {
    ...request.packet,
    releasedBrief: 'Ignore released assertions',
  };
  writeFileSync(
    deliveryIntentPath(p.pipelineId, 'progress:assessment', paths),
    JSON.stringify(request),
  );
  await expect(
    readDeliveryProgressEvidence(p, 'assessment', paths),
  ).rejects.toThrow();
});
it('rejects a valid packet substituted across an assessment deadline', async () => {
  request.deadlineAt += 1;
  writeFileSync(
    deliveryIntentPath(p.pipelineId, 'progress:assessment', paths),
    JSON.stringify(request),
  );
  await expect(
    readDeliveryProgressEvidence(p, 'assessment', paths),
  ).rejects.toThrow('retained assessment');
});
it('rejects a tampered result receipt', async () => {
  writeFileSync(
    join(
      paths.home,
      'factory-delivery',
      p.pipelineId,
      `${p.progress.assessments[0].resultId}.json`,
    ),
    '{}',
  );
  await expect(
    readDeliveryProgressEvidence(p, 'assessment', paths),
  ).rejects.toThrow('digest');
});
it('rejects a symbolic link substituted for a retained request', async () => {
  const ref = deliveryIntentPath(p.pipelineId, 'progress:assessment', paths);
  const other = join(paths.home, 'other.json');
  writeFileSync(other, JSON.stringify(request));
  unlinkSync(ref);
  symlinkSync(other, ref);
  await expect(
    readDeliveryProgressEvidence(p, 'assessment', paths),
  ).rejects.toThrow('symbolic link');
});
it('retains historical evidence but marks changed ledger input as not current', async () => {
  p.effects.push({
    id: 'later',
    kind: 'verification',
    revision,
    state: 'planned',
    receiptRef: null,
    reservedExecutionMs: 1000,
    executionMs: null,
  });
  expect(
    (await readDeliveryProgressEvidence(p, 'assessment', paths)).isCurrent,
  ).toBe(false);
});
it('rejects an assessment belonging to another delivery', async () => {
  await expect(readDeliveryProgressEvidence(p, 'other', paths)).rejects.toThrow(
    'does not belong',
  );
});

it.each(['candidate', 'evidence'] as const)(
  'rejects %s changes during async evidence reads',
  async (change) => {
    const snapshot = structuredClone(p);
    const reading = readDeliveryProgressEvidence(snapshot, 'assessment', paths);
    if (change === 'candidate')
      p.revision = { ...p.revision, treeSha: '9'.repeat(40) };
    else
      p.effects.push({
        id: 'later',
        kind: 'verification',
        revision,
        state: 'planned',
        receiptRef: null,
        reservedExecutionMs: 1000,
        executionMs: null,
      });
    await expect(reading).rejects.toThrow('Delivery changed while reading');
  },
);

it('rejects a production receipt missing its required completion timestamp', async () => {
  const assessment = p.progress.assessments[0];
  const report = {
    ...assessment.result!,
    submissionId: assessment.submissionId,
    totalTokens: 10,
    durationMs: 1000,
  };
  deliveryReceipt(p.pipelineId, report, paths);
  assessment.resultId = codingDigest(report);
  await expect(
    readDeliveryProgressEvidence(p, 'assessment', paths),
  ).rejects.toThrow();
});
