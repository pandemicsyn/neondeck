import type { LinearConnection } from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import { dbRun } from './service';
import { linearConnections } from './linear-config';
import { matchesLinearSourceBinding } from './linear-authority';
import { linearRecords, putLinearRecord } from './linear-store';
import { reconcileLinearSource } from './linear-source';
/** Revoke known removals across all mappings before any provider request. */
export function processLinearRemovals(
  connections: LinearConnection[],
  paths: RuntimePaths,
  signal?: AbortSignal,
) {
  // Authentication was completed at ingress. Apply only the unchanged current
  // binding; losing provider credentials must not delay local revocation.
  const currentConnections = linearConnections(paths);
  if (signal?.aborted) return;
  dbRun(paths, (db) => {
    for (const delivery of linearRecords(db, 'delivery')
      .filter(
        (row) =>
          row.action === 'remove' &&
          row.state === 'pending' &&
          !currentConnections.some(
            (connection) => connection.id === row.connectionId,
          ),
      )
      .slice(0, 25))
      putLinearRecord(db, {
        ...delivery,
        state: 'attention',
        error: 'Connection was removed; retained delivery requires review.',
      });
  });
  for (const c of connections) {
    if (signal?.aborted) return;
    const current = currentConnections.find(
      (connection) => connection.id === c.id,
    );
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
        if (
          !current?.enabled ||
          !matchesLinearSourceBinding(delivery, current)
        ) {
          putLinearRecord(db, {
            ...delivery,
            state: 'attention',
            error: 'Connection changed; request a new sync.',
          });
          continue;
        }
        reconcileLinearSource(
          db,
          current,
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
