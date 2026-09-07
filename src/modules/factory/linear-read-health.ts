import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import type { LinearConnection } from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import { dbRun } from './service';
import { linearFingerprint } from './linear-config';
import {
  linearReadFailureSchema,
  linearRecords,
  putLinearRecord,
} from './linear-store';
const key = (sourceId: string) => `retained:${sourceId}`;
export function clearLinearReadFailure(db: DatabaseSync, sourceId: string) {
  db.prepare(
    "DELETE FROM factory_linear_records WHERE id=? AND kind='read-failure'",
  ).run(key(sourceId));
}
export function linearReadFailure(sourceId: string, paths: RuntimePaths) {
  return dbRun(
    paths,
    (db) => linearRecords(db, 'read-failure', { id: key(sourceId) })[0],
  );
}
export function recordLinearReadFailure(
  connection: LinearConnection,
  sourceId: string,
  issueId: string,
  aborted: boolean,
  paths: RuntimePaths,
) {
  dbRun(paths, (db) => {
    const id = key(sourceId);
    const previous = linearRecords(db, 'read-failure', { id })[0];
    putLinearRecord(
      db,
      v.parse(linearReadFailureSchema, {
        id,
        kind: 'read-failure',
        connectionId: connection.id,
        connectionFingerprint: linearFingerprint(connection),
        issueId,
        state: 'pending',
        error:
          'Linear source refresh failed; retrying without changing task authority.',
        retryAt: Date.now() + 60000,
        attempts: (previous?.attempts ?? 0) + (aborted ? 0 : 1),
      }),
    );
  });
}
