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
    const retainedSince = new Date(
      Date.now() - factoryDiagnosticRetention.maxAgeMs,
    ).toISOString();
    // Either representation can identify a candidate; neither grants authority.
    // Guard extraction so malformed retained JSON reaches the decoder below.
    const rows = db
      .prepare(
        `SELECT sequence,work_item_id,finished_at,record_json FROM factory_diagnostics
         WHERE (finished_at >= ? OR CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.finishedAt') END >= ?)
           AND (? IS NULL OR work_item_id=? OR CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.correlation.workItemId') END = ?)
           AND (? IS NULL OR sequence < ?)
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        retainedSince,
        retainedSince,
        query.workItemId ?? null,
        query.workItemId ?? null,
        query.workItemId ?? null,
        query.before ?? null,
        query.before ?? null,
        query.limit + 1,
      );
    // Validate the bounded lookahead row too: it determines pagination coverage.
    const retained = rows.map((row) => {
      const parsed = v.parse(
        v.object({
          sequence: v.number(),
          work_item_id: v.nullable(v.string()),
          finished_at: v.string(),
          record_json: v.string(),
        }),
        row,
      );
      const record = v.parse(
        v.pipe(
          factoryDiagnosticSchema,
          v.check(
            (record) =>
              (record.correlation.workItemId ?? null) === parsed.work_item_id &&
              record.finishedAt === parsed.finished_at &&
              (query.workItemId === undefined ||
                record.correlation.workItemId === query.workItemId),
            'Retained diagnostic binding is inconsistent.',
          ),
        ),
        JSON.parse(parsed.record_json),
      );
      // appendDiagnostic stores the caller's placeholder; SQLite owns this cursor.
      return v.parse(factoryDiagnosticSchema, {
        ...record,
        sequence: parsed.sequence,
      });
    });
    const records = retained.slice(0, query.limit);
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
      .prepare(
        'SELECT worker,record_json FROM factory_worker_health WHERE worker=?',
      )
      .get(worker);
    if (!row) return null;
    const parsed = v.parse(
      v.object({ worker: v.string(), record_json: v.string() }),
      row,
    );
    return v.parse(
      v.pipe(
        factoryWorkerHealthSchema,
        v.check(
          (record) =>
            record.worker === parsed.worker && record.worker === worker,
          'Retained worker binding is inconsistent.',
        ),
      ),
      JSON.parse(parsed.record_json),
    );
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
