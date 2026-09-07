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
