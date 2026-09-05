import * as v from 'valibot';
import { sourceSchema } from '../../../shared/factory';
import type { GitHubConnection } from '../../../shared/factory-github';
import type { AppConfig, RuntimePaths } from '../../runtime-home';
import { dbRun, markGitHubAttention } from './service';
import { invalidateWriteback } from './writeback-store';

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
  if (JSON.stringify(before.factory) !== JSON.stringify(after.factory)) {
    dbRun(paths, (db) => {
      for (const c of before.factory?.github ?? [])
        invalidateWriteback(db, c.id);
    });
  }
}
