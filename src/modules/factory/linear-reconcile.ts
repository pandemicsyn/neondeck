import { processLinearRemovals } from './linear-removals';
import {
  linearSourceFingerprint,
  matchesLinearSourceBinding,
} from './linear-authority';
import {
  clearLinearReadFailure,
  linearReadFailure,
  recordLinearReadFailure,
} from './linear-read-health';
import {
  scheduledLinearConnections,
  scheduledLinearPhases,
} from './linear-scheduling';
import type { FactoryDetail } from '../../../shared/factory';
import { prepareFactoryTriage } from './planning-store';
import { resumeFactoryPlanning } from './planning-dispatch';
import { linearCoolingDown, retainLinearRateLimit } from './linear-cooldown';
import * as v from 'valibot';
import { sourceSchema } from '../../../shared/factory';
import { factoryLinearStateSchema } from '../../../shared/factory-linear';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { readLinearIssue, readLinearIssuesPage } from '../linear';
import { dbRun, FactoryError, getFactoryWork } from './service';
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
      sync: [
        ...linearRecords(db, 'sync'),
        ...linearRecords(db, 'read-failure', { limit: 100 }).map((row) => ({
          ...row,
          cursor: null,
        })),
      ],
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
    clearLinearReadFailure(db, current.source.id);
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
        sourceFingerprint: linearSourceFingerprint(c),
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
  const configured = linearConnections(paths).slice(0, 100);
  processLinearRemovals(configured, paths, signal);
  if (signal?.aborted) return;
  connections: for (const c of scheduledLinearConnections(configured, paths)) {
    if (signal?.aborted) return;
    const requestSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(10000),
    ]);
    if (signal?.aborted) return;
    if (linearReadiness(c, paths).length) continue;
    const fingerprint = linearFingerprint(c);
    const sourceFingerprint = linearSourceFingerprint(c);
    const assertConfig = () => {
      if (
        linearSourceFingerprint(readyLinearConnection(c.id, paths)) !==
        sourceFingerprint
      )
        throw new FactoryError(409, 'Linear configuration changed.');
    };
    for (const phase of scheduledLinearPhases(c.id, paths)) {
      if (requestSignal.aborted || linearCoolingDown(c.id, paths))
        continue connections;
      if (phase === 'delivery') {
        const pending = dbRun(paths, (db) =>
          linearRecords(db, 'delivery').filter(
            (r) =>
              r.connectionId === c.id &&
              r.action !== 'remove' &&
              r.state === 'pending' &&
              r.retryAt <= Date.now(),
          ),
        );
        const deliveries = pending.slice(0, 25);
        for (const delivery of deliveries) {
          if (requestSignal.aborted) continue connections;
          if (linearCoolingDown(c.id, paths)) continue;
          try {
            if (!matchesLinearSourceBinding(delivery, c)) {
              dbRun(paths, (db) =>
                putLinearRecord(db, {
                  ...delivery,
                  state: 'attention',
                  error: 'Connection changed; request a new sync.',
                }),
              );
              continue;
            }
            const issue = await io.readIssue(
              c,
              delivery.issueId,
              requestSignal,
            );
            requestSignal.throwIfAborted();
            assertConfig();
            const current = dbRun(paths, (db) => {
              const result = reconcileLinearSource(
                db,
                c,
                issue,
                delivery.issueId,
                paths,
              );
              putLinearRecord(db, {
                ...delivery,
                state: 'complete',
                error: null,
              });
              return result;
            });
            triage(current);
          } catch (error) {
            if (retainLinearRateLimit(error, c, paths)) continue;
            dbRun(paths, (db) =>
              putLinearRecord(db, {
                ...delivery,
                attempts: delivery.attempts + (requestSignal.aborted ? 0 : 1),
                retryAt:
                  Date.now() +
                  Math.min(
                    3600000,
                    30000 * 2 ** Math.min(delivery.attempts, 7),
                  ),
                error: 'Linear sync failed. Verify connection and retry.',
                state:
                  !requestSignal.aborted && delivery.attempts >= 7
                    ? 'attention'
                    : 'pending',
              }),
            );
          }
        }
        continue;
      }
      if (requestSignal.aborted || linearCoolingDown(c.id, paths))
        continue connections;
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
      if (phase === 'discovery') {
        if (record.retryAt <= Date.now())
          try {
            if (requestSignal.aborted || linearCoolingDown(c.id, paths))
              continue connections;
            const page = await io.readPage(
              c,
              record.cursor ?? null,
              requestSignal,
            );
            requestSignal.throwIfAborted();
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
                attempts: record.attempts + (requestSignal.aborted ? 0 : 1),
                retryAt: Date.now() + 60000,
                error: 'Linear discovery failed. Verify connection and retry.',
              }),
            );
          }
        continue;
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
      for (const [index, source] of batch.entries()) {
        if (requestSignal.aborted) continue connections;
        dbRun(paths, (db) => {
          const latest =
            linearRecords(db, 'sync', { id: record.id })[0] ?? record;
          putLinearRecord(db, {
            ...latest,
            offset:
              offset + index + 1 >= retained.length ? 0 : offset + index + 1,
          });
        });
        if (requestSignal.aborted || linearCoolingDown(c.id, paths))
          continue connections;
        const failed = linearReadFailure(source.id, paths);
        if (failed && failed.retryAt > Date.now()) continue;
        try {
          const issue = await io.readIssue(
            c,
            source.linear!.issueId,
            requestSignal,
          );
          requestSignal.throwIfAborted();
          assertConfig();
          const current = dbRun(paths, (db) =>
            reconcileLinearSource(db, c, issue, source.linear!.issueId, paths),
          );
          triage(current);
        } catch (error) {
          if (retainLinearRateLimit(error, c, paths)) continue connections;
          recordLinearReadFailure(
            c,
            source.id,
            source.linear!.issueId,
            requestSignal.aborted,
            paths,
          );
        }
      }
    }
  }
}
