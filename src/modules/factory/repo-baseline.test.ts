import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as gitIo from '../../lib/git';
import {
  ensureRuntimeHomeSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { dbRun, submitFactoryWork, updateFactorySource } from './service';
import { captureFactoryRepoBaseline } from './repo-baseline';
import {
  getPlanningIntent,
  getPlanningState,
  prepareFactoryPlanning,
  prepareFactoryTriage,
  recordTriage,
  refreshFactoryPlanningContext,
  updatePlanningIntent,
} from './planning-store';
import { readPlanningRepo } from './repo-tools';

let root: string,
  repo: string,
  upstream: string,
  remote: string,
  paths: RuntimePaths;
const actor = { kind: 'human' as const, id: 'fixture' };
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(cwd: string, text: string) {
  writeFileSync(join(cwd, 'README.md'), text);
  git(cwd, 'add', 'README.md');
  git(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    text,
  );
  return git(cwd, 'rev-parse', 'HEAD');
}
function push(text: string) {
  const sha = commit(upstream, text);
  git(upstream, 'push', 'origin', 'main');
  return sha;
}
function task() {
  return submitFactoryWork(
    {
      requestKey: crypto.randomUUID(),
      title: 'Plan',
      body: 'Plan changes',
      repoId: 'fixture',
    },
    actor,
    paths,
  );
}
function input(requestKey = 'plan') {
  return { requestKey, expectedVersion: 1, message: 'Plan this change' };
}
function complete(id: string) {
  updatePlanningIntent(
    id,
    (i) => {
      i.stage = 'completed';
    },
    paths,
  );
}
function checkoutState() {
  return {
    branch: git(repo, 'symbolic-ref', 'HEAD'),
    head: git(repo, 'rev-parse', 'HEAD'),
    main: git(repo, 'rev-parse', 'refs/heads/main'),
    tracking: git(repo, 'rev-parse', 'refs/remotes/origin/main'),
    status: git(repo, 'status', '--porcelain'),
    content: readFileSync(join(repo, 'README.md'), 'utf8'),
    fetchHead: readFileSync(join(repo, '.git', 'FETCH_HEAD'), 'utf8'),
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-baseline-'));
  paths = runtimePaths(join(root, 'runtime'));
  vi.stubEnv('NEONDECK_HOME', paths.home);
  ensureRuntimeHomeSync(paths);
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: true },
      models: { default: 'faux/faux-1' },
    }),
  );
  remote = join(root, 'remote.git');
  upstream = join(root, 'upstream');
  repo = join(root, 'repo');
  mkdirSync(upstream);
  git(root, 'init', '--bare', remote);
  git(upstream, 'init', '-b', 'main');
  commit(upstream, 'initial');
  git(upstream, 'remote', 'add', 'origin', remote);
  git(upstream, 'push', 'origin', 'main');
  git(root, 'clone', '--branch', 'main', remote, repo);
  git(repo, 'fetch', 'origin');
  git(repo, 'checkout', '-b', 'operator');
  commit(repo, 'operator branch');
  writeFileSync(join(repo, 'README.md'), 'dirty operator edits');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked fixture');
  writeFileSync(
    paths.repos,
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'fixture',
          path: repo,
          defaultBranch: 'main',
          github: { owner: 'example', name: 'fixture' },
        },
      ],
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('captures latest origin main despite stale local main, a different HEAD and dirty files, retaining an app ref', async () => {
  const sha = push('remote current');
  // Even dangerous configured fetch destinations are not applied to this fetch.
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
  const before = checkoutState();
  const work = task();
  const intent = await prepareFactoryPlanning(work.work.id, input(), paths);
  expect(intent.context).toMatchObject({
    repoCommit: sha,
    repoBaseline: { source: 'origin', branch: 'main' },
  });
  expect(checkoutState()).toEqual(before);
  expect(
    git(
      repo,
      'for-each-ref',
      '--format=%(objectname)',
      'refs/neondeck/factory/commits',
    ),
  ).toContain(sha);
  updatePlanningIntent(
    intent.id,
    (i) => {
      i.stage = 'planner';
    },
    paths,
  );
  expect(
    await readPlanningRepo(
      intent.sessionId,
      intent.id,
      'README.md',
      'read',
      paths,
    ),
  ).toMatchObject({ commit: sha, content: 'remote current' });
  expect(getPlanningState(work.work.id, paths).contextStale).toBe(false);
});
it('captures on first actual planner after automatic triage and never instantly marks that capture stale', async () => {
  const work = task();
  const triage = prepareFactoryTriage(work.work.id, paths)!;
  expect(triage.context.repoCommit).toBeNull();
  recordTriage(
    triage.sessionId,
    triage.id,
    {
      disposition: 'implement',
      summary: 'Plan it',
      priority: 'normal',
      missingInformation: [],
      candidateIds: [],
    },
    paths,
  );
  complete(triage.id);
  const sha = push('after triage');
  const intent = await prepareFactoryPlanning(work.work.id, input(), paths);
  expect(intent.sessionId).toBe(triage.sessionId);
  expect(intent.stage).toBe('planner');
  expect(intent.context.repoCommit).toBe(sha);
  expect(getPlanningState(work.work.id, paths).contextStale).toBe(false);
});
it('freezes existing sessions across local and remote movement; Refresh alone captures the new remote revision', async () => {
  const work = task();
  const first = await prepareFactoryPlanning(work.work.id, input(), paths);
  complete(first.id);
  const nextSha = push('later remote');
  commit(repo, 'later operator');
  git(repo, 'branch', '-f', 'main', 'operator');
  expect(getPlanningState(work.work.id, paths).contextStale).toBe(false);
  const second = await prepareFactoryPlanning(
    work.work.id,
    input('second'),
    paths,
  );
  expect(second.context.repoCommit).toBe(first.context.repoCommit);
  complete(second.id);
  const refreshed = await refreshFactoryPlanningContext(work.work.id, 1, paths);
  expect(refreshed.context.repoCommit).toBe(nextSha);
  expect(getPlanningIntent(first.id, paths).context.repoCommit).toBe(
    first.context.repoCommit,
  );
  expect(getPlanningState(work.work.id, paths).contextStale).toBe(false);
});
it('preserves legacy active bindings with no provenance field and still detects real prompt changes', async () => {
  const work = task();
  const first = await prepareFactoryPlanning(work.work.id, input(), paths);
  complete(first.id);
  dbRun(paths, (db) => {
    db.prepare(
      "UPDATE factory_planning_bindings SET record=json_remove(record, '$.context.repoBaseline') WHERE work_id=?",
    ).run(work.work.id);
  });
  push('remote advanced');
  const second = await prepareFactoryPlanning(
    work.work.id,
    input('legacy'),
    paths,
  );
  expect(second.context.repoCommit).toBe(first.context.repoCommit);
  expect(second.context.repoBaseline).toBeUndefined();
  complete(second.id);
  writeFileSync(paths.soul, 'Changed operator guidance');
  expect(getPlanningState(work.work.id, paths).contextStale).toBe(true);
  await expect(
    prepareFactoryPlanning(work.work.id, input('stale'), paths),
  ).rejects.toThrow(/context changed/);
});
it('fails remote capture without stale fallback or a persisted request, and preserves the old pin on failed refresh', async () => {
  const work = task();
  const first = await prepareFactoryPlanning(work.work.id, input(), paths);
  complete(first.id);
  git(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  const other = task();
  await expect(
    prepareFactoryPlanning(other.work.id, input(), paths),
  ).rejects.toThrow(/credentials.*No stale local fallback/);
  expect(getPlanningState(other.work.id, paths).sessionId).toBeNull();
  await expect(
    refreshFactoryPlanningContext(work.work.id, 1, paths),
  ).rejects.toThrow(/No stale local fallback/);
  const retained = await prepareFactoryPlanning(
    work.work.id,
    input('offline-existing'),
    paths,
  );
  expect(retained.context.repoCommit).toBe(first.context.repoCommit);
});
it('uses the explicit local default branch only when origin is absent, with clear provenance', async () => {
  git(repo, 'remote', 'remove', 'origin');
  const main = git(repo, 'rev-parse', 'refs/heads/main');
  const captured = await captureFactoryRepoBaseline({
    path: repo,
    defaultBranch: 'main',
    commands: {},
  });
  expect(captured).toMatchObject({
    repoCommit: main,
    repoBaseline: {
      source: 'local-default-branch',
      branch: 'main',
      ref: `refs/neondeck/factory/commits/${main}`,
    },
  });
  git(repo, 'branch', '-D', 'main');
  await expect(
    captureFactoryRepoBaseline({
      path: repo,
      defaultBranch: 'main',
      commands: {},
    }),
  ).rejects.toThrow(/HEAD is not used/);
});
it.each(['--upload-pack=bad', 'main:refs/heads/operator', '../main', 'main~1'])(
  'rejects unsafe default branch %s',
  async (branch) => {
    await expect(
      captureFactoryRepoBaseline({
        path: repo,
        defaultBranch: branch,
        commands: {},
      }),
    ).rejects.toThrow(/configured default branch/);
  },
);

function holdFetch() {
  const original = gitIo.runUnattendedGit;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(gitIo, 'runUnattendedGit')
    .mockImplementation(async (cwd, args, options) => {
      const result = await original(cwd, args, options);
      if (args.includes('fetch')) {
        entered();
        await gate;
      }
      return result;
    });
  return { waiting, release, spy };
}
it('fetches outside DB transactions and commits concurrent duplicate requests only once', async () => {
  const work = task(),
    held = holdFetch();
  const first = prepareFactoryPlanning(work.work.id, input(), paths);
  const second = prepareFactoryPlanning(work.work.id, input(), paths);
  await held.waiting;
  // A distinct SQLite connection can write while the asynchronous fetch waits.
  dbRun(paths, (db) => {
    db.prepare(
      'INSERT INTO factory_audit(work_id,action,actor,created_at) VALUES(?,?,?,?)',
    ).run(work.work.id, 'fixture', 'fixture', new Date().toISOString());
  });
  held.release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.id).toBe(b.id);
  expect(
    git(
      repo,
      'for-each-ref',
      '--format=%(refname)',
      'refs/neondeck/factory/fetch',
    ),
  ).toBe('');
  expect(
    git(
      repo,
      'for-each-ref',
      '--format=%(refname)',
      'refs/neondeck/factory/commits',
    ).split('\n'),
  ).toHaveLength(1);
  expect(
    dbRun(
      paths,
      (db) =>
        db
          .prepare(
            'SELECT count(*) AS n FROM factory_planning_intents WHERE work_id=?',
          )
          .get(work.work.id)?.n,
    ),
  ).toBe(1);
});
it.each(['config', 'repo', 'source', 'disabled'] as const)(
  'rejects %s changes made during preflight before binding or request persistence',
  async (change) => {
    const work = task(),
      held = holdFetch();
    const pending = prepareFactoryPlanning(work.work.id, input(), paths);
    await held.waiting;
    if (change === 'config' || change === 'disabled') {
      const config = JSON.parse(readFileSync(paths.config, 'utf8'));
      if (change === 'disabled') config.factory.enabled = false;
      else config.models.default = 'faux/faux-2';
      writeFileSync(paths.config, JSON.stringify(config));
    } else if (change === 'repo') {
      const registry = JSON.parse(readFileSync(paths.repos, 'utf8'));
      registry.repos[0].defaultBranch = 'operator';
      writeFileSync(paths.repos, JSON.stringify(registry));
    } else
      updateFactorySource(
        work.work.id,
        {
          expectedVersion: 1,
          title: 'Changed',
          body: 'Changed',
          repoId: 'fixture',
        },
        actor,
        paths,
      );
    held.release();
    await expect(pending).rejects.toThrow(/changed|disabled/i);
    expect(getPlanningState(work.work.id, paths).sessionId).toBeNull();
    expect(
      git(
        repo,
        'for-each-ref',
        '--format=%(refname)',
        'refs/neondeck/factory/fetch',
      ),
    ).toBe('');
  },
);
it('prevents concurrent refresh from replacing a pin underneath an admitted request', async () => {
  const work = task();
  const first = await prepareFactoryPlanning(work.work.id, input(), paths);
  complete(first.id);
  push('refresh race');
  const held = holdFetch();
  const refresh = refreshFactoryPlanningContext(work.work.id, 1, paths);
  await held.waiting;
  const admitted = await prepareFactoryPlanning(
    work.work.id,
    input('concurrent'),
    paths,
  );
  held.release();
  await expect(refresh).rejects.toThrow(/inputs changed/);
  expect(admitted.context.repoCommit).toBe(first.context.repoCommit);
});

it('removes a temporary ref even when the fetch fails after writing it', async () => {
  const original = gitIo.runUnattendedGit;
  vi.spyOn(gitIo, 'runUnattendedGit').mockImplementation(
    async (cwd, args, options) => {
      const result = await original(cwd, args, options);
      if (args.includes('fetch'))
        throw new Error('Synthetic post-fetch failure');
      return result;
    },
  );
  await expect(
    prepareFactoryPlanning(task().work.id, input(), paths),
  ).rejects.toThrow(/No stale local fallback/);
  expect(
    git(repo, 'for-each-ref', '--format=%(refname)', 'refs/neondeck/factory'),
  ).toBe('');
});
