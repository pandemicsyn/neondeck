import { factoryValidationPolicy } from '../validation-policy';
import { afterEach, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fixture } from './github-fixture';
import type {
  LinearConnection,
  LinearIssue,
} from '../../../../shared/factory-linear';
import { dbRun, saveFactorySpec, releaseFactoryWork } from '../service';
import { emptyFactorySpec } from '../../../../shared/factory';
import { updateFactoryConfig } from '../../config';
import { reserveCodingRun, getCodingRun } from '../../coding-runs';
import {
  codingAuthority,
  codingConfig,
  codingDigest,
  assertCodingAuthoritySnapshot,
} from '../coding-context';
import { reconcileLinearSource } from '../linear-source';
export const connection: LinearConnection = {
  id: 'linear',
  enabled: true,
  organizationId: 'org',
  teamId: 'team',
  projectId: null,
  repoId: 'fixture',
  tokenEnv: 'FACTORY_TEST_TOKEN',
  webhookSecretEnv: 'FACTORY_TEST_WEBHOOK',
  admission: { mode: 'all' },
  writeback: { enabled: false, states: { inbox: 'started' } },
};
export const issue: LinearIssue = {
  id: 'issue',
  identifier: 'PRO-1',
  url: 'https://linear.app/example/issue/PRO-1',
  title: 'Task',
  description: 'Body',
  updatedAt: '2026-09-07T00:00:00Z',
  archivedAt: null,
  team: { id: 'team' },
  project: null,
  state: { id: 'todo', type: 'unstarted' },
  labels: [],
};
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});
export function setup(enabled = false) {
  const f = fixture();
  fixtures.push(f);
  const c = { ...connection, writeback: { ...connection.writeback, enabled } };
  const config = (next = c) =>
    writeFileSync(
      f.paths.config,
      JSON.stringify({
        version: 1,
        factory: { enabled: true, linear: [next] },
        models: { default: 'faux/faux-1', prReview: 'faux/faux-1' },
        guardrails: { requiredChecks: ['npm test'] },
      }),
    );
  config();
  dbRun(f.paths, (db) =>
    reconcileLinearSource(db, c, issue, issue.id, f.paths),
  );
  return { ...f, c, config };
}
export function releasedFixture(enabled = false) {
  const { paths, c } = setup(enabled);
  updateFactoryConfig({ coding: { enabled: true, model: 'synthetic' } }, paths);
  const initial = dbRun(paths, (db) =>
    reconcileLinearSource(db, c, issue, issue.id, paths),
  )!;
  const human = { kind: 'human' as const, id: 'operator' };
  const saved = saveFactorySpec(
    initial.work.id,
    {
      expectedVersion: initial.work.version,
      expectedSpecVersion: initial.work.specVersion,
      expectedRepoFingerprint: initial.repoFingerprint,
      spec: {
        ...emptyFactorySpec(),
        outcome: 'Outcome',
        scope: 'Scope',
        approach: 'Approach',
        acceptanceCriteria: [{ id: 'ac1', text: 'Criterion' }],
      },
    },
    human,
    paths,
  );
  const revision = saved.revisions.at(-1)!;
  const released = releaseFactoryWork(
    saved.work.id,
    {
      requestKey: 'release',
      expectedVersion: saved.work.version,
      specVersion: revision.version,
      specHash: revision.hash,
      sourceVersion: saved.source.version,
      repoFingerprint: saved.repoFingerprint,
      policyVersion: 'isolated-local-v1',
      validationPolicy: factoryValidationPolicy('fixture', paths),
      expectedCodingConfigFingerprint: codingDigest(codingConfig(paths).coding),
    },
    human,
    paths,
  );
  const { current, release, repo, coding } = codingAuthority(
    released.work.id,
    paths,
  );
  const snapshot = {
    requestId: `factory:${release.id}`,
    workItemId: current.work.id,
    releaseId: release.id,
    specVersion: revision.version,
    specHash: revision.hash,
    specSnapshot: JSON.stringify(revision.spec),
    sourceId: current.source.id,
    sourceSnapshot: JSON.stringify(current.source),
    repoId: repo.id,
    repoSnapshot: JSON.stringify(repo),
    policySnapshot: JSON.stringify({ release: release.policy, coding }),
    contextSnapshot: '{}',
    baseSha: 'b'.repeat(40),
    harness: { provider: 'codex', version: 'synthetic', model: 'synthetic' },
    sessionMode: 'fresh' as const,
  };
  expect(() => assertCodingAuthoritySnapshot(snapshot, paths)).not.toThrow();
  const run = reserveCodingRun(snapshot, paths);
  expect(() =>
    assertCodingAuthoritySnapshot(run.snapshot, paths),
  ).not.toThrow();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
  return { paths, c, current, run };
}
