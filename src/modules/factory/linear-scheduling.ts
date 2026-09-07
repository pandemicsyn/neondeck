import * as v from 'valibot';
import type { LinearConnection } from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import { dbRun } from './service';
import {
  linearRecords,
  linearScheduleSchema,
  putLinearRecord,
} from './linear-store';

/** Rotate the starting connection once per tick, independent of visits completed. */
export function scheduledLinearConnections(
  connections: LinearConnection[],
  paths: RuntimePaths,
  worker: 'source' | 'writeback' = 'source',
) {
  if (!connections.length) return [];
  return dbRun(paths, (db) => {
    const id =
      worker === 'source'
        ? 'connection-schedule'
        : 'writeback-connection-schedule';
    const offset =
      (linearRecords(db, 'schedule', { id })[0]?.offset ?? 0) %
      connections.length;
    putLinearRecord(
      db,
      v.parse(linearScheduleSchema, {
        id,
        kind: 'schedule',
        offset: (offset + 1) % connections.length,
      }),
    );
    return [...connections.slice(offset), ...connections.slice(0, offset)];
  });
}

/** Rotate which provider phase receives the fresh connection budget on each tick. */
export function scheduledLinearPhases(
  connectionId: string,
  paths: RuntimePaths,
) {
  const phases = ['delivery', 'discovery', 'retained'] as const;
  const id = `phase:${connectionId}`;
  return dbRun(paths, (db) => {
    const offset =
      (linearRecords(db, 'schedule', { id })[0]?.offset ?? 0) % phases.length;
    putLinearRecord(
      db,
      v.parse(linearScheduleSchema, {
        id,
        kind: 'schedule',
        offset: (offset + 1) % phases.length,
      }),
    );
    return [...phases.slice(offset), ...phases.slice(0, offset)];
  });
}
