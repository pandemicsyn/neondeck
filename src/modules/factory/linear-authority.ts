import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import type { LinearConnection } from '../../../shared/factory-linear';
import { linearFingerprint } from './linear-config';
import { linearRecordSchema, putLinearRecord } from './linear-store';

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
    const rows = db
      .prepare(
        "SELECT record FROM factory_linear_records WHERE kind=? AND json_extract(record,'$.sourceFingerprint') IS NULL AND (kind!='delivery' OR json_extract(record,'$.state')!='complete')",
      )
      .all(kind);
    for (const row of rows) {
      const record = v.parse(
        linearRecordSchema,
        JSON.parse(String(row.record)),
      );
      if (record.kind !== 'delivery' && record.kind !== 'writeback') continue;
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
