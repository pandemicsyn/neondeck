import { linearCoolingDown, retainLinearRateLimit } from './linear-cooldown';
import { linearSourceFingerprint } from './linear-authority';
import { scheduledLinearConnections } from './linear-scheduling';
import * as v from 'valibot';
import { sourceSchema } from '../../../shared/factory';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { readLinearIssue, updateLinearIssueState } from '../linear';
import { dbRun, detail, FactoryError } from './service';
import {
  linearConnections,
  linearFingerprint,
  linearReadiness,
  readyLinearConnection,
} from './linear-config';
import {
  linearContentFingerprint,
  reconcileLinearSource,
} from './linear-source';
import {
  linearRecords,
  linearEffectSchema,
  linearSyncSchema,
  putLinearRecord,
} from './linear-store';
const defaultIO = {
  readIssue: readLinearIssue,
  updateState: updateLinearIssueState,
};
export async function runFactoryLinearWriteback(
  paths: RuntimePaths = runtimePaths(),
  signal?: AbortSignal,
  io = defaultIO,
) {
  if (signal?.aborted) return;
  connections: for (const c of scheduledLinearConnections(
    linearConnections(paths),
    paths,
    'writeback',
  )) {
    if (signal?.aborted) return;
    if (linearReadiness(c, paths, 'writeback').length) continue;
    if (linearCoolingDown(c.id, paths)) continue;
    const requestSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(10000),
    ]);
    const fingerprint = linearFingerprint(c);
    const cursor = dbRun(paths, (db) =>
      linearRecords(db, 'sync').find(
        (r) => r.id === `writeback-cursor:${c.id}`,
      ),
    );
    const items = dbRun(paths, (db) =>
      db
        .prepare(
          "SELECT w.id,s.record FROM factory_sources s JOIN factory_work_items w ON w.source_id=s.id WHERE json_extract(s.record,'$.linear.connectionId')=? ORDER BY w.id",
        )
        .all(c.id)
        .map((r) => ({
          id: String(r.id),
          source: v.parse(sourceSchema, JSON.parse(String(r.record))),
        })),
    );
    const offset = (cursor?.offset ?? 0) % Math.max(items.length, 1);
    const batch = items.slice(offset, offset + 25);
    for (const [index, item] of batch.entries()) {
      if (signal?.aborted) return;
      if (requestSignal.aborted || linearCoolingDown(c.id, paths))
        continue connections;
      dbRun(paths, (db) =>
        putLinearRecord(
          db,
          v.parse(linearSyncSchema, {
            id: `writeback-cursor:${c.id}`,
            kind: 'sync',
            connectionId: c.id,
            connectionFingerprint: fingerprint,
            offset: offset + index + 1 >= items.length ? 0 : offset + index + 1,
            state: 'pending',
            error: null,
            retryAt: 0,
            attempts: 0,
          }),
        ),
      );
      const current = dbRun(paths, (db) => detail(db, item.id, paths));
      const stateId = c.writeback.states[current.work.lifecycle];
      if (
        !stateId ||
        current.source.attention ||
        current.source.status === 'closed'
      )
        continue;
      const id = `writeback:${item.id}:${current.work.version}:${stateId}`;
      let effect = dbRun(paths, (db) =>
        linearRecords(db, 'writeback', { id }).find((r) => r.id === id),
      );
      if (
        effect?.state === 'complete' ||
        effect?.state === 'attention' ||
        (effect?.retryAt ?? 0) > Date.now()
      )
        continue;
      try {
        const issue = await io.readIssue(
          c,
          item.source.linear!.issueId,
          requestSignal,
        );
        requestSignal.throwIfAborted();
        if (!issue) continue;
        if (
          linearSourceFingerprint(
            readyLinearConnection(c.id, paths, 'provider'),
          ) !== linearSourceFingerprint(c)
        )
          continue;
        const latestSource = dbRun(paths, (db) =>
          detail(db, item.id, paths),
        ).source;
        if (
          Date.parse(issue.updatedAt) <
          Date.parse(latestSource.linear!.updatedAt)
        )
          continue;
        if (effect) {
          dbRun(paths, (db) =>
            reconcileLinearSource(db, c, issue, issue.id, paths),
          );
          continue;
        }
        dbRun(paths, (db) =>
          reconcileLinearSource(db, c, issue, issue.id, paths),
        );
        const fresh = dbRun(paths, (db) => detail(db, item.id, paths));
        if (
          fresh.work.version !== current.work.version ||
          fresh.source.version !== current.source.version ||
          fresh.source.attention
        )
          continue;
        if (
          linearFingerprint(readyLinearConnection(c.id, paths, 'writeback')) !==
          fingerprint
        )
          continue;
        effect = v.parse(linearEffectSchema, {
          id,
          kind: 'writeback',
          connectionId: c.id,
          connectionFingerprint: fingerprint,
          sourceFingerprint: linearSourceFingerprint(c),
          issueId: issue.id,
          workId: item.id,
          stateId,
          sourceVersion: current.source.version,
          baseline: linearContentFingerprint(issue),
          createdAt: new Date().toISOString(),
          state: 'sending',
          error: null,
          retryAt: 0,
          attempts: 1,
        });
        const reserved = dbRun(paths, (db) => {
          if (
            linearRecords(db, 'writeback', { id }).some((row) => row.id === id)
          )
            return false;
          const unresolved = db
            .prepare(
              "SELECT count(*) AS count FROM factory_linear_records WHERE kind='writeback' AND json_extract(record,'$.state') IN ('sending','uncertain','attention')",
            )
            .get();
          if (Number(unresolved?.count) >= 1000) {
            putLinearRecord(
              db,
              v.parse(linearSyncSchema, {
                id: `writeback-cursor:${c.id}`,
                kind: 'sync',
                connectionId: c.id,
                connectionFingerprint: fingerprint,
                offset:
                  offset + index + 1 >= items.length ? 0 : offset + index + 1,
                state: 'attention',
                error:
                  'Linear writeback is paused at the 1000 unresolved-effect limit. Sync affected sources and review uncertain updates.',
                retryAt: 0,
                attempts: 0,
              }),
            );
            return false;
          }
          putLinearRecord(db, effect!);
          return true;
        });
        if (!reserved) continue;
        const result = await io.updateState(
          c,
          issue.id,
          stateId,
          requestSignal,
          () => {
            requestSignal.throwIfAborted();
            if (linearCoolingDown(c.id, paths))
              throw new FactoryError(
                409,
                'Linear provider cooldown is active.',
              );
            if (
              linearFingerprint(
                readyLinearConnection(c.id, paths, 'writeback'),
              ) !== fingerprint
            )
              throw new FactoryError(409, 'Linear configuration changed.');
            dbRun(paths, (db) => {
              const latest = detail(db, item.id, paths);
              if (
                latest.work.version !== current.work.version ||
                latest.source.version !== current.source.version ||
                latest.source.attention
              )
                throw new FactoryError(409, 'Factory authority changed.');
            });
          },
        );
        dbRun(paths, (db) =>
          putLinearRecord(db, {
            ...effect!,
            state: 'complete',
            updatedAt: result.updatedAt,
            error: null,
          }),
        );
      } catch (error) {
        if (effect)
          dbRun(paths, (db) =>
            putLinearRecord(db, {
              ...effect!,
              state: 'uncertain',
              retryAt: Date.now() + 30000,
              error:
                'Linear state update outcome is uncertain; checking current source before retry.',
            }),
          );
        if (retainLinearRateLimit(error, c, paths)) continue connections;
      }
    }
  }
}
