import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import {
  reserveDeliveryPipeline,
  reserveDeliveryProgress,
  updateDeliveryProgress,
  deliveryProgressEvidenceDigest,
  deliveryValidationContractDigest,
  deliveryBudget,
} from './store';
import {
  changeDelivery,
  deliveryReceipt,
  requireDelivery,
  interveneDelivery,
  saveDeliveryIntent,
} from './service-records';
import { checkpointDeliveryRepair, type ProgressIO } from './progress-service';
import {
  snapshotProgressEvidence,
  progressEvidenceRefs,
} from './progress-evidence-contract';
import {
  recoverDeliveryProgress,
  readProgressIntent,
  settleDeliveryProgress,
} from './progress-recovery';
import {
  progressReviewInputDigest,
  progressReviewRequestSchema,
} from './progress-reviewer-contract';
import * as v from 'valibot';
import { ReviewerTerminalError } from './reviewer-deadline';
import { writeFileSync } from 'node:fs';
import { deliveryIntentPath } from './service-records';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import { codingDigest } from '../factory';

vi.mock('./authority', () => ({
  assertDeliveryAuthority: vi.fn(),
  deliveryContext: vi.fn(),
}));
vi.mock('./progress-reviewer', () => ({
  reviewFactoryProgress: vi.fn(),
  recoverExistingFactoryProgress: vi.fn(),
  cancelFactoryProgress: vi.fn(),
}));
import {
  recoverExistingFactoryProgress,
  cancelFactoryProgress,
} from './progress-reviewer';
let paths: ReturnType<typeof runtimePaths>;
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
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'progress-service-')));
  mkdirSync(join(paths.home, 'data'), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(paths.home, { recursive: true, force: true });
});
function failed(initialExecutionMs = 1000) {
  let p = reserveDeliveryPipeline(
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
        initialExecutionMs,
      },
    },
    paths,
  );
  p = changeDelivery(
    p.pipelineId,
    {
      type: 'plan-effect',
      id: 'verification',
      kind: 'verification',
      maxExecutionMs: Math.min(1000, 10800000 - initialExecutionMs),
    },
    paths,
  );
  p = changeDelivery(
    p.pipelineId,
    { type: 'start-effect', id: 'verification' },
    paths,
  );
  const details = { failed: true };
  const ref = deliveryReceipt(p.pipelineId, details, paths);
  p = changeDelivery(
    p.pipelineId,
    {
      type: 'record-evidence',
      evidence: {
        id: 'verification',
        kind: 'verification',
        revision,
        producerId: 'check',
        result: 'failed',
        evidenceRef: ref,
        effectId: 'verification',
        validationContractDigest: deliveryValidationContractDigest(p),
        bundleDigest: codingDigest(details),
        verificationEvidenceId: null,
        verificationBundleDigest: null,
      },
    },
    paths,
  );
  return changeDelivery(
    p.pipelineId,
    {
      type: 'settle-effect',
      id: 'verification',
      state: 'delivered',
      receiptRef: ref,
      executionMs: 10,
    },
    paths,
  );
}
function io(
  decision: 'continue' | 'change-approach' | 'escalate' = 'continue',
): ProgressIO {
  return {
    assert: vi.fn(async () => {}),
    model: () => ({ model: 'synthetic', thinkingLevel: 'medium' }),
    packet: vi.fn(
      async (p: DeliveryPipeline, instructions: string, requestId: string) =>
        snapshotProgressEvidence({
          version: 1,
          grantId: p.authorization.id,
          requestId,
          revision: p.revision,
          repairOrdinal: 1,
          releasedBrief: 'Repair the released feature.',
          proposedInstructions: instructions,
          candidates: [
            {
              revision: p.revision,
              diff: 'diff --git a/a b/a',
              observations: [
                {
                  ref: 'check:1',
                  kind: 'verification',
                  body: 'Failed expected behavior',
                  fingerprint: '1'.repeat(64),
                },
              ],
            },
          ],
          priorRepairs: [],
          remainingBudget: {
            durationMs: deliveryBudget(p).remainingExecutionMs,
            repairs: 2,
          },
          missingEvidence: [],
          omittedEvidence: [],
        }),
    ),
    review: vi.fn(async (request, callbacks) => {
      const p = requireDelivery(request.id.split(':progress:')[0]!, paths);
      expect(p.progress.assessments[0]?.state).toBe('in-flight');
      expect(p.progress.assessments[0]?.deadlineAt).toBe(
        new Date(request.deadlineAt).toISOString(),
      );
      await callbacks.onDispatched('submission');
      return {
        ...request.binding,
        decision,
        rationale: 'Bound synthetic assessment.',
        evidenceRefs: [`candidate:${request.packet.revision.candidateDigest}`],
        nextInstructions:
          decision === 'change-approach'
            ? 'Use another in-scope approach.'
            : null,
        submissionId: 'submission',
        totalTokens: 10,
        durationMs: 20,
        completedAt: new Date(
          request.deadlineAt - request.maxDurationMs + 20,
        ).toISOString(),
      };
    }),
  };
}
it.each(['continue', 'change-approach'] as const)(
  'persists admission and exact %s instructions once',
  async (decision) => {
    const p = failed(),
      adapter = io(decision);
    const approved = await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    );
    expect(approved?.instructions).toBe(
      decision === 'continue'
        ? 'Fix failure'
        : 'Use another in-scope approach.',
    );
    expect(
      requireDelivery(p.pipelineId, paths).progress.assessments[0],
    ).toMatchObject({
      state: 'settled',
      submissionId: 'submission',
      executionMs: 20,
    });
    expect(
      await checkpointDeliveryRepair(
        p,
        'Fix failure',
        'repair:verification',
        paths,
        adapter,
      ),
    ).toEqual(approved);
    expect(adapter.review).toHaveBeenCalledOnce();
  },
);
it('escalates without approval or an extra model invocation', async () => {
  const p = failed(),
    adapter = io('escalate');
  expect(
    await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(
    requireDelivery(p.pipelineId, paths).interventions.some(
      (i) => !i.resolution,
    ),
  ).toBe(true);
  expect(adapter.review).toHaveBeenCalledOnce();
});
it('unknown admission and repeated recovery retain the original reservation without redispatch', async () => {
  const p = failed(),
    adapter = io();
  adapter.review = vi.fn(async () => {
    throw new Error('lost admission');
  });
  await checkpointDeliveryRepair(
    p,
    'Fix failure',
    'repair:verification',
    paths,
    adapter,
  );
  const original = requireDelivery(p.pipelineId, paths).progress
    .assessments[0]!;
  for (let n = 0; n < 3; n++)
    await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths);
  const actual = requireDelivery(p.pipelineId, paths).progress.assessments[0]!;
  expect(actual).toEqual(original);
  expect(actual.state).toBe('uncertain');
  expect(adapter.review).toHaveBeenCalledOnce();
  expect(recoverExistingFactoryProgress).not.toHaveBeenCalled();
});
it('invalid IO result retains its reservation and cannot authorize repair', async () => {
  const p = failed(),
    adapter = io();
  const review = adapter.review;
  adapter.review = vi.fn(async (request, callbacks) => ({
    ...(await review(request, callbacks)),
    inputDigest: '9'.repeat(64),
  }));
  expect(
    await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments[0]?.state,
  ).toBe('uncertain');
});
it('changed authority during a model call invalidates its result', async () => {
  const p = failed(),
    adapter = io();
  const review = adapter.review;
  adapter.review = vi.fn(async (request, callbacks) => {
    const result = await review(request, callbacks);
    interveneDelivery(p.pipelineId, 'authority', 'Revoked', paths);
    return result;
  });
  adapter.assert = vi.fn<ProgressIO['assert']>(async (current) => {
    if (current.interventions.some((i) => !i.resolution))
      throw new Error('revoked');
  });
  expect(
    await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments[0]?.result,
  ).toBeNull();
});
it('missing packet input stops before judge admission', async () => {
  const p = failed(),
    adapter = io();
  adapter.packet = vi.fn(async () => {
    throw new Error('missing');
  });
  expect(
    await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(adapter.review).not.toHaveBeenCalled();
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments,
  ).toHaveLength(0);
});
it('revocation during asynchronous capture is fenced before judge dispatch', async () => {
  const p = failed(),
    adapter = io();
  let checks = 0;
  adapter.assert = vi.fn<ProgressIO['assert']>(async () => {
    checks++;
    if (checks === 3) {
      await Promise.resolve();
      interveneDelivery(
        p.pipelineId,
        'authority',
        'Revoked during capture',
        paths,
      );
    }
  });
  expect(
    await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(adapter.review).not.toHaveBeenCalled();
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments[0]?.result,
  ).toBeNull();
});
it('a changed request cannot reuse the same ordinal verdict or invoke another judge', async () => {
  const p = failed(),
    adapter = io();
  await checkpointDeliveryRepair(
    p,
    'Fix failure',
    'repair:verification',
    paths,
    adapter,
  );
  expect(
    await checkpointDeliveryRepair(
      p,
      'Different instruction',
      'repair:other',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(adapter.review).toHaveBeenCalledOnce();
});

async function interrupted() {
  const p = failed(),
    adapter = io(),
    packet = await adapter.packet(
      p,
      'Fix failure',
      'repair:verification',
      paths,
    );
  const binding = {
    assessmentId: 'progress-crash',
    grantId: p.authorization.id,
    revision: p.revision,
    repairOrdinal: 1,
    requestId: 'repair:verification',
    inputDigest: progressReviewInputDigest(packet, 'synthetic', 'medium'),
    evidenceDigest: deliveryProgressEvidenceDigest(p),
  };
  const { pipeline, assessment } = reserveDeliveryProgress(
    {
      pipelineId: p.pipelineId,
      expectedVersion: p.version,
      ...binding,
      instructions: 'Fix failure',
      evidenceRefs: progressEvidenceRefs(packet),
    },
    paths,
  );
  const request = v.parse(progressReviewRequestSchema, {
    id: `${p.pipelineId}:progress-crash`,
    binding,
    model: 'synthetic',
    thinkingLevel: 'medium',
    packet,
    maxDurationMs: assessment.reservedExecutionMs,
    deadlineAt: Date.parse(assessment.deadlineAt),
    maxTokens: 16000,
  });
  saveDeliveryIntent(
    p.pipelineId,
    `progress:${assessment.assessmentId}`,
    request,
    paths,
  );
  const started = updateDeliveryProgress(
    {
      pipelineId: p.pipelineId,
      expectedVersion: pipeline.version,
      assessmentId: assessment.assessmentId,
      action: { type: 'start' },
    },
    paths,
  );
  updateDeliveryProgress(
    {
      pipelineId: p.pipelineId,
      expectedVersion: started.version,
      assessmentId: assessment.assessmentId,
      action: { type: 'bind-submission', submissionId: 'submission' },
    },
    paths,
  );
  const result = {
    ...request.binding,
    decision: 'continue' as const,
    rationale: 'Demonstrated progress.',
    evidenceRefs: [`candidate:${p.revision.candidateDigest}`],
    nextInstructions: null,
    submissionId: 'submission',
    totalTokens: 10,
    durationMs: 20,
    completedAt: new Date(
      request.deadlineAt - request.maxDurationMs + 20,
    ).toISOString(),
  };
  return { p, assessment, request, result };
}
it('reconciles an on-time result after deadline without another judge', async () => {
  const { p, assessment, request, result } = await interrupted();
  vi.mocked(recoverExistingFactoryProgress).mockResolvedValue(result);
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(assessment.deadlineAt) + 1000,
  );
  expect(
    await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths),
  ).toBe(true);
  const settled = requireDelivery(p.pipelineId, paths).progress.assessments[0]!;
  expect(settled).toMatchObject({
    state: 'settled',
    executionMs: 20,
    result: { decision: 'continue' },
    completedAt: result.completedAt,
  });
  expect(recoverExistingFactoryProgress).toHaveBeenCalledWith(
    request,
    'submission',
  );
  expect(
    await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths),
  ).toBe(false);
  expect(recoverExistingFactoryProgress).toHaveBeenCalledOnce();
});
it('accounts a known reply after revocation without restoring repair permission', async () => {
  const { p, result } = await interrupted();
  interveneDelivery(p.pipelineId, 'authority', 'Human revoked', paths);
  vi.mocked(recoverExistingFactoryProgress).mockResolvedValue(result);
  await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths);
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments[0],
  ).toMatchObject({ state: 'settled', executionMs: 20, result: null });
});
it('known terminal model failure settles unknown usage with no approval', async () => {
  const { p, assessment } = await interrupted();
  vi.mocked(recoverExistingFactoryProgress).mockRejectedValue(
    new ReviewerTerminalError(
      'failed',
      'submission',
      assessment.reservedExecutionMs,
    ),
  );
  await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths);
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments[0],
  ).toMatchObject({
    state: 'settled',
    executionMs: null,
    result: null,
    completedAt: null,
  });
});
it('oversized retained intent is rejected before model reconciliation', async () => {
  const { p, assessment } = await interrupted();
  writeFileSync(
    deliveryIntentPath(
      p.pipelineId,
      `progress:${assessment.assessmentId}`,
      paths,
    ),
    ' '.repeat(1048577),
  );
  await expect(readProgressIntent(p, assessment, paths)).rejects.toThrow(
    /bound|limit|large|size/i,
  );
  await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths);
  expect(recoverExistingFactoryProgress).not.toHaveBeenCalled();
});

