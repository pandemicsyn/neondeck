import type { LinearConnection } from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import { dbRun } from './service';
import { linearConnections, linearFingerprint } from './linear-config';
import {
  linearSourceFingerprint,
  matchesLinearSourceBinding,
} from './linear-authority';
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
    for (const delivery of linearRecords(db, 'delivery', {
      state: 'pending',
      excludeConnectionIds: currentConnections
        .filter((c) => c.enabled)
        .map((c) => c.id),
      oldestFirst: true,
      limit: 25,
    }))
      putLinearRecord(db, {
        ...delivery,
        state: 'attention',
        error:
          'Connection was removed or disabled; retained delivery requires review.',
      });
  });
  for (const c of connections) {
    if (signal?.aborted) return;
    const current = currentConnections.find(
      (connection) => connection.id === c.id,
    );
    dbRun(paths, (db) => {
      // Changed bindings cannot become valid through provider/credential retries.
      // Select them independently so valid older pending rows cannot hide them.
      if (current?.enabled)
        for (const delivery of linearRecords(db, 'delivery', {
          connectionId: current.id,
          state: 'pending',
          sourceBindingMismatch: {
            sourceFingerprint: linearSourceFingerprint(current),
            connectionFingerprint: linearFingerprint(current),
          },
          oldestFirst: true,
          limit: 25,
        }))
          putLinearRecord(db, {
            ...delivery,
            state: 'attention',
            error: 'Connection changed; request a new sync.',
          });
      for (const delivery of linearRecords(db, 'delivery', {
        connectionId: c.id,
        action: 'remove',
        state: 'pending',
        retryAtLte: Date.now(),
        oldestFirst: true,
        limit: 25,
      })) {
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
