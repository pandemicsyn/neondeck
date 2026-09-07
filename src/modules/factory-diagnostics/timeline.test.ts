import * as v from 'valibot';
import { expect, it } from 'vitest';
import { projectTimeline, timelinePage } from './timeline';
import { taskFixture, recordedAt } from './fixture.test-helper';
it('paginates timestamp ties deterministically and retries the same cursor without gaps', () => {
  const records = taskFixture();
  for (let id = 2; id < 45; id++)
    records.audit.push({
      id,
      action: 'spec-saved',
      actor: 'actor',
      createdAt: recordedAt,
    });
  const expected = projectTimeline(records).entries.map((e) => e.id);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = timelinePage(records, {
      limit: 7,
      ...(cursor ? { cursor } : {}),
    });
    expect(
      timelinePage(records, { limit: 7, ...(cursor ? { cursor } : {}) }),
    ).toEqual(page);
    ids.push(...page.entries.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(expected);
  expect(new Set(ids).size).toBe(ids.length);
});
it('rejects changed snapshots, foreign cursors and invalid bounds rather than silently omitting changes', () => {
  const records = taskFixture();
  const page = timelinePage(records, { limit: 1 });
  expect(() => timelinePage(records, { limit: 101 })).toThrow();
  expect(() => timelinePage(records, { cursor: 'invalid' })).toThrow(
    'Invalid timeline cursor',
  );
  records.audit.push({
    id: 2,
    action: 'released',
    actor: 'actor',
    createdAt: recordedAt,
  });
  expect(() => timelinePage(records, { cursor: page.nextCursor })).toThrow(
    'Task history changed',
  );
  records.work.id = 'other';
  expect(() => timelinePage(records, { cursor: page.nextCursor })).toThrow(
    'another task',
  );
});
it('keeps source attribution and unknown timestamps distinct from audit', () => {
  const records = taskFixture();
  records.receipts.push({
    id: 'receipt',
    intentId: 'intent',
    effect: {
      kind: 'proposal',
      inputHash: 'a'.repeat(64),
      result: { version: 2, hash: 'b'.repeat(64) },
    },
  });
  const entries = projectTimeline(records).entries;
  expect(entries.find((e) => e.kind === 'audit')?.actor).toEqual({
    kind: 'unknown',
    id: 'private-actor',
  });
  expect(entries.find((e) => e.kind === 'spec')?.actor?.kind).toBe('human');
  expect(entries.at(-1)).toMatchObject({
    kind: 'planning-receipt',
    occurredAt: null,
    timeBasis: 'unknown',
    actor: null,
    recordType: 'record',
    correlation: { specVersion: 2, specHash: 'b'.repeat(64) },
  });
});

it('selects globally newest entries even when early sources fill the projection', async () => {
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
  delivery.outcome = 'closed';
  delivery.coordinator.terminalObservedAt = '2026-09-08T12:00:00.000Z';
  delivery.authorization.authorizedAt = '2026-09-08T11:00:00.000Z';
  records.deliveries.push(delivery);

  for (let id = 2; id <= 2100; id++)
    records.audit.push({
      id,
      action: 'old',
      actor: 'actor',
      createdAt: recordedAt,
    });
  const projection = projectTimeline(records);
  expect(projection.truncated).toBe(true);
  expect(projection.entries).toHaveLength(2000);
  expect(projection.entries.slice(-3).map((entry) => entry.kind)).toEqual([
    'authorization',
    'outcome',
    'effect',
  ]);
  const retainedIds = projection.entries.map((entry) => entry.id);
  const chronologicalIds = [
    ...records.audit.map((entry) => `audit:${entry.id}`),
    `spec:${records.work.id}:1`,
    `task:${records.work.id}`,
  ].sort();
  expect(retainedIds.slice(0, -3)).toEqual(chronologicalIds.slice(-1997));
  records.audit.reverse();
  expect(projectTimeline(records).entries.map((entry) => entry.id)).toEqual(
    retainedIds,
  );
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query = { limit: 100, ...(cursor ? { cursor } : {}) };
    const page = timelinePage(records, query);
    expect(timelinePage(records, query)).toEqual(page);
    ids.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(retainedIds);
  expect(new Set(ids).size).toBe(2000);
});
