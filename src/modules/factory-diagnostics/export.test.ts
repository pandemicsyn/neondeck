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
