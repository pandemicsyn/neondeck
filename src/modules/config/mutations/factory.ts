import { invalidateWriteback } from '../../factory';
import { dbRun, markGitHubAttention } from '../../factory';
import { sourceSchema } from '../../../../shared/factory';
import type { GitHubConnection } from '../../../../shared/factory-github';
import * as v from 'valibot';
import { factoryConfigSchema } from '../../../../shared/factory';
import {
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
} from '../../../runtime-home';
import { writeJsonAtomicSync } from '../../../runtime-home/files';
import { recordConfigChange } from '../history';

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

export function updateFactoryConfig(input: unknown, paths = runtimePaths()) {
  const before = readRuntimeJsonSync(paths.config, parseAppConfig);
  const factory = v.parse(factoryConfigSchema, {
    ...before.factory,
    ...v.parse(v.record(v.string(), v.unknown()), input),
  });
  const after = parseAppConfig({ ...before, factory }, paths.config);
  // Synchronous read/replace avoids yielding between sibling local config writes.
  // Revoke affected authority before replacing the file. If the file write fails,
  // conservative revocation remains visible; no cross-store atomicity is assumed.
  if (
    JSON.stringify(before.factory?.github ?? []) !==
    JSON.stringify(factory.github)
  ) {
    dbRun(paths, (db) => {
      for (const row of db
        .prepare(
          "SELECT s.record,w.id FROM factory_sources s JOIN factory_work_items w ON w.source_id=s.id WHERE json_extract(s.record,'$.provider')='github'",
        )
        .all()) {
        const source = v.parse(sourceSchema, JSON.parse(String(row.record)));
        const old = before.factory?.github?.find(
          (c) => c.id === source.remote?.connectionId,
        );
        const next = factory.github.find(
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
              effectiveMappings(factory.github, source.remote?.repositoryId),
            )
        )
          markGitHubAttention(
            db,
            String(row.id),
            'GitHub connection changed. Review and save a new draft before release.',
            paths,
          );
      }
    });
  }
  if (JSON.stringify(before.factory) !== JSON.stringify(factory)) {
    dbRun(paths, (db) => {
      for (const c of before.factory?.github ?? [])
        invalidateWriteback(db, c.id);
    });
  }
  writeJsonAtomicSync(paths.config, after);
  recordConfigChange(paths, {
    action: 'config_update_factory',
    file: paths.config,
    target: 'factory',
    before,
    after,
  });
  return factory;
}
