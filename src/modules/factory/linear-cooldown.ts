import * as v from 'valibot';
import type { LinearConnection } from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import { LinearApiError } from '../linear';
import { dbRun } from './service';
import { linearFingerprint } from './linear-config';
import {
  linearRecords,
  linearSyncSchema,
  putLinearRecord,
} from './linear-store';

/** One durable provider cooldown shared by discovery, retained reads and effects. */
export function linearCoolingDown(connectionId: string, paths: RuntimePaths) {
  return dbRun(paths, (db) => {
    const row = linearRecords(db, 'sync', {
      id: `cooldown:${connectionId}`,
    })[0];
    if (!row) return false;
    if (row.retryAt > Date.now()) return true;
    if (row.error)
      putLinearRecord(db, { ...row, state: 'complete', error: null });
    return false;
  });
}
export function retainLinearRateLimit(
  error: unknown,
  connection: LinearConnection,
  paths: RuntimePaths,
) {
  if (
    !(error instanceof LinearApiError) ||
    (!error.rateLimited && error.status !== 429)
  )
    return false;
  dbRun(paths, (db) => {
    const id = `cooldown:${connection.id}`;
    const previous = linearRecords(db, 'sync', { id })[0];
    const retryAt = Math.max(
      previous?.retryAt ?? 0,
      Number.isFinite(error.retryAt) ? error.retryAt : Date.now() + 60000,
      Date.now() + 1000,
    );
    putLinearRecord(
      db,
      v.parse(linearSyncSchema, {
        id,
        kind: 'sync',
        connectionId: connection.id,
        connectionFingerprint: linearFingerprint(connection),
        state: 'attention',
        error:
          'Linear rate limit reached. Provider requests are paused until the retry time.',
        retryAt,
        attempts: 0,
      }),
    );
  });
  return true;
}
