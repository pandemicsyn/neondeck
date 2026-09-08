import * as v from 'valibot';
import { validationAdmissionAttentionSchema } from '../../../shared/factory-coding';
import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { publishFactoryChange } from './events';
const key = (runId: string) =>
  `factory-validation-attention:${v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), runId)}`;
export function readValidationAttention(runId: string, paths: RuntimePaths) {
  const db = openDb(paths.neondeckDatabase);
  try {
    const row = db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(key(runId));
    return row
      ? v.parse(
          validationAdmissionAttentionSchema,
          JSON.parse(v.parse(v.string(), row.value)),
        )
      : null;
  } finally {
    db.close();
  }
}
export function saveValidationAttention(
  runId: string,
  raw: unknown,
  paths: RuntimePaths,
) {
  const value = v.parse(validationAdmissionAttentionSchema, raw);
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    ).run(key(runId), JSON.stringify(value), value.observedAt);
  } finally {
    db.close();
  }
  publishFactoryChange();
}
export function clearValidationAttention(runId: string, paths: RuntimePaths) {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('DELETE FROM app_metadata WHERE key=?').run(key(runId));
  } finally {
    db.close();
  }
  publishFactoryChange();
}
