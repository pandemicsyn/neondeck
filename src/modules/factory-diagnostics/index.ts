import * as v from 'valibot';
import {
  factoryDiagnosticWorkIdSchema,
  factoryTimelineQuerySchema,
} from '../../../shared/factory-diagnostics';
import type { RuntimePaths } from '../../runtime-home';
import {
  getFactoryWorkerHealth,
  listFactoryDiagnostics,
} from '../factory-observability';
import {
  diagnosticRead,
  readTaskRecords,
  readTaskHealthRecords,
  readTaskIds,
  withDiagnosticDatabase,
} from './records';
import { diagnoseHealth } from './health';
import { timelinePage } from './timeline';
import { createDiagnosticExport } from './export';
export { DiagnosticsError } from './records';
export { serializeDiagnosticExport } from './export';
export function getFactoryTaskTimeline(
  workId: unknown,
  query: unknown,
  paths: RuntimePaths,
) {
  const id = v.parse(factoryDiagnosticWorkIdSchema, workId);
  const parsedQuery = v.parse(factoryTimelineQuerySchema, query);
  return withDiagnosticDatabase(paths, (db) =>
    timelinePage(readTaskRecords(db, id), parsedQuery),
  );
}
export function getFactoryDiagnosticsHealth(
  paths: RuntimePaths,
  workId?: unknown,
) {
  const id =
    workId === undefined
      ? undefined
      : v.parse(factoryDiagnosticWorkIdSchema, workId);
  const generatedAt = new Date().toISOString();
  const workers = diagnosticRead(() => getFactoryWorkerHealth(paths));
  return withDiagnosticDatabase(paths, (db) => {
    const ids = id === undefined ? readTaskIds(db) : [id];
    return diagnoseHealth(
      ids.slice(0, 50).map((taskId) => readTaskHealthRecords(db, taskId)),
      workers,
      generatedAt,
      ids.length > 50,
    );
  });
}
export function previewFactoryDiagnostics(
  workId: unknown,
  paths: RuntimePaths,
) {
  const id = v.parse(factoryDiagnosticWorkIdSchema, workId);
  const generatedAt = new Date().toISOString();
  const workers = diagnosticRead(() => getFactoryWorkerHealth(paths));
  const diagnostics = diagnosticRead(() =>
    listFactoryDiagnostics(paths, {
      workItemId: id,
      limit: 100,
    }),
  );
  return withDiagnosticDatabase(paths, (db) => {
    const records = readTaskRecords(db, id);
    return createDiagnosticExport(
      diagnoseHealth([readTaskHealthRecords(db, id)], workers, generatedAt),
      timelinePage(records, { limit: 100 }),
      diagnostics,
    );
  });
}
