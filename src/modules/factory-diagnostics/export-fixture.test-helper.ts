import * as v from 'valibot';
import { factoryDiagnosticSchema } from '../../../shared/factory-observability';
import { createDiagnosticExport } from './export';
import { taskFixture, workerFixture, recordedAt } from './fixture.test-helper';
import { diagnoseHealth } from './health';
import { timelinePage } from './timeline';
export function exportFixture() {
  const records = taskFixture();
  const span = v.parse(factoryDiagnosticSchema, {
    sequence: 1,
    id: 'span-private',
    traceId: 'trace-private',
    parentSpanId: null,
    operation: 'delivery.review',
    kind: 'phase',
    startedAt: recordedAt,
    finishedAt: recordedAt,
    durationMs: 0.34567,
    outcome: 'failure',
    correlation: { workItemId: records.work.id, runId: 'private-run' },
    error: { class: 'timeout', code: 'TIMEOUT' },
  });
  return createDiagnosticExport(
    diagnoseHealth([records], [workerFixture()], recordedAt),
    timelinePage(records, {}),
    {
      records: [span, { ...span, id: 'child-private', parentSpanId: span.id }],
      nextBefore: null,
    },
  );
}
