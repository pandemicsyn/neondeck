import type { LinearConnection } from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import { dbRun } from './service';
import { linearFingerprint, linearReadiness } from './linear-config';
import { linearRecords, putLinearRecord } from './linear-store';
import { reconcileLinearSource } from './linear-source';
/** Revoke known removals across all mappings before any provider request. */
export function processLinearRemovals(
  connections: LinearConnection[],
  paths: RuntimePaths,
  signal?: AbortSignal,
) {
  for (const c of connections) {
    if (signal?.aborted) return;
    if (linearReadiness(c, paths).length) continue;
    const fingerprint = linearFingerprint(c);
    dbRun(paths, (db) => {
      for (const delivery of linearRecords(db, 'delivery', {
        connectionId: c.id,
      })
        .filter(
          (row) =>
            row.action === 'remove' &&
            row.state === 'pending' &&
            row.retryAt <= Date.now(),
        )
        .slice(0, 25)) {
        if (delivery.connectionFingerprint !== fingerprint) {
          putLinearRecord(db, {
            ...delivery,
            state: 'attention',
            error: 'Connection changed; request a new sync.',
          });
          continue;
        }
        reconcileLinearSource(
          db,
          c,
          null,
          delivery.issueId,
          paths,
          delivery.createdAt,
        );
        putLinearRecord(db, { ...delivery, state: 'complete', error: null });
      }
    });
  }
}
