import { cancelActiveFactoryCoding } from './coding-invalidation';
import * as v from 'valibot';
import { sourceSchema } from '../../../shared/factory';
import type { GitHubConnection } from '../../../shared/factory-github';
import type { AppConfig, RuntimePaths } from '../../runtime-home';
import { dbRun, markGitHubAttention, markSourceAttention } from './service';
import { invalidateWriteback } from './writeback-store';
import {
  bindLegacyLinearSourceRecords,
  linearSourceProjection,
} from './linear-authority';

const effectiveMappings = (
  connections: GitHubConnection[],
  repositoryId: string | undefined,
) =>
  connections
    .filter(
      (connection) =>
        connection.enabled && connection.repositoryId === repositoryId,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

/** Synchronously revoke factory authority before config file replacement.
 * A failed replacement must leave the conservative revocation intact. */
export function invalidateFactoryConfig(
  before: AppConfig,
  after: AppConfig,
  paths: RuntimePaths,
) {
  // Defaults govern future admission. Only explicit disable switches stop
  // admitted execution; persisted cancellation is never undone by re-enabling.
  if (
    (before.factory?.enabled === true && after.factory?.enabled !== true) ||
    (before.factory?.coding?.enabled === true &&
      after.factory?.coding?.enabled !== true)
  )
    cancelActiveFactoryCoding(paths);
  if (
    JSON.stringify(before.factory?.github ?? []) !==
    JSON.stringify(after.factory?.github ?? [])
  ) {
    dbRun(paths, (db) => {
      for (const row of db
        .prepare(
          "SELECT s.record,w.id FROM factory_sources s JOIN factory_work_items w ON w.source_id=s.id WHERE json_extract(s.record,'$.provider')='github'",
        )
        .all()) {
        const source = v.parse(
          sourceSchema,
          JSON.parse(v.parse(v.string(), row.record)),
        );
        const old = before.factory?.github?.find(
          (c) => c.id === source.remote?.connectionId,
        );
        const next = (after.factory?.github ?? []).find(
          (c) => c.id === source.remote?.connectionId,
        );
        if (
          JSON.stringify(old) !== JSON.stringify(next) ||
          JSON.stringify(
            effectiveMappings(
              before.factory?.github ?? [],
              source.remote?.repositoryId,
            ),
          ) !==
            JSON.stringify(
              effectiveMappings(
                after.factory?.github ?? [],
                source.remote?.repositoryId,
              ),
            )
        )
          markGitHubAttention(
            db,
            v.parse(v.string(), row.id),
            'GitHub connection changed. Review and save a new draft before release.',
            paths,
          );
      }
    });
  }
  if (
    JSON.stringify(before.factory?.linear ?? []) !==
    JSON.stringify(after.factory?.linear ?? [])
  ) {
    dbRun(paths, (db) => {
      // Legacy records can inherit only the binding authenticated by the old
      // configuration, never the replacement being installed.
      bindLegacyLinearSourceRecords(db, before.factory?.linear ?? []);
      for (const row of db
        .prepare(
          "SELECT w.id,s.record FROM factory_sources s JOIN factory_work_items w ON w.source_id=s.id WHERE json_extract(s.record,'$.provider')='linear'",
        )
        .all()) {
        const source = v.parse(sourceSchema, JSON.parse(String(row.record)));
        const relevant = (config: AppConfig) =>
          (config.factory?.linear ?? [])
            .filter(
              (c) =>
                c.id === source.linear?.connectionId ||
                (c.enabled &&
                  c.organizationId === source.linear?.organizationId &&
                  c.teamId === source.linear?.teamId &&
                  (c.projectId === null ||
                    c.projectId === source.linear?.projectId)),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(linearSourceProjection);
        if (
          JSON.stringify(relevant(before)) === JSON.stringify(relevant(after))
        )
          continue;
        markSourceAttention(
          db,
          v.parse(v.string(), row.id),
          'Linear connection changed. Sync the source to confirm current admission before release.',
          paths,
        );
        const updatedRow = db
          .prepare('SELECT record FROM factory_sources WHERE id=?')
          .get(source.id)!;
        const updated = v.parse(
          sourceSchema,
          JSON.parse(String(updatedRow.record)),
        );
        updated.linear!.sourceConfirmationRequired = true;
        db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
          JSON.stringify(updated),
          updated.id,
        );
      }
    });
  }
  if (JSON.stringify(before.factory) !== JSON.stringify(after.factory)) {
    dbRun(paths, (db) => {
      for (const c of before.factory?.github ?? [])
        invalidateWriteback(db, c.id);
    });
  }
}
