import type { DatabaseSync } from 'node:sqlite';
import type { LinearConnection } from '../../../shared/factory-linear';
import { linearFingerprint } from './linear-config';
import { linearRecords, putLinearRecord } from './linear-store';

/** Source identity/admission authority is independent of outbound writeback consent. */
export function linearSourceProjection(connection: LinearConnection) {
  return {
    id: connection.id,
    enabled: connection.enabled,
    organizationId: connection.organizationId,
    teamId: connection.teamId,
    projectId: connection.projectId,
    repoId: connection.repoId,
    tokenEnv: connection.tokenEnv,
    webhookSecretEnv: connection.webhookSecretEnv,
    admission: connection.admission,
  };
}
export function linearSourceFingerprint(connection: LinearConnection) {
  return linearFingerprint(linearSourceProjection(connection));
}
export function matchesLinearSourceBinding(
  record: { connectionFingerprint: string; sourceFingerprint?: string },
  connection: LinearConnection,
) {
  return record.sourceFingerprint === undefined
    ? record.connectionFingerprint === linearFingerprint(connection)
    : record.sourceFingerprint === linearSourceFingerprint(connection);
}

/** Upgrade only evidence proven against the trusted pre-change configuration. */
export function bindLegacyLinearSourceRecords(
  db: DatabaseSync,
  beforeConnections: LinearConnection[],
) {
  for (const kind of ['delivery', 'writeback'] as const) {
    for (const record of linearRecords(db, kind)) {
      if (record.sourceFingerprint !== undefined) continue;
      if (record.kind === 'delivery' && record.state === 'complete') continue;
      const before = beforeConnections.find(
        (connection) => connection.id === record.connectionId,
      );
      if (!before || record.connectionFingerprint !== linearFingerprint(before))
        continue;
      putLinearRecord(db, {
        ...record,
        sourceFingerprint: linearSourceFingerprint(before),
      });
    }
  }
}
