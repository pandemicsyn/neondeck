import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { dbRun } from './service';
import * as v from 'valibot';
import { workSchema, sourceSchema } from '../../../shared/factory';
import { linearConnections, linearMappings } from './linear-config';
import { matchesLinearSourceBinding } from './linear-authority';
import { linearRecords, putLinearRecord } from './linear-store';

/** Retire only proven-unsent intents, independently of provider readiness. */
export function retireLinearPendingEffects(paths: RuntimePaths) {
  dbRun(paths, (db) => {
    const connections = linearConnections(paths);
    const enabled = readRuntimeJsonSync(paths.config, parseAppConfig).factory
      ?.enabled;
    const repos = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos;
    for (const effect of linearRecords(db, 'writeback', {
      state: 'pending',
      limit: 1000,
    })) {
      const c = connections.find(
        (candidate) => candidate.id === effect.connectionId,
      );
      const row = db
        .prepare(
          'SELECT w.record AS work,s.record AS source FROM factory_work_items w JOIN factory_sources s ON s.id=w.source_id WHERE w.id=?',
        )
        .get(effect.workId);
      const current = row
        ? {
            work: v.parse(workSchema, JSON.parse(String(row.work))),
            source: v.parse(sourceSchema, JSON.parse(String(row.source))),
          }
        : null;
      const remote = current?.source.linear;
      const target = current && c?.writeback.states[current.work.lifecycle];
      const valid =
        enabled &&
        c?.enabled &&
        c.writeback.enabled &&
        repos.some((repo) => repo.id === c.repoId) &&
        current &&
        remote &&
        !current.source.attention &&
        current.source.status !== 'closed' &&
        matchesLinearSourceBinding(effect, c) &&
        remote.connectionId === c.id &&
        remote.issueId === effect.issueId &&
        current.source.version === effect.sourceVersion &&
        target === effect.stateId &&
        (effect.workVersion === undefined
          ? effect.id ===
            `writeback:${effect.workId}:${current.work.version}:${target}`
          : effect.workVersion === current.work.version) &&
        linearMappings(
          connections,
          remote.organizationId,
          remote.teamId,
          remote.projectId,
        ).length === 1;
      if (!valid)
        putLinearRecord(db, {
          ...effect,
          state: 'superseded',
          retryAt: 0,
          error:
            'Unsent Linear update retired because its factory authority or configured target changed.',
          updatedAt: new Date().toISOString(),
        });
    }
  });
}
