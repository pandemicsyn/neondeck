import type { FactoryDetail } from '../../../shared/factory';
import { prepareFactoryTriage } from './planning-store';
import { resumeFactoryPlanning } from './planning-dispatch';
import { linearCoolingDown, retainLinearRateLimit } from './linear-cooldown';
import * as v from 'valibot';
import { sourceSchema } from '../../../shared/factory';
import { factoryLinearStateSchema } from '../../../shared/factory-linear';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { readLinearIssue, readLinearIssuesPage } from '../linear';
import {
  dbRun,
  FactoryError,
  getFactoryWork,
  markSourceAttention,
} from './service';
import {
  linearConnections,
  linearFingerprint,
  linearReadiness,
  readyLinearConnection,
} from './linear-config';
import {
  linearRecords,
  putLinearRecord,
  linearRecordSchema,
  linearSyncSchema,
} from './linear-store';
import { reconcileLinearSource } from './linear-source';
export function factoryLinearState(paths = runtimePaths()) {
  return dbRun(paths, (db) =>
    v.parse(factoryLinearStateSchema, {
      configFingerprint: linearFingerprint(linearConnections(paths)),
      connections: linearConnections(paths).map((c) => ({
        ...c,
        readiness: linearReadiness(c, paths),
      })),
      sync: linearRecords(db, 'sync'),
      deliveries: linearRecords(db, 'delivery', { limit: 100 }),
      writebacks: linearRecords(db, 'writeback', { limit: 100 }),
    }),
  );
}
export function requestFactoryLinearSync(
  workId: string,
  paths = runtimePaths(),
) {
  const current = getFactoryWork(workId, paths);
  if (!current.source.linear)
    throw new FactoryError(409, 'Task is not a Linear source.');
  const c = readyLinearConnection(current.source.linear.connectionId, paths);
  return dbRun(paths, (db) => {
    for (const effect of linearRecords(db, 'writeback', { workId }).filter(
      (e) => e.workId === workId && e.state === 'attention',
    ))
      putLinearRecord(db, { ...effect, state: 'uncertain', retryAt: 0 });
    putLinearRecord(
      db,
      v.parse(linearRecordSchema, {
        id: `retry:${workId}`,
        kind: 'delivery',
        connectionId: c.id,
        connectionFingerprint: linearFingerprint(c),
        issueId: current.source.linear!.issueId,
        state: 'pending',
        error: null,
        retryAt: 0,
        attempts: 0,
      }),
    );
    return { accepted: true };
  });
}
export const linearIO = {
  planning: resumeFactoryPlanning,
  readIssue: readLinearIssue,
  readPage: readLinearIssuesPage,
};
export async function runFactoryLinearSync(
  paths: RuntimePaths = runtimePaths(),
  signal?: AbortSignal,
  io: Pick<typeof linearIO, 'readIssue' | 'readPage'> &
    Partial<Pick<typeof linearIO, 'planning'>> = linearIO,
) {
  const triage = (current: FactoryDetail | null) => {
    if (
      !current ||
      current.source.status !== 'open' ||
      current.source.attention
    )
      return;
    const intent = prepareFactoryTriage(current.work.id, paths);
    if (intent && intent.stage === 'triage' && io.planning)
      void io.planning(intent.id, paths).catch(() => undefined);
  };
  connections: for (const c of linearConnections(paths).slice(0, 100)) {
    if (signal?.aborted) return;
    if (linearReadiness(c, paths).length) continue;
    const fingerprint = linearFingerprint(c);
    const assertConfig = () => {
      if (linearFingerprint(readyLinearConnection(c.id, paths)) !== fingerprint)
        throw new FactoryError(409, 'Linear configuration changed.');
    };
    const pending = dbRun(paths, (db) =>
      linearRecords(db, 'delivery').filter(
        (r) =>
          r.connectionId === c.id &&
          r.state === 'pending' &&
          r.retryAt <= Date.now(),
      ),
    );
    // Authenticated removal is local authority revocation, never provider I/O.
    const deliveries = [
      ...pending.filter((row) => row.action === 'remove').slice(0, 25),
      ...pending.filter((row) => row.action !== 'remove').slice(0, 25),
    ];
    for (const delivery of deliveries) {
      if (delivery.action !== 'remove' && linearCoolingDown(c.id, paths))
        continue;
      try {
        if (delivery.connectionFingerprint !== fingerprint) {
          dbRun(paths, (db) =>
            putLinearRecord(db, {
              ...delivery,
              state: 'attention',
              error: 'Connection changed; request a new sync.',
            }),
          );
          continue;
        }
        const issue =
          delivery.action === 'remove'
            ? null
            : await io.readIssue(c, delivery.issueId, signal);
        assertConfig();
        const current = dbRun(paths, (db) => {
          const result = reconcileLinearSource(
            db,
            c,
            issue,
            delivery.issueId,
            paths,
            delivery.action === 'remove' ? delivery.createdAt : undefined,
          );
          putLinearRecord(db, { ...delivery, state: 'complete', error: null });
          return result;
        });
        if (delivery.action !== 'remove') triage(current);
      } catch (error) {
        if (retainLinearRateLimit(error, c, paths)) continue;
        dbRun(paths, (db) =>
          putLinearRecord(db, {
            ...delivery,
            attempts: delivery.attempts + 1,
            retryAt:
              Date.now() +
              Math.min(3600000, 30000 * 2 ** Math.min(delivery.attempts, 7)),
            error: 'Linear sync failed. Verify connection and retry.',
            state: delivery.attempts >= 7 ? 'attention' : 'pending',
          }),
        );
      }
    }
    if (linearCoolingDown(c.id, paths)) continue connections;
    let sync = dbRun(paths, (db) =>
      linearRecords(db, 'sync').find((r) => r.id === `sync:${c.id}`),
    );
    if (!sync || sync.connectionFingerprint !== fingerprint)
      sync = v.parse(linearSyncSchema, {
        id: `sync:${c.id}`,
        kind: 'sync',
        connectionId: c.id,
        connectionFingerprint: fingerprint,
        state: 'pending',
        error: null,
        retryAt: 0,
        attempts: 0,
      });
    if (sync.kind !== 'sync') continue;
    const record = sync;
    if (record.retryAt <= Date.now())
      try {
        if (linearCoolingDown(c.id, paths)) continue connections;
        const page = await io.readPage(c, record.cursor ?? null, signal);
        assertConfig();
        const reconciled = dbRun(paths, (db) => {
          const currents = page.items.map((issue) =>
            reconcileLinearSource(db, c, issue, issue.id, paths),
          );
          putLinearRecord(db, {
            ...record,
            cursor: page.cursor,
            retryAt: page.cursor ? 0 : Date.now() + 60000,
            error: null,
            attempts: 0,
          });
          return currents;
        });
        for (const current of reconciled) triage(current);
      } catch (error) {
        if (retainLinearRateLimit(error, c, paths)) continue connections;
        dbRun(paths, (db) =>
          putLinearRecord(db, {
            ...record,
            attempts: record.attempts + 1,
            retryAt: Date.now() + 60000,
            error: 'Linear discovery failed. Verify connection and retry.',
          }),
        );
      }
    // Re-read retained sources independently of admission-filtered discovery.
    const retained = dbRun(paths, (db) =>
      db
        .prepare(
          "SELECT record FROM factory_sources WHERE json_extract(record,'$.linear.connectionId')=? ORDER BY id",
        )
        .all(c.id)
        .map((r) => v.parse(sourceSchema, JSON.parse(String(r.record)))),
    );
    // Cursor is persisted separately so a large retained set cannot starve later issues.
    const offset = record.offset;
    const batch = retained.slice(offset, offset + 25);
    for (const source of batch) {
      if (linearCoolingDown(c.id, paths)) continue connections;
      try {
        const issue = await io.readIssue(c, source.linear!.issueId, signal);
        assertConfig();
        const current = dbRun(paths, (db) =>
          reconcileLinearSource(db, c, issue, source.linear!.issueId, paths),
        );
        triage(current);
      } catch (error) {
        if (retainLinearRateLimit(error, c, paths)) continue connections;
        dbRun(paths, (db) => {
          const work = db
            .prepare('SELECT id FROM factory_work_items WHERE source_id=?')
            .get(source.id);
          if (work)
            markSourceAttention(
              db,
              String(work.id),
              'Linear source could not be refreshed. Sync again after restoring provider access.',
              paths,
            );
        });
      }
    }
    dbRun(paths, (db) => {
      const latest =
        linearRecords(db, 'sync').find((r) => r.id === record.id) ?? record;
      putLinearRecord(db, {
        ...latest,
        offset: offset + 25 >= retained.length ? 0 : offset + 25,
      });
    });
  }
}
