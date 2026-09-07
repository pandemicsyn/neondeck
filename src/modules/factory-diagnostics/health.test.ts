import { expect, it } from 'vitest';
import * as v from 'valibot';
import { writebackEffectSchema } from '../../../shared/factory-writeback';
import { diagnoseHealth, diagnoseTask } from './health';
import { taskFixture, workerFixture, recordedAt } from './fixture.test-helper';
it('distinguishes partial outage from all workers stopped and healthy workers', () => {
  expect(
    diagnoseHealth([], [workerFixture(), workerFixture('stopped')], recordedAt)
      .status,
  ).toBe('attention');
  expect(
    diagnoseHealth([], [workerFixture('stopped')], recordedAt).status,
  ).toBe('not-running');
  expect(diagnoseHealth([], [workerFixture()], recordedAt).status).toBe(
    'healthy',
  );
  expect(
    diagnoseHealth(
      [],
      [{ ...workerFixture(), diagnosticsDegraded: true }],
      recordedAt,
    ).status,
  ).toBe('attention');
});
it('reports recorded pending age and known retry without treating sent effects as unresolved', () => {
  const records = taskFixture();
  const effect = v.parse(writebackEffectSchema, {
    id: 'effect',
    workId: records.work.id,
    connectionId: 'connection',
    issueId: 'issue',
    number: 1,
    connectionFingerprint: 'f',
    epoch: 'e',
    kind: 'status',
    body: 'do not export',
    bodyHash: 'h',
    marker: 'm',
    specVersion: 1,
    sourceVersion: 1,
    workVersion: 1,
    approvalId: null,
    state: 'sent',
    remoteId: null,
    author: null,
    confirmedBody: null,
    confirmedUpdatedAt: null,
    error: null,
    attempts: 1,
    retryAt: Date.parse(recordedAt) + 10000,
    createdAt: recordedAt,
  });
  records.writeback.push(effect);
  expect(diagnoseTask(records, Date.parse(recordedAt) + 5000)).toMatchObject({
    pendingAgeMs: 5000,
    unresolvedEffects: [],
    nextRetryAt: null,
  });
  effect.state = 'failed';
  expect(diagnoseTask(records, Date.parse(recordedAt) + 5000)).toMatchObject({
    status: 'writeback-pending',
    pendingAgeMs: 5000,
    nextRetryAt: '2026-09-07T12:00:10.000Z',
  });
  effect.state = 'uncertain';
  expect(diagnoseTask(records, Date.parse(recordedAt) + 5000)).toMatchObject({
    status: 'needs-reconciliation',
    pendingSince: null,
    pendingAgeMs: null,
    nextRetryAt: null,
  });
});
it('retains execution reservations during ambiguous delivery effects instead of refilling budget', async () => {
  const { createHash } = await import('node:crypto');
  const { deliveryPipelineSchema } =
    await import('../../../shared/factory-delivery');
  const records = taskFixture();
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
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'repo',
        revision.runId,
        revision.attemptId,
        revision.candidateDigest,
      ]),
    )
    .digest('hex');
  const delivery = v.parse(deliveryPipelineSchema, {
    pipelineId: key,
    version: 1,
    workItemId: records.work.id,
    repoId: 'repo',
    initialRevision: revision,
    revision,
    branch: `agent/factory-${key}`,
    prIdentity: `neondeck-factory:${key}`,
    pr: null,
    authorization: {
      id: 'grant',
      authorizedBy: 'actual-human',
      authorizedAt: recordedAt,
      revision,
      repoId: 'repo',
      target: { owner: 'example', name: 'repo', baseBranch: 'main' },
      configFingerprint: 'f'.repeat(64),
      checkCommands: ['npm test'],
      maxRepairAttempts: 2,
      totalExecutionMs: 10000,
      initialExecutionMs: 2000,
    },
    repairs: [],
    evidence: [],
    effects: [
      {
        id: 'review-effect',
        kind: 'review',
        revision,
        state: 'uncertain',
        receiptRef: null,
        reservedExecutionMs: 3000,
        executionMs: null,
      },
    ],
    interventions: [],
    commits: [],
    coordinator: {
      candidateRef: null,
      watchId: null,
      observationFingerprint: null,
      terminalObservedAt: null,
    },
    outcome: null,
    outcomeRef: null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
  records.deliveries.push(delivery);
  expect(diagnoseTask(records, Date.parse(recordedAt) + 999999)).toMatchObject({
    status: 'needs-reconciliation',
    pendingSince: null,
    budgets: [
      {
        consumedExecutionMs: 2000,
        reservedExecutionMs: 3000,
        remainingExecutionMs: 5000,
        repairsRemaining: 2,
      },
    ],
  });
  delivery.effects[0].state = 'in-flight';
  expect(diagnoseTask(records, Date.parse(recordedAt))).toMatchObject({
    status: 'delivery-pending',
  });
  const { projectTimeline } = await import('./timeline');
  delivery.repairs.push({
    runId: 'repair-target',
    attemptId: 'repair-attempt',
    requestId: 'repair-request',
    reservedExecutionMs: 1000,
    executionMs: null,
    fromRevision: revision,
    progressAssessmentId: null,
    progressInputDigest: null,
    progressEvidenceDigest: null,
    status: 'reserved',
    revision: null,
    reason: 'Synthetic repair',
  });
  const entries = projectTimeline(records).entries;
  expect(entries.find((e) => e.kind === 'repair')).toMatchObject({
    revision,
    correlation: { runId: revision.runId, attemptId: revision.attemptId },
    repairTarget: { runId: 'repair-target', attemptId: 'repair-attempt' },
  });
  expect(entries.find((e) => e.kind === 'authorization')).toMatchObject({
    occurredAt: recordedAt,
    actor: { kind: 'human', id: 'actual-human' },
    revision,
  });
  expect(entries.find((e) => e.kind === 'effect')).toMatchObject({
    occurredAt: null,
    actor: null,
    revision,
    correlation: { effectId: 'review-effect' },
  });
});
it('never reports healthy when global or task coverage is incomplete', () => {
  const records = taskFixture();
  expect(
    diagnoseHealth([records], [workerFixture()], recordedAt, true),
  ).toMatchObject({ status: 'attention', truncated: true });
  records.truncated = true;
  expect(
    diagnoseHealth([records], [workerFixture()], recordedAt),
  ).toMatchObject({
    status: 'attention',
    truncated: true,
    tasks: [{ truncated: true }],
  });
});
