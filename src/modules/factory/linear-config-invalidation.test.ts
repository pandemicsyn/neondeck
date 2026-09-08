import { factoryValidationPolicy } from './validation-policy';
import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fixture } from './testing/github-fixture';
import type {
  LinearConnection,
  LinearIssue,
} from '../../../shared/factory-linear';
import { emptyFactorySpec } from '../../../shared/factory';
import {
  dbRun,
  getFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
} from './service';
import { updateFactoryConfig } from '../config';
import { reserveCodingRun, getCodingRun } from '../coding-runs';
import {
  codingAuthority,
  codingConfig,
  codingDigest,
  assertCodingAuthoritySnapshot,
} from './coding-context';
import { reconcileLinearSource } from './linear-source';
import type { FactoryDetail } from '../../../shared/factory';
const a: LinearConnection = {
  id: 'a',
  enabled: true,
  organizationId: 'org',
  teamId: 'team',
  projectId: 'project-a',
  repoId: 'fixture',
  tokenEnv: 'FACTORY_TEST_TOKEN',
  webhookSecretEnv: 'FACTORY_TEST_WEBHOOK',
  admission: { mode: 'all' },
  writeback: { enabled: false, states: {} },
};
const b: LinearConnection = { ...a, id: 'b', projectId: 'project-b' };
const issue: LinearIssue = {
  id: 'issue',
  identifier: 'PRO-1',
  url: 'https://linear.app/example/issue/PRO-1',
  title: 'Task',
  description: 'Body',
  updatedAt: '2026-09-07T00:00:00Z',
  archivedAt: null,
  team: { id: 'team' },
  project: { id: 'project-a' },
  state: { id: 'todo', type: 'unstarted' },
  labels: [],
};
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});
function setup(connection = a) {
  const f = fixture();
  fixtures.push(f);
  const { paths } = f;
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: {
        enabled: true,
        linear: [connection, b],
        coding: { enabled: true, model: 'synthetic' },
      },
      models: { default: 'faux/faux-1', prReview: 'faux/faux-1' },
      guardrails: { requiredChecks: ['npm test'] },
    }),
  );
  const initial = dbRun(paths, (db) =>
    reconcileLinearSource(db, connection, issue, issue.id, paths),
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
  releaseFactoryWork(
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
    saved.work.id,
    paths,
  );
  const run = reserveCodingRun(
    {
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
      sessionMode: 'fresh',
    },
    paths,
  );
  expect(() =>
    assertCodingAuthoritySnapshot(run.snapshot, paths),
  ).not.toThrow();
  return { paths, current, run };
}
it.each([
  [
    'disjoint edit',
    [a, { ...b, admission: { mode: 'state' as const, value: 'todo' } }],
  ],
  ['disjoint disable', [a, { ...b, enabled: false }]],
  [
    'disabled wildcard addition',
    [a, b, { ...b, id: 'disabled', projectId: null, enabled: false }],
  ],
  ['mapping reorder', [b, a]],
] as const)(
  'preserves project A source, release and reserved run after %s',
  (_name, connections) => {
    const { paths, current, run } = setup();
    updateFactoryConfig({ linear: [...connections] }, paths);
    const after = getFactoryWork(current.work.id, paths);
    expect(after.source).toEqual(current.source);
    expect(after.releases).toEqual(current.releases);
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
    expect(() =>
      assertCodingAuthoritySnapshot(run.snapshot, paths),
    ).not.toThrow();
  },
);

function saveCurrent(
  current: FactoryDetail,
  paths: ReturnType<typeof setup>['paths'],
) {
  return saveFactorySpec(
    current.work.id,
    {
      expectedVersion: current.work.version,
      expectedSpecVersion: current.work.specVersion,
      expectedRepoFingerprint: current.repoFingerprint,
      spec: current.revisions.at(-1)!.spec,
    },
    { kind: 'human', id: 'operator' },
    paths,
  );
}
function releaseCurrent(
  current: FactoryDetail,
  paths: ReturnType<typeof setup>['paths'],
) {
  const revision = current.revisions.at(-1)!;
  return releaseFactoryWork(
    current.work.id,
    {
      requestKey: `release-${current.work.version}`,
      expectedVersion: current.work.version,
      specVersion: revision.version,
      specHash: revision.hash,
      sourceVersion: current.source.version,
      repoFingerprint: current.repoFingerprint,
      policyVersion: 'isolated-local-v1',
      validationPolicy: factoryValidationPolicy('fixture', paths),
      expectedCodingConfigFingerprint: codingDigest(codingConfig(paths).coding),
    },
    { kind: 'human', id: 'operator' },
    paths,
  );
}

