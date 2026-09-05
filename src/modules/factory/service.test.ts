import { applyAppDbMigrations } from '../../runtime-home/app-db/migrate';
import {
  cpSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyFactorySpec,
  factoryConfigSchema,
  type FactoryDetail,
} from '../../../shared/factory';
import * as v from 'valibot';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { openDb } from '../../lib/sqlite';
import {
  factoryState,
  getFactoryWork,
  submitFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  transitionFactoryWork,
  updateFactorySource,
} from './service';
const actor = { kind: 'human' as const, id: 'local-operator' };
const intake = {
  requestKey: 'manual-1',
  title: 'Improve task search',
  body: 'Find saved tasks by title.',
  repoId: 'demo',
};
const spec = {
  ...emptyFactorySpec(),
  outcome: 'Find saved tasks',
  scope: 'Local task titles',
  approach: 'Add a search field.',
  acceptanceCriteria: [
    { id: 'ac-1', text: 'A title query returns matching tasks.' },
  ],
};
let paths: RuntimePaths;
const releaseInput = (d: FactoryDetail, key = 'release-1') => ({
  requestKey: key,
  expectedVersion: d.work.version,
  specVersion: d.work.specVersion,
  specHash: d.revisions.at(-1)!.hash,
  sourceVersion: d.source.version,
  repoFingerprint: d.repoFingerprint,
  policyVersion: 'isolated-local-v1',
});
function createReady() {
  const d = submitFactoryWork(intake, actor, paths);
  return saveFactorySpec(
    d.work.id,
    {
      expectedVersion: d.work.version,
      expectedSpecVersion: 1,
      expectedRepoFingerprint: d.repoFingerprint,
      spec,
    },
    actor,
    paths,
  );
}
function configure(enabled = true) {
  writeFileSync(
    paths.config,
    JSON.stringify({ version: 1, factory: { enabled } }),
  );
}
function registry(path = '/private/tmp/synthetic-repo') {
  writeFileSync(
    paths.repos,
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'demo',
          github: { owner: 'example', name: 'demo' },
          path,
          defaultBranch: 'main',
        },
      ],
    }),
  );
}
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'factory-test-')));
  mkdirSync(paths.data);
  configure();
  registry();
  initializeAppDatabase(paths.neondeckDatabase);
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));
describe('manual factory domain', () => {
  it('is disabled by default and rejects unknown policy/permissions', () => {
    writeFileSync(paths.config, JSON.stringify({ version: 1 }));
    expect(factoryState(paths).enabled).toBe(false);
    expect(() => submitFactoryWork(intake, actor, paths)).toThrow('disabled');
    expect(
      v.safeParse(factoryConfigSchema, {
        enabled: true,
        codingPolicy: 'publish-all',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(factoryConfigSchema, { enabled: true, publish: true })
        .success,
    ).toBe(false);
    expect(factoryState(paths).items).toHaveLength(0);
  });
  it('deduplicates exact retry, rejects request-key reuse and survives reinitialization', () => {
    const initial = submitFactoryWork(intake, actor, paths);
    expect(submitFactoryWork(intake, actor, paths).work.id).toBe(
      initial.work.id,
    );
    expect(() =>
      submitFactoryWork({ ...intake, title: 'Different' }, actor, paths),
    ).toThrow('different intake');
    const edited = saveFactorySpec(
      initial.work.id,
      {
        expectedVersion: 1,
        expectedSpecVersion: 1,
        expectedRepoFingerprint: initial.repoFingerprint,
        spec,
      },
      actor,
      paths,
    );
    initializeAppDatabase(paths.neondeckDatabase);
    expect(getFactoryWork(initial.work.id, paths)).toEqual(edited);
    expect(edited.revisions[0]).toEqual(initial.revisions[0]);
    expect(edited.revisions[1].parentVersion).toBe(1);
    expect(factoryState(paths).items).toHaveLength(1);
    const db = openDb(paths.neondeckDatabase);
    try {
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM factory_sources').get(),
      ).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM worktrees').get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });
  it('requires registered repo, complete spec, resolved blocking decisions and a human', () => {
    expect(() =>
      submitFactoryWork({ ...intake, repoId: 'missing' }, actor, paths),
    ).toThrow('registered');
    const unresolved = submitFactoryWork(
      { ...intake, repoId: null },
      actor,
      paths,
    );
    expect(unresolved.blockers.join(' ')).toContain('registered');
    expect(() =>
      releaseFactoryWork(
        unresolved.work.id,
        { ...releaseInput(unresolved), repoFingerprint: 'a'.repeat(64) },
        actor,
        paths,
      ),
    ).toThrow();
    const ready = createReadyWithKey('other');
    const blocked = saveFactorySpec(
      ready.work.id,
      {
        expectedVersion: ready.work.version,
        expectedSpecVersion: ready.work.specVersion,
        expectedRepoFingerprint: ready.repoFingerprint,
        spec: {
          ...spec,
          decisions: [
            {
              id: 'decision-1',
              question: 'Which title?',
              blocking: true,
              answer: null,
            },
          ],
        },
      },
      actor,
      paths,
    );
    expect(() =>
      releaseFactoryWork(blocked.work.id, releaseInput(blocked), actor, paths),
    ).toThrow('blocking decisions');
    expect(() =>
      releaseFactoryWork(
        ready.work.id,
        releaseInput(ready),
        { kind: 'model', id: 'planner' } as unknown as typeof actor,
        paths,
      ),
    ).toThrow('human');
  });
  it('captures exact policy, deduplicates release and revokes on new revision without erasing history', () => {
    const ready = createReady();
    const input = releaseInput(ready);
    const released = releaseFactoryWork(ready.work.id, input, actor, paths);
    expect(released.eligible).toBe(true);
    expect(released.work.lifecycle).toBe('queued');
    expect(released.releases[0].policy).toEqual({
      version: 'isolated-local-v1',
      implementation: 'isolated-worktree',
      checks: 'repo-configured',
      publish: false,
      merge: false,
      deploy: false,
    });
    expect(releaseFactoryWork(ready.work.id, input, actor, paths)).toEqual(
      released,
    );
    const revised = saveFactorySpec(
      ready.work.id,
      {
        expectedVersion: released.work.version,
        expectedSpecVersion: released.work.specVersion,
        expectedRepoFingerprint: released.repoFingerprint,
        spec: { ...spec, scope: 'Narrower scope' },
      },
      actor,
      paths,
    );
    expect(revised.eligible).toBe(false);
    expect(revised.releases[0].withdrawalReason).toBe('new-spec-revision');
    expect(releaseFactoryWork(ready.work.id, input, actor, paths)).toEqual(
      revised,
    );
    expect(() =>
      releaseFactoryWork(
        ready.work.id,
        { ...input, requestKey: 'stale' },
        actor,
        paths,
      ),
    ).toThrow('changed');
  });
  it('rejects stale editors and fences pause/close/withdraw/reopen transitions', () => {
    const ready = createReady();
    const paused = transitionFactoryWork(
      ready.work.id,
      { expectedVersion: ready.work.version, action: 'pause' },
      actor,
      paths,
    );
    expect(() =>
      releaseFactoryWork(ready.work.id, releaseInput(ready), actor, paths),
    ).toThrow('changed');
    expect(() =>
      saveFactorySpec(
        ready.work.id,
        {
          expectedVersion: ready.work.version,
          expectedSpecVersion: ready.work.specVersion,
          expectedRepoFingerprint: ready.repoFingerprint,
          spec,
        },
        actor,
        paths,
      ),
    ).toThrow('changed');
    expect(() =>
      transitionFactoryWork(
        ready.work.id,
        { expectedVersion: paused.work.version, action: 'withdraw' },
        actor,
        paths,
      ),
    ).toThrow('queued');
    const closed = transitionFactoryWork(
      ready.work.id,
      { expectedVersion: paused.work.version, action: 'close' },
      actor,
      paths,
    );
    const reopened = transitionFactoryWork(
      ready.work.id,
      { expectedVersion: closed.work.version, action: 'reopen' },
      actor,
      paths,
    );
    expect(reopened.work.lifecycle).toBe('shaping');
    expect(reopened.eligible).toBe(false);
    expect(reopened.blockers.join(' ')).toContain('context changed');
  });
  it('invalidates release for source/repo context changes and missing registries', () => {
    const ready = createReady();
    const released = releaseFactoryWork(
      ready.work.id,
      releaseInput(ready),
      actor,
      paths,
    );
    expect(
      updateFactorySource(
        ready.work.id,
        {
          expectedVersion: released.work.version,
          title: intake.title,
          body: intake.body,
          repoId: intake.repoId,
        },
        actor,
        paths,
      ),
    ).toEqual(released);
    registry('/private/tmp/synthetic-repo-moved');
    const stale = getFactoryWork(ready.work.id, paths);
    expect(stale.eligible).toBe(false);
    expect(stale.blockers.join(' ')).toContain('context changed');
    const changed = updateFactorySource(
      ready.work.id,
      {
        expectedVersion: released.work.version,
        title: intake.title,
        body: 'Changed source',
        repoId: null,
      },
      actor,
      paths,
    );
    expect(changed.source.repoId).toBe(changed.work.repoId);
    expect(changed.source.version).toBe(2);
    expect(changed.releases[0].withdrawalReason).toBe('source-or-repo-changed');
    configure(false);
    expect(
      transitionFactoryWork(
        ready.work.id,
        { expectedVersion: changed.work.version, action: 'pause' },
        actor,
        paths,
      ).work.lifecycle,
    ).toBe('paused');
  });
  it('rejects duplicate criterion IDs and invalid persisted content', () => {
    const ready = createReady();
    expect(() =>
      saveFactorySpec(
        ready.work.id,
        {
          expectedVersion: ready.work.version,
          expectedSpecVersion: ready.work.specVersion,
          expectedRepoFingerprint: ready.repoFingerprint,
          spec: {
            ...spec,
            acceptanceCriteria: [
              spec.acceptanceCriteria[0],
              spec.acceptanceCriteria[0],
            ],
          },
        },
        actor,
        paths,
      ),
    ).toThrow('unique');
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
        '{"id":"bad"}',
        ready.work.id,
      );
    } finally {
      db.close();
    }
    expect(() => getFactoryWork(ready.work.id, paths)).toThrow();
  });
});
function createReadyWithKey(requestKey: string) {
  const d = submitFactoryWork({ ...intake, requestKey }, actor, paths);
  return saveFactorySpec(
    d.work.id,
    {
      expectedVersion: d.work.version,
      expectedSpecVersion: 1,
      expectedRepoFingerprint: d.repoFingerprint,
      spec,
    },
    actor,
    paths,
  );
}

async function child(operation: string, id: string, input: unknown) {
  const source = `import {${operation}} from ${JSON.stringify(resolve('src/modules/factory/service.ts'))}; import {runtimePaths} from ${JSON.stringify(resolve('src/runtime-home/paths.ts'))};try {const result=${operation}(${JSON.stringify(id)},${JSON.stringify(input)},${JSON.stringify(actor)},runtimePaths(${JSON.stringify(paths.home)}));console.log(JSON.stringify({ok:true,result}));}catch(e){console.log(JSON.stringify({ok:false,status:e.status,message:e.message}));}`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--import=tsx', '--input-type=module', '-e', source],
    { cwd: process.cwd() },
  );
  return JSON.parse(result.stdout);
}
describe('independent process concurrency and restart', () => {
  it('serializes competing editors across connections with one winning immutable revision', async () => {
    const ready = createReady();
    const input = {
      expectedVersion: ready.work.version,
      expectedSpecVersion: ready.work.specVersion,
      expectedRepoFingerprint: ready.repoFingerprint,
      spec,
    };
    const results = await Promise.all([
      child('saveFactorySpec', ready.work.id, input),
      child('saveFactorySpec', ready.work.id, {
        ...input,
        spec: { ...spec, scope: 'Competing scope' },
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok).status).toBe(409);
    expect(getFactoryWork(ready.work.id, paths).revisions).toHaveLength(3);
  });
  it('serializes release versus pause without leaving paused work eligible', async () => {
    const ready = createReady();
    const results = await Promise.all([
      child('releaseFactoryWork', ready.work.id, releaseInput(ready)),
      child('transitionFactoryWork', ready.work.id, {
        expectedVersion: ready.work.version,
        action: 'pause',
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok).status).toBe(409);
    const current = getFactoryWork(ready.work.id, paths);
    expect(current.eligible).toBe(current.work.lifecycle === 'queued');
  });
  it('retains the queue after an independent process exits', async () => {
    const ready = createReady();
    const first = await child(
      'releaseFactoryWork',
      ready.work.id,
      releaseInput(ready),
    );
    expect(first.ok).toBe(true);
    initializeAppDatabase(paths.neondeckDatabase);
    expect(getFactoryWork(ready.work.id, paths).eligible).toBe(true);
    const retry = await child(
      'releaseFactoryWork',
      ready.work.id,
      releaseInput(ready),
    );
    expect(retry.result.releases).toHaveLength(1);
  });
});

it('upgrades an existing pre-factory database without altering retained runtime state', () => {
  const folder = join(paths.home, 'parent-migrations');
  mkdirSync(folder);
  const migrations = resolve('src/runtime-home/app-db/migrations');
  for (const name of readdirSync(migrations).filter(
    (n) => !n.endsWith('_factory_manual_intake'),
  ))
    cpSync(join(migrations, name), join(folder, name), { recursive: true });
  const previous = join(paths.data, 'existing.db');
  applyAppDbMigrations(previous, { migrationsFolder: folder });
  const db = openDb(previous);
  try {
    db.prepare(
      'INSERT INTO app_metadata (key,value,updated_at) VALUES (?,?,?)',
    ).run('synthetic-preserved', 'retained', '2026-09-05');
  } finally {
    db.close();
  }
  const result = applyAppDbMigrations(previous);
  expect(result.applied).toHaveLength(1);
  expect(result.applied[0]).toContain('factory_manual_intake');
  const after = openDb(previous);
  try {
    expect(
      after
        .prepare('SELECT value FROM app_metadata WHERE key=?')
        .get('synthetic-preserved'),
    ).toEqual({ value: 'retained' });
    expect(
      after.prepare('SELECT COUNT(*) AS n FROM factory_work_items').get(),
    ).toEqual({ n: 0 });
  } finally {
    after.close();
  }
});

it('rejects old reviewed repo context and accepts an explicitly reviewed replacement snapshot', () => {
  const ready = createReady();
  const save = {
    expectedVersion: ready.work.version,
    expectedSpecVersion: ready.work.specVersion,
    expectedRepoFingerprint: ready.repoFingerprint,
    spec: { ...spec, scope: 'Retained local edits' },
  };
  registry('/private/tmp/synthetic-repo-new-context');
  expect(() => saveFactorySpec(ready.work.id, save, actor, paths)).toThrow(
    'Repository configuration changed',
  );
  const changed = getFactoryWork(ready.work.id, paths);
  expect(changed.revisions).toHaveLength(2);
  expect(changed.blockers.join(' ')).toContain('context changed');
  const reviewed = saveFactorySpec(
    ready.work.id,
    { ...save, expectedRepoFingerprint: changed.repoFingerprint },
    actor,
    paths,
  );
  expect(reviewed.revisions.at(-1)?.repoContext?.path).toBe(
    '/private/tmp/synthetic-repo-new-context',
  );
  expect(reviewed.revisions.at(-1)?.spec.scope).toBe('Retained local edits');
  expect(reviewed.blockers).toEqual([]);
});