it('exhaustion prevents both packet gathering and model calls', async () => {
  const p = failed(10800000 - 10),
    adapter = io();
  expect(
    await checkpointDeliveryRepair(
      p,
      'Fix failure',
      'repair:verification',
      paths,
      adapter,
    ),
  ).toBeNull();
  expect(adapter.packet).not.toHaveBeenCalled();
  expect(adapter.review).not.toHaveBeenCalled();
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments,
  ).toHaveLength(0);
});

it.each(['scope', 'authority'] as const)(
  'a %s pause during final intent read preserves known usage without approval',
  async (kind) => {
    const { p, assessment, result } = await interrupted();
    const settling = settleDeliveryProgress(p, assessment, result, paths);
    interveneDelivery(
      p.pipelineId,
      kind,
      'Human paused during final read',
      paths,
    );
    await settling;
    const actual = requireDelivery(p.pipelineId, paths).progress
      .assessments[0]!;
    expect(actual).toMatchObject({
      state: 'settled',
      executionMs: 20,
      completedAt: result.completedAt,
      result: null,
    });
    expect(actual.resultId).not.toBeNull();
  },
);

it('restart with lost receipt aborts the known instance after its smaller deadline without readmission', async () => {
  const p = failed(10800000 - 1000),
    adapter = io();
  adapter.review = vi.fn(async () => {
    throw new Error('Receipt lost');
  });
  await checkpointDeliveryRepair(
    p,
    'Fix failure',
    'repair:verification',
    paths,
    adapter,
  );
  const original = requireDelivery(p.pipelineId, paths).progress
    .assessments[0]!;
  expect(original.reservedExecutionMs).toBeLessThan(180000);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.deadlineAt) + 1000);
  await recoverDeliveryProgress(requireDelivery(p.pipelineId, paths), paths);
  expect(cancelFactoryProgress).toHaveBeenCalledWith(
    `${p.pipelineId}:${original.assessmentId}`,
  );
  expect(adapter.review).toHaveBeenCalledOnce();
  expect(requireDelivery(p.pipelineId, paths).progress.assessments[0]).toEqual(
    original,
  );
});
it('unknown-admission abort acknowledgement is bounded and leaves uncertainty intact', async () => {
  const p = failed(),
    adapter = io();
  adapter.review = vi.fn(async () => {
    throw new Error('Receipt lost');
  });
  await checkpointDeliveryRepair(
    p,
    'Fix failure',
    'repair:verification',
    paths,
    adapter,
  );
  vi.mocked(cancelFactoryProgress).mockImplementation(
    () => new Promise(() => {}),
  );
  vi.useFakeTimers();
  const recovering = recoverDeliveryProgress(
    requireDelivery(p.pipelineId, paths),
    paths,
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await recovering).toBe(true);
  expect(
    requireDelivery(p.pipelineId, paths).progress.assessments[0],
  ).toMatchObject({
    state: 'uncertain',
    submissionId: null,
    executionMs: null,
  });
  expect(recoverExistingFactoryProgress).not.toHaveBeenCalled();
});