it('requires current source confirmation after admission changes even when a new draft is saved', () => {
  const { paths, current } = setup();
  const restricted: LinearConnection = {
    ...a,
    admission: { mode: 'label', value: 'admitted' },
  };
  updateFactoryConfig({ linear: [restricted, b] }, paths);
  delete process.env.FACTORY_TEST_TOKEN;
  const saved = saveCurrent(getFactoryWork(current.work.id, paths), paths);
  expect(saved.source.linear?.sourceConfirmationRequired).toBe(true);
  expect(() => releaseCurrent(saved, paths)).toThrow();
  process.env.FACTORY_TEST_TOKEN = 'synthetic-read-fixture-only';
  dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      restricted,
      { ...issue, updatedAt: '2026-09-06T00:00:00Z' },
      issue.id,
      paths,
    ),
  );
  expect(
    getFactoryWork(current.work.id, paths).source.linear
      ?.sourceConfirmationRequired,
  ).toBe(true);
  dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      restricted,
      { ...issue, updatedAt: '2026-09-07T01:00:00Z' },
      issue.id,
      paths,
    ),
  );
  const ineligible = saveCurrent(getFactoryWork(current.work.id, paths), paths);
  expect(ineligible.source.status).toBe('closed');
  expect(ineligible.source.linear?.sourceConfirmationRequired).toBe(true);
  expect(() => releaseCurrent(ineligible, paths)).toThrow();
  dbRun(paths, (db) =>
    reconcileLinearSource(
      db,
      restricted,
      {
        ...issue,
        labels: [{ id: 'admitted' }],
        updatedAt: '2026-09-07T02:00:00Z',
      },
      issue.id,
      paths,
    ),
  );
  const confirmed = saveCurrent(getFactoryWork(current.work.id, paths), paths);
  expect(confirmed.source.linear?.sourceConfirmationRequired).toBe(false);
  expect(confirmed.source.attention).toBeNull();
  expect(releaseCurrent(confirmed, paths).eligible).toBe(true);
});

it('does not allow saving a draft to erase a legacy Linear config confirmation blocker', () => {
  const { paths, current } = setup();
  dbRun(paths, (db) => {
    const source = {
      ...current.source,
      attention:
        'Linear connection changed. Review and save a new draft before release.',
    };
    db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
      JSON.stringify(source),
      source.id,
    );
  });
  const saved = saveCurrent(getFactoryWork(current.work.id, paths), paths);
  expect(saved.source.attention).toContain('Linear connection changed.');
  expect(() => releaseCurrent(saved, paths)).toThrow();
  dbRun(paths, (db) => reconcileLinearSource(db, a, issue, issue.id, paths));
  const confirmed = saveCurrent(getFactoryWork(current.work.id, paths), paths);
  expect(releaseCurrent(confirmed, paths).eligible).toBe(true);
});
it.each([
  ['wildcard addition', [a, b, { ...b, id: 'wildcard', projectId: null }]],
  ['disjoint mapping becomes wildcard', [a, { ...b, projectId: null }]],
  ['disjoint mapping becomes project A', [a, { ...b, projectId: 'project-a' }]],
  ['original connection edit', [{ ...a, tokenEnv: 'CHANGED_TOKEN' }, b]],
  ['original project edit', [{ ...a, projectId: 'project-c' }, b]],
  [
    'original admission edit',
    [{ ...a, admission: { mode: 'state' as const, value: 'todo' } }, b],
  ],
  ['original connection disable', [{ ...a, enabled: false }, b]],
  ['original connection removal', [b]],
] as const)(
  'revokes project A source authority and reserved run after %s',
  (_name, connections) => {
    const { paths, current, run } = setup();
    updateFactoryConfig({ linear: [...connections] }, paths);
    const after = getFactoryWork(current.work.id, paths);
    expect(after.source.attention).toContain('Linear connection changed');
    expect(after.releases[0].withdrawnAt).not.toBeNull();
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
  },
);

it.each([
  ['enable', a.writeback, { enabled: true, states: { queued: 'started' } }],
  ['disable', { enabled: true, states: { queued: 'started' } }, a.writeback],
  [
    'state mapping',
    { enabled: true, states: { queued: 'started' } },
    { enabled: true, states: { queued: 'in-progress' } },
  ],
] as const)(
  'preserves released source and reserved coding authority after writeback %s',
  (_name, before, after) => {
    const { paths, current, run } = setup({ ...a, writeback: before });
    updateFactoryConfig({ linear: [{ ...a, writeback: after }, b] }, paths);
    const updated = getFactoryWork(current.work.id, paths);
    expect(updated.source).toEqual(current.source);
    expect(updated.releases).toEqual(current.releases);
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
    expect(() =>
      assertCodingAuthoritySnapshot(run.snapshot, paths),
    ).not.toThrow();
  },
);
