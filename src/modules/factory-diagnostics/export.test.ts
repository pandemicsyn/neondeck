import { expect, it } from 'vitest';
import { serializeDiagnosticExport } from './export';
import { exportFixture } from './export-fixture.test-helper';
it('exports fractional durations and trace correlation while excluding free text and private identities', () => {
  const snapshot = exportFixture();
  const text = serializeDiagnosticExport(snapshot);
  expect(snapshot.diagnostics.spans[0].durationMs).toBe(0.34567);
  expect(snapshot.diagnostics.spans[0].operation).toBe('delivery.review');
  expect(snapshot.diagnostics.spans[0].error?.code).toBe('TIMEOUT');
  expect(snapshot.diagnostics.spans[1].parentSpanId).toBe(
    snapshot.diagnostics.spans[0].id,
  );
  expect(snapshot.diagnostics.spans[0].correlation.workItemId).toBe(
    snapshot.workId,
  );
  expect(text).not.toMatch(
    /private-actor|private-run|Private task|span-private|trace-private|work-test/,
  );
  expect(() =>
    serializeDiagnosticExport({ ...snapshot, rawLogs: 'secret' }),
  ).toThrow();
});
it('retains incomplete health and task coverage flags in a strict export', async () => {
  const { createDiagnosticExport } = await import('./export');
  const { diagnoseHealth } = await import('./health');
  const { taskFixture, workerFixture, recordedAt } =
    await import('./fixture.test-helper');
  const { timelinePage } = await import('./timeline');
  const records = taskFixture();
  records.truncated = true;
  const snapshot = createDiagnosticExport(
    diagnoseHealth([records], [workerFixture()], recordedAt),
    timelinePage(records, {}),
    { records: [], nextBefore: null },
  );
  expect(snapshot.health).toMatchObject({
    status: 'attention',
    truncated: true,
    tasks: [{ truncated: true }],
  });
});

it('exports the newest 100 entries including recent failures and undated current states', async () => {
  const { createDiagnosticExport } = await import('./export');
  const { diagnoseHealth } = await import('./health');
  const { taskFixture, workerFixture, recordedAt } =
    await import('./fixture.test-helper');
  const { timelinePage, timelinePreview } = await import('./timeline');
  const records = taskFixture();
  for (let id = 2; id <= 150; id++)
    records.audit.push({
      id,
      action: 'old',
      actor: 'actor',
      createdAt: recordedAt,
    });
  const recent = '2026-09-08T12:00:00.000Z';
  records.audit.push({
    id: 151,
    action: 'delivery-failed',
    actor: 'actor',
    createdAt: recent,
  });
  records.receipts.push({
    id: 'latest-current-state',
    intentId: 'intent',
    effect: {
      kind: 'proposal',
      inputHash: 'a'.repeat(64),
      result: { version: 2, hash: 'b'.repeat(64) },
    },
  });
  const preview = timelinePreview(records);
  expect(preview.entries).toHaveLength(100);
  expect(preview.nextCursor).toBeNull();
  expect(preview.coverage.truncated).toBe(true);
  expect(preview.entries.slice(-2).map((entry) => entry.id)).toEqual([
    'audit:151',
    'planning-receipt:latest-current-state',
  ]);
  expect(preview.entries.some((entry) => entry.id === 'audit:1')).toBe(false);
  const firstPage = timelinePage(records, { limit: 100 });
  expect(firstPage.entries[0].id).toBe('audit:1');
  expect(firstPage.entries.some((entry) => entry.id === 'audit:151')).toBe(
    false,
  );
  const snapshot = createDiagnosticExport(
    diagnoseHealth([records], [workerFixture()], recent),
    preview,
    { records: [], nextBefore: null },
  );
  expect(snapshot.timeline.truncated).toBe(true);
  expect(snapshot.timeline.entries).toHaveLength(100);
  expect(snapshot.timeline.entries.at(-2)?.occurredAt).toBe(recent);
  expect(snapshot.timeline.entries.at(-1)?.kind).toBe('planning-receipt');
});
it('marks preview truncation only when projection or window coverage is incomplete', async () => {
  const { taskFixture, recordedAt } = await import('./fixture.test-helper');
  const { timelinePreview } = await import('./timeline');
  const records = taskFixture();
  for (let id = 2; id <= 98; id++)
    records.audit.push({
      id,
      action: 'old',
      actor: 'actor',
      createdAt: recordedAt,
    });
  expect(timelinePreview(records).entries).toHaveLength(100);
  expect(timelinePreview(records).coverage.truncated).toBe(false);
  records.truncated = true;
  expect(timelinePreview(records).coverage.truncated).toBe(true);
});
