import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  factoryDiagnosticSchema,
  factoryDiagnosticQuerySchema,
  factoryDiagnosticRetention,
  factoryWorkerHealthSchema,
  type FactoryDiagnostic,
  type FactoryWorkerHealth,
  type FactoryWorker,
} from '../../../shared/factory-observability';

const rowSchema = v.object({ record_json: v.string() });
export function appendDiagnostic(
  paths: RuntimePaths,
  input: FactoryDiagnostic,
) {
  const record = v.parse(factoryDiagnosticSchema, input);
  const db = openDb(paths.neondeckDatabase, { timeout: 0 });
  try {
    withImmediateTransaction(db, () => {
      db.prepare(
        'INSERT INTO factory_diagnostics(work_item_id,finished_at,record_json) VALUES(?,?,?)',
      ).run(
        record.correlation.workItemId ?? null,
        record.finishedAt,
        JSON.stringify(record),
      );
      db.prepare('DELETE FROM factory_diagnostics WHERE finished_at < ?').run(
        new Date(
          Date.now() - factoryDiagnosticRetention.maxAgeMs,
        ).toISOString(),
      );
      db.prepare(
        'DELETE FROM factory_diagnostics WHERE sequence NOT IN (SELECT sequence FROM factory_diagnostics ORDER BY sequence DESC LIMIT ?)',
      ).run(factoryDiagnosticRetention.maxRecords);
    });
  } finally {
    db.close();
  }
}
export function listFactoryDiagnostics(paths: RuntimePaths, raw: unknown = {}) {
  const query = v.parse(factoryDiagnosticQuerySchema, raw);
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT sequence,record_json FROM factory_diagnostics WHERE finished_at >= ? AND (? IS NULL OR work_item_id=?) AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        new Date(
          Date.now() - factoryDiagnosticRetention.maxAgeMs,
        ).toISOString(),
        query.workItemId ?? null,
        query.workItemId ?? null,
        query.before ?? null,
        query.before ?? null,
        query.limit + 1,
      );
    const records = rows.slice(0, query.limit).map((row) => {
      const parsed = v.parse(
        v.object({ sequence: v.number(), record_json: v.string() }),
        row,
      );
      return v.parse(factoryDiagnosticSchema, {
        ...v.parse(factoryDiagnosticSchema, JSON.parse(parsed.record_json)),
        sequence: parsed.sequence,
      });
    });
    return {
      records,
      nextBefore: rows.length > query.limit ? records.at(-1)!.sequence : null,
    };
  } finally {
    db.close();
  }
}
export function readWorker(paths: RuntimePaths, worker: FactoryWorker) {
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT record_json FROM factory_worker_health WHERE worker=?')
      .get(worker);
    return row
      ? v.parse(
          factoryWorkerHealthSchema,
          JSON.parse(v.parse(rowSchema, row).record_json),
        )
      : null;
  } finally {
    db.close();
  }
}
export function saveWorker(paths: RuntimePaths, input: FactoryWorkerHealth) {
  const record = v.parse(factoryWorkerHealthSchema, input);
  const db = openDb(paths.neondeckDatabase, { timeout: 0 });
  try {
    db.prepare(
      'INSERT INTO factory_worker_health(worker,record_json) VALUES(?,?) ON CONFLICT(worker) DO UPDATE SET record_json=excluded.record_json',
    ).run(record.worker, JSON.stringify(record));
  } finally {
    db.close();
  }
}
