import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import {
  readWorktreeRecord,
  reserveFactoryPublicationWorkspace,
} from '../worktrees';
import { openDb } from '../../lib/sqlite';
import { runtimePaths, ensureRuntimeHome } from '../../runtime-home';
import { captureCandidateTree, type CandidateEvidence } from './evidence';
import { PublicationPushNotAttemptedError } from './publication-nonadmission';
import {
  preparePublicationWorkspace,
  commitPublicationWorkspace,
  pushPublicationCommit,
  readPublicationPushTarget,
  readValidatedPublicationCommitReceipt,
  readStoredPublicationPushTarget,
} from './publication-git';

const state = vi.hoisted<{
  source: string;
  remote: string;
  pipeline: DeliveryPipeline | null;
  pushRace: (() => Promise<void>) | null;
  loseCommitResponse: boolean;
  remoteRead: (() => Promise<void>) | null;
}>(() => ({
  source: '',
  remote: '',
  pipeline: null,
  pushRace: null,
  loseCommitResponse: false,
  remoteRead: null,
}));
vi.mock('./store', () => ({
  getFactoryDeliveryOwnership: () => state.pipeline,
  getDeliveryPipeline: () => state.pipeline,
  sameDeliveryRevision: (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b),
}));
// Transport seam only: commands still execute real Git against a local bare
// remote. Remote configuration/identity checks use the public-safe GitHub URL.
vi.mock('../../lib/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/git')>();
  return {
    ...original,
    runUnattendedGit: async (
      cwd: string,
      args: string[],
      options: import('../../lib/git').UnattendedGitOptions,
    ) => {
      if (args.includes('push') && state.pushRace) {
        const race = state.pushRace;
        state.pushRace = null;
        await race();
      }
      const result = await original.runUnattendedGit(
        cwd,
        args.map((arg) =>
          arg === 'https://github.com/example/fixture.git' ? state.remote : arg,
        ),
        options,
      );
      if (args.includes('ls-remote') && state.remoteRead) {
        const duringRead = state.remoteRead;
        state.remoteRead = null;
        await duringRead();
      }
      if (args.includes('commit') && state.loseCommitResponse) {
        state.loseCommitResponse = false;
        throw new Error('synthetic crash after HEAD update');
      }
      return result;
    },
  };
});
const exec = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]) {
  return (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      },
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
}
afterEach(async () => {
  state.pipeline = null;
  state.pushRace = null;
  state.loseCommitResponse = false;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'factory-publication-')),
  );
  roots.push(root);
  const source = join(root, 'source');
  const retained = join(root, 'retained');
  const remote = join(root, 'remote.git');
  await mkdir(source);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'commit.gpgsign', 'false');
  await git(source, 'config', 'user.name', 'Synthetic Author');
  await git(source, 'config', 'user.email', 'author@example.invalid');
  await mkdir(join(source, '.githooks'));
  await writeFile(join(source, '.githooks/pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(join(source, '.githooks/pre-commit'), 0o755);
  await git(source, 'config', 'core.hooksPath', '.githooks');
  await writeFile(join(source, 'value.txt'), 'original\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'Synthetic base');
  const headSha = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'worktree', 'add', '-b', 'candidate', retained, headSha);
  await writeFile(join(retained, 'value.txt'), 'certified\n');
  await writeFile(join(retained, 'added.txt'), 'added\n');
  const treeSha = await captureCandidateTree(retained, root);
  const time = '2026-09-06T00:00:00.000Z';
  const revision = {
    runId: 'run',
    attemptId: 'attempt',
    releaseId: 'release',
    specVersion: 1,
    specHash: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    baseSha: headSha,
    headSha,
    treeSha,
  };
  const pipeline: DeliveryPipeline = {
    pipelineId: 'c'.repeat(64),
    version: 1,
    workItemId: 'work',
    repoId: 'fixture',
    initialRevision: revision,
    revision,
    branch: `agent/factory-${'c'.repeat(64)}`,
    prIdentity: 'synthetic-pr',
    pr: null,
    authorization: {
      id: 'grant',
      authorizedBy: 'operator',
      authorizedAt: time,
      revision,
      repoId: 'fixture',
      target: { owner: 'example', name: 'fixture', baseBranch: 'main' },
      configFingerprint: 'd'.repeat(64),
      checkCommands: ['check'],
      maxRepairAttempts: 2,
      totalExecutionMs: 10000,
      initialExecutionMs: 1,
    },
    repairs: [],
    progress: {
      limits: {
        maxAssessments: 2,
        maxAssessmentsPerRepair: 1,
        maxAssessmentMs: 180000,
      },
      assessments: [],
    },
    feedback: [],
    evidence: [],
    effects: [
      {
        id: `commit:${revision.candidateDigest}`,
        kind: 'commit',
        revision,
        state: 'in-flight',
        receiptRef: null,
        reservedExecutionMs: null,
        executionMs: null,
      },
    ],
    interventions: [],
    commits: [],
    coordinator: {
      candidateRef: null,
      watchId: null,
      observationFingerprint: null,
      terminalObservedAt: null,
      watchObservedAt: null,
    },
    outcome: null,
    outcomeRef: null,
    createdAt: time,
    updatedAt: time,
  };
  const evidence: CandidateEvidence = {
    attemptId: revision.attemptId,
    repoId: 'fixture',
    worktreeId: 'retained',
    root: retained,
    baseSha: headSha,
    headSha,
    revision: treeSha,
    treeSha,
    evidenceDigest: revision.candidateDigest,
    statusHash: 'a'.repeat(64),
    diffHash: 'a'.repeat(64),
    untrackedHash: 'a'.repeat(64),
  };
  await git(root, 'init', '--bare', remote);
  await git(
    source,
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  );
  state.source = source;
  state.remote = remote;
  state.pipeline = pipeline;
  const paths = runtimePaths(join(root, 'home'));
  await ensureRuntimeHome(paths);
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: [
        {
          id: 'fixture',
          path: source,
          github: { owner: 'example', name: 'fixture' },
          defaultBranch: 'main',
        },
      ],
    }),
  );
  const authority = vi.fn<() => Promise<void>>(async () => {});
  const beforePush = vi.fn<() => Promise<void>>(async () => {});
  const prepare = () =>
    preparePublicationWorkspace(pipeline, evidence, paths, authority);
  return {
    root,
    source,
    retained,
    remote,
    pipeline,
    evidence,
    paths,
    authority,
    beforePush,
    prepare,
  };
}
it('materializes the certified tree separately without a commit or retained-checkout mutation', async () => {
  const f = await fixture();
  const before = await git(f.retained, 'status', '--porcelain=v1');
  const workspace = await f.prepare();
  expect(await git(workspace.root, 'rev-parse', 'HEAD')).toBe(
    f.evidence.headSha,
  );
  expect(await git(workspace.root, 'write-tree')).toBe(f.evidence.treeSha);
  expect(await readFile(join(workspace.root, 'value.txt'), 'utf8')).toBe(
    'certified\n',
  );
  expect(await git(f.retained, 'status', '--porcelain=v1')).toBe(before);
  expect(await git(f.retained, 'rev-parse', 'HEAD')).toBe(f.evidence.headSha);
  expect(readWorktreeRecord(workspace.worktreeId, f.paths)).toMatchObject({
    owningWorkflowRunId: `factory-delivery:${f.pipeline.pipelineId}`,
    directPushAllowed: false,
  });
  expect(await f.prepare()).toEqual(workspace);
});
it('runs repository precommit hook, uses configured author, and recovers exactly the same commit', async () => {
  const f = await fixture();
  const hookLog = join(f.root, 'hook-ran');
  await writeFile(
    join(f.source, '.githooks/pre-commit'),
    `#!/bin/sh\nprintf 'ran' >> '${hookLog}'\n`,
  );
  const workspace = await f.prepare();
  const result = await commitPublicationWorkspace(
    f.pipeline,
    workspace,
    f.paths,
    f.authority,
  );
  expect(await readFile(hookLog, 'utf8')).toBe('ran');
  expect(
    await git(
      workspace.root,
      'show',
      '-s',
      '--format=%an <%ae>',
      result.publishedHeadSha,
    ),
  ).toBe('Synthetic Author <author@example.invalid>');
  expect(
    await git(workspace.root, 'rev-parse', `${result.publishedHeadSha}^{tree}`),
  ).toBe(f.evidence.treeSha);
  expect(
    await git(workspace.root, 'rev-parse', `${result.publishedHeadSha}^`),
  ).toBe(f.evidence.headSha);
  expect(
    await commitPublicationWorkspace(
      f.pipeline,
      workspace,
      f.paths,
      f.authority,
    ),
  ).toEqual(result);
  expect(await f.prepare()).toEqual(workspace);
  expect(await readFile(hookLog, 'utf8')).toBe('ran');
});
it('never skips a failing repository secret scanner', async () => {
  const f = await fixture();
  await writeFile(
    join(f.source, '.githooks/pre-commit'),
    '#!/bin/sh\necho "synthetic scanner blocked" >&2\nexit 1\n',
  );
  const workspace = await f.prepare();
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow('scanner blocked');
  expect(await git(workspace.root, 'rev-parse', 'HEAD')).toBe(
    f.evidence.headSha,
  );
});
it.each(['staged', 'unstaged'])(
  'rejects %s hook mutations and cannot recover them as a receipt',
  async (mode) => {
    const f = await fixture();
    await writeFile(
      join(f.source, '.githooks/pre-commit'),
      `#!/bin/sh\necho mutation > value.txt\n${mode === 'staged' ? 'git add value.txt' : ':'}\n`,
    );
    const workspace = await f.prepare();
    await expect(
      commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
    ).rejects.toThrow(/tree/);
    await expect(
      commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
    ).rejects.toThrow('no validated hook-success receipt');
    expect(await readFile(join(f.retained, 'value.txt'), 'utf8')).toBe(
      'certified\n',
    );
  },
);
it('requires configured author identity and does not silently clean verification changes', async () => {
  const f = await fixture();
  const workspace = await f.prepare();
  await git(f.source, 'config', 'user.email', '');
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow(/.+/);
  await writeFile(join(workspace.root, 'value.txt'), 'verification mutation\n');
  await expect(f.prepare()).rejects.toThrow('uncertified');
});
it('rejects foreign existing branch and revoked authority before mutations', async () => {
  const f = await fixture();
  await git(
    f.source,
    'branch',
    `${f.pipeline.branch}-revision-${f.pipeline.revision.candidateDigest}`,
  );
  await expect(f.prepare()).rejects.toThrow('Unreserved');
  await git(
    f.source,
    'branch',
    '-D',
    `${f.pipeline.branch}-revision-${f.pipeline.revision.candidateDigest}`,
  );
  f.authority.mockRejectedValue(new Error('lease revoked'));
  await expect(f.prepare()).rejects.toThrow('lease revoked');
  expect(
    await git(
      f.source,
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${`${f.pipeline.branch}-revision-${f.pipeline.revision.candidateDigest}`}`,
    ),
  ).toBe('');
});
async function committed(input?: Awaited<ReturnType<typeof fixture>>) {
  const f = input ?? (await fixture());
  const workspace = await f.prepare();
  const commit = await commitPublicationWorkspace(
    f.pipeline,
    workspace,
    f.paths,
    f.authority,
  );
  const target = await readPublicationPushTarget(
    f.pipeline,
    workspace,
    'origin',
    f.paths,
    f.authority,
  );
  f.pipeline.commits.push({
    revision: f.pipeline.revision,
    publishedHeadSha: commit.publishedHeadSha,
    treeSha: commit.treeSha,
    evidenceRef: 'synthetic-receipt',
  });
  return {
    ...f,
    workspace,
    commit,
    target,
    push: (expected: string | null = null) =>
      pushPublicationCommit(
        f.pipeline,
        commit,
        target,
        expected,
        f.paths,
        f.authority,
        f.beforePush,
      ),
  };
}
it('pushes the certified commit with expected absence and recovers an already delivered push', async () => {
  const f = await committed();
  expect(await f.push()).toMatchObject({
    remoteSha: f.commit.publishedHeadSha,
    alreadyPublished: false,
  });
  expect(
    await git(f.remote, 'rev-parse', `refs/heads/${f.pipeline.branch}`),
  ).toBe(f.commit.publishedHeadSha);
  expect(f.beforePush).toHaveBeenCalledOnce();
  f.beforePush.mockRejectedValue(new Error('PR no longer authorizes mutation'));
  expect(await f.push()).toMatchObject({ alreadyPublished: true });
  expect(f.beforePush).toHaveBeenCalledOnce();
});
it('does not push when the immediate PR mutation guard rejects', async () => {
  const f = await committed();
  await git(
    f.source,
    'push',
    f.remote,
    `${f.evidence.headSha}:refs/heads/${f.pipeline.branch}`,
  );
  f.beforePush.mockRejectedValue(new Error('PR no longer authorizes mutation'));
  await expect(f.push(f.evidence.headSha)).rejects.toBeInstanceOf(
    PublicationPushNotAttemptedError,
  );
  expect(f.beforePush).toHaveBeenCalledOnce();
  expect(
    await git(f.remote, 'rev-parse', `refs/heads/${f.pipeline.branch}`),
  ).toBe(f.evidence.headSha);
});
it('rejects an existing foreign remote branch without overwriting it', async () => {
  const f = await committed();
  await git(
    f.source,
    'push',
    f.remote,
    `${f.evidence.headSha}:refs/heads/${f.pipeline.branch}`,
  );
  await expect(f.push()).rejects.toThrow('expected lease');
  expect(
    await git(f.remote, 'rev-parse', `refs/heads/${f.pipeline.branch}`),
  ).toBe(f.evidence.headSha);
});
it('expected absence lease rejects a branch created between probe and push', async () => {
  const f = await committed();
  state.pushRace = async () => {
    await git(
      f.source,
      'push',
      f.remote,
      `${f.evidence.headSha}:refs/heads/${f.pipeline.branch}`,
    );
  };
  const failure: unknown = await f.push().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(PublicationPushNotAttemptedError);
  expect((failure as Error).message).toMatch(/stale info|rejected/);
  expect(
    await git(f.remote, 'rev-parse', `refs/heads/${f.pipeline.branch}`),
  ).toBe(f.evidence.headSha);
});
it('supports an exact existing SHA with fast-forward ancestry and rejects target drift', async () => {
  const f = await committed();
  await git(
    f.source,
    'push',
    f.remote,
    `${f.evidence.headSha}:refs/heads/${f.pipeline.branch}`,
  );
  expect(await f.push(f.evidence.headSha)).toMatchObject({
    alreadyPublished: false,
  });
  await git(
    f.source,
    'remote',
    'set-url',
    '--push',
    'origin',
    'https://github.com/other/fixture.git',
  );
  await expect(f.push()).rejects.toThrow(/another repository|ambiguous/);
});
it('requires durable binding before any push and rejects altered fingerprint', async () => {
  const f = await committed();
  await expect(
    pushPublicationCommit(
      f.pipeline,
      f.commit,
      { ...f.target, fingerprint: 'f'.repeat(64) },
      null,
      f.paths,
      f.authority,
      f.beforePush,
    ),
  ).rejects.toThrow('fingerprint');
  f.pipeline.commits.length = 0;
  await expect(f.push()).rejects.toThrow('durably bound');
  expect(await git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe('');
});
it('accepts a bound commit receipt at the push-target read boundary', async () => {
  const f = await committed();
  expect(
    await readPublicationPushTarget(
      f.pipeline,
      f.commit,
      'origin',
      f.paths,
      f.authority,
    ),
  ).toEqual(f.target);
  expect(await f.prepare()).toEqual(f.workspace);
});
it('rejects tampered parent identity and URL rewrite redirection', async () => {
  const f = await committed();
  await expect(
    commitPublicationWorkspace(
      f.pipeline,
      { ...f.workspace, originalHeadSha: 'e'.repeat(40) },
      f.paths,
      f.authority,
    ),
  ).rejects.toThrow('ownership');
  await git(
    f.source,
    'config',
    'url.https://github.com/other/.insteadOf',
    'https://github.com/example/',
  );
  await expect(f.push()).rejects.toThrow('URL rewrites');
});
it('a known existing SHA never authorizes non-fast-forward overwrite', async () => {
  const f = await committed();
  await writeFile(join(f.source, 'foreign.txt'), 'foreign\n');
  await git(f.source, 'add', 'foreign.txt');
  await git(f.source, 'commit', '-m', 'Foreign work');
  const foreign = await git(f.source, 'rev-parse', 'HEAD');
  await git(
    f.source,
    'push',
    f.remote,
    `${foreign}:refs/heads/${f.pipeline.branch}`,
  );
  await expect(f.push(foreign)).rejects.toThrow(/.+/);
  expect(
    await git(f.remote, 'rev-parse', `refs/heads/${f.pipeline.branch}`),
  ).toBe(foreign);
});
it('materializes and commits a repair tree as a fast-forward child of the prior publication', async () => {
  const f = await committed();
  await f.push();
  await writeFile(join(f.retained, 'value.txt'), 'repaired\n');
  const treeSha = await captureCandidateTree(f.retained, f.root);
  const revision = {
    ...f.pipeline.revision,
    attemptId: 'repair-attempt',
    treeSha,
    candidateDigest: 'e'.repeat(64),
  };
  f.pipeline.revision = revision;
  f.pipeline.effects.push({
    id: `commit:${revision.candidateDigest}`,
    kind: 'commit',
    revision,
    state: 'in-flight',
    receiptRef: null,
    reservedExecutionMs: null,
    executionMs: null,
  });
  const evidence = {
    ...f.evidence,
    attemptId: revision.attemptId,
    treeSha,
    revision: treeSha,
    evidenceDigest: revision.candidateDigest,
  };
  const workspace = await preparePublicationWorkspace(
    f.pipeline,
    evidence,
    f.paths,
    f.authority,
  );
  expect(workspace.originalHeadSha).toBe(f.commit.publishedHeadSha);
  const commit = await commitPublicationWorkspace(
    f.pipeline,
    workspace,
    f.paths,
    f.authority,
  );
  f.pipeline.commits.push({
    revision,
    treeSha,
    publishedHeadSha: commit.publishedHeadSha,
    evidenceRef: 'repair-receipt',
  });
  const target = await readPublicationPushTarget(
    f.pipeline,
    workspace,
    'origin',
    f.paths,
    f.authority,
  );
  expect(
    await pushPublicationCommit(
      f.pipeline,
      commit,
      target,
      f.commit.publishedHeadSha,
      f.paths,
      f.authority,
      f.beforePush,
    ),
  ).toMatchObject({ remoteSha: commit.publishedHeadSha });
  expect(
    await git(workspace.root, 'rev-parse', `${commit.publishedHeadSha}^`),
  ).toBe(f.commit.publishedHeadSha);
});
it('does not treat a non-executable precommit scanner as successful execution', async () => {
  const f = await fixture();
  const workspace = await f.prepare();
  await chmod(join(f.source, '.githooks/pre-commit'), 0o644);
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow('not executable');
});
async function recertify(f: Awaited<ReturnType<typeof fixture>>) {
  const tree = await captureCandidateTree(f.retained, f.root);
  f.evidence.treeSha = tree;
  f.evidence.revision = tree;
  f.pipeline.revision.treeSha = tree;
}
it('pre-push runs the trusted source scanner even when the candidate supplies a permissive hook', async () => {
  const f = await fixture();
  await writeFile(
    join(f.source, '.githooks/pre-push'),
    '#!/bin/sh\necho trusted-push-scanner-blocked >&2\nexit 1\n',
  );
  await chmod(join(f.source, '.githooks/pre-push'), 0o755);
  await writeFile(
    join(f.retained, '.githooks/pre-push'),
    '#!/bin/sh\nexit 0\n',
  );
  await chmod(join(f.retained, '.githooks/pre-push'), 0o755);
  await recertify(f);
  const c = await committed(f);
  await expect(c.push()).rejects.toThrow('trusted-push-scanner-blocked');
  expect(await git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe('');
});
it('a candidate-only pre-push hook never executes with publisher credentials', async () => {
  const f = await fixture();
  const marker = join(f.root, 'candidate-hook-ran');
  await writeFile(
    join(f.retained, '.githooks/pre-push'),
    `#!/bin/sh\necho unsafe > '${marker}'\n`,
  );
  await chmod(join(f.retained, '.githooks/pre-push'), 0o755);
  await recertify(f);
  const c = await committed(f);
  await c.push();
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('hook/config drift during commit remains blocked across live retry and readonly recovery', async () => {
  const f = await fixture();
  await writeFile(
    join(f.source, '.githooks/pre-commit'),
    '#!/bin/sh\nprintf "#!/bin/sh\\nexit 0\\n" > "$0"\n',
  );
  const workspace = await f.prepare();
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow('configuration changed');
  expect(await git(workspace.root, 'rev-parse', 'HEAD')).not.toBe(
    f.evidence.headSha,
  );
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow('configuration or intent changed');
  await expect(
    readValidatedPublicationCommitReceipt(f.pipeline, workspace, f.paths),
  ).rejects.toThrow('configuration or intent changed');
});
it('a crash after HEAD update cannot invent successful hook provenance from matching tree/message', async () => {
  const f = await fixture();
  const workspace = await f.prepare();
  state.loseCommitResponse = true;
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow('crash after HEAD');
  const head = await git(workspace.root, 'rev-parse', 'HEAD');
  expect(head).not.toBe(f.evidence.headSha);
  await expect(
    readValidatedPublicationCommitReceipt(f.pipeline, workspace, f.paths),
  ).rejects.toThrow('no validated hook-success receipt');
  await expect(
    commitPublicationWorkspace(f.pipeline, workspace, f.paths, f.authority),
  ).rejects.toThrow('no validated hook-success receipt');
  expect(await git(workspace.root, 'rev-parse', 'HEAD')).toBe(head);
});
it('readonly receipt recovery survives revoked authority and stored push target rejects rewrites', async () => {
  const f = await committed();
  f.authority.mockRejectedValue(new Error('revoked'));
  expect(
    await readValidatedPublicationCommitReceipt(
      f.pipeline,
      f.workspace,
      f.paths,
    ),
  ).toEqual(f.commit);
  expect(
    await readStoredPublicationPushTarget(
      f.pipeline,
      f.workspace,
      f.target,
      f.paths,
    ),
  ).toEqual(f.target);
  await git(
    f.source,
    'config',
    'url.https://github.com/other/.insteadOf',
    'https://github.com/example/',
  );
  await expect(
    readStoredPublicationPushTarget(f.pipeline, f.workspace, f.target, f.paths),
  ).rejects.toThrow('URL rewrites');
});
it('public workspace reservation is idempotent, advances lifecycle, and rejects stale/adopted claims', async () => {
  const f = await committed();
  expect(readWorktreeRecord(f.workspace.worktreeId, f.paths)).toMatchObject({
    lifecycleStatus: 'prepared-diff',
    headSha: f.commit.publishedHeadSha,
  });
  await f.push();
  expect(readWorktreeRecord(f.workspace.worktreeId, f.paths)).toMatchObject({
    lifecycleStatus: 'succeeded',
    lastPushedSha: f.commit.publishedHeadSha,
  });
  const claim = {
    pipelineId: f.pipeline.pipelineId,
    repoId: f.pipeline.repoId,
    expectedVersion: f.pipeline.version,
    originalHeadSha: f.evidence.headSha,
  };
  const reservations = await Promise.all([
    reserveFactoryPublicationWorkspace(claim, f.paths),
    reserveFactoryPublicationWorkspace(claim, f.paths),
  ]);
  expect(reservations[0].record.id).toBe(reservations[1].record.id);
  await expect(
    reserveFactoryPublicationWorkspace(
      { ...claim, expectedVersion: 99 },
      f.paths,
    ),
  ).rejects.toThrow('stale');
  const db = openDb(f.paths.neondeckDatabase);
  try {
    db.prepare('UPDATE worktrees SET adopted=1 WHERE id=?').run(
      f.workspace.worktreeId,
    );
  } finally {
    db.close();
  }
  await expect(f.prepare()).rejects.toThrow('another owner');
});
async function nextCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  const prior = f.pipeline.revision;
  const retained = join(f.root, 'repair-retained');
  await git(
    f.source,
    'worktree',
    'add',
    '-b',
    'repair-candidate',
    retained,
    prior.headSha,
  );
  await writeFile(join(retained, 'value.txt'), 'repaired before publication\n');
  const treeSha = await captureCandidateTree(retained, f.root);
  const revision = {
    ...prior,
    runId: 'repair-run',
    attemptId: 'repair-attempt',
    candidateDigest: 'e'.repeat(64),
    treeSha,
  };
  f.pipeline.revision = revision;
  f.pipeline.repairs.push({
    runId: revision.runId,
    attemptId: revision.attemptId,
    requestId: 'repair-request',
    progressAssessmentId: null,
    progressInputDigest: null,
    progressEvidenceDigest: null,
    reservedExecutionMs: 1000,
    executionMs: 10,
    fromRevision: prior,
    status: 'candidate',
    revision,
    reason: 'Synthetic bounded repair',
  });
  for (const effect of f.pipeline.effects) effect.state = 'delivered';
  f.pipeline.effects.push({
    id: `commit:${revision.candidateDigest}`,
    kind: 'commit',
    revision,
    state: 'in-flight',
    receiptRef: null,
    reservedExecutionMs: null,
    executionMs: null,
  });
  return {
    ...f.evidence,
    root: retained,
    worktreeId: 'repair-retained',
    attemptId: revision.attemptId,
    treeSha,
    revision: treeSha,
    evidenceDigest: revision.candidateDigest,
  };
}
it.each(['check', 'review'])(
  'prepublication repair after a clean failing %s gets a new checkout and keeps one remote lineage',
  async (phase) => {
    const f = await fixture();
    const first = await f.prepare();
    const check =
      phase === 'check'
        ? exec(process.execPath, ['-e', 'process.exit(1)'], { cwd: first.root })
        : Promise.reject(
            Object.assign(new Error('synthetic review requested repair'), {
              code: 1,
            }),
          );
    await expect(check).rejects.toMatchObject({ code: 1 });
    const oldTree = await git(first.root, 'write-tree');
    const evidence = await nextCandidate(f);
    const second = await preparePublicationWorkspace(
      f.pipeline,
      evidence,
      f.paths,
      f.authority,
    );
    expect(second.root).not.toBe(first.root);
    expect(second.branch).not.toBe(first.branch);
    expect(await git(first.root, 'write-tree')).toBe(oldTree);
    expect(await git(first.root, 'rev-parse', 'HEAD')).toBe(f.evidence.headSha);
    expect(await readFile(join(first.root, 'value.txt'), 'utf8')).toBe(
      'certified\n',
    );
    expect(await git(second.root, 'write-tree')).toBe(evidence.treeSha);
    const commit = await commitPublicationWorkspace(
      f.pipeline,
      second,
      f.paths,
      f.authority,
    );
    f.pipeline.commits.push({
      revision: f.pipeline.revision,
      publishedHeadSha: commit.publishedHeadSha,
      treeSha: commit.treeSha,
      evidenceRef: 'repaired-receipt',
    });
    const target = await readPublicationPushTarget(
      f.pipeline,
      second,
      'origin',
      f.paths,
      f.authority,
    );
    expect(target.branch).toBe(f.pipeline.branch);
    await pushPublicationCommit(
      f.pipeline,
      commit,
      target,
      null,
      f.paths,
      f.authority,
      f.beforePush,
    );
    expect(await git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe(
      `refs/heads/${f.pipeline.branch}`,
    );
  },
);
it.each(['check', 'hook'])(
  'a new revision retains old %s mutations instead of resetting them',
  async (phase) => {
    const f = await fixture();
    const first = await f.prepare();
    let hookError: unknown = null;
    if (phase === 'check')
      await writeFile(join(first.root, 'value.txt'), 'dirty check output\n');
    else {
      await writeFile(
        join(f.source, '.githooks/pre-commit'),
        '#!/bin/sh\necho dirty-hook-output > value.txt\ngit add value.txt\nexit 1\n',
      );
      try {
        await commitPublicationWorkspace(
          f.pipeline,
          first,
          f.paths,
          f.authority,
        );
      } catch (error) {
        hookError = error;
      }
    }
    expect(hookError instanceof Error).toBe(phase === 'hook');
    const retainedBytes = await readFile(join(first.root, 'value.txt'), 'utf8');
    const retainedIndex = await git(first.root, 'write-tree');
    const evidence = await nextCandidate(f);
    const second = await preparePublicationWorkspace(
      f.pipeline,
      evidence,
      f.paths,
      f.authority,
    );
    expect(second.root).not.toBe(first.root);
    expect(await readFile(join(first.root, 'value.txt'), 'utf8')).toBe(
      retainedBytes,
    );
    expect(await git(first.root, 'write-tree')).toBe(retainedIndex);
    expect(await git(first.root, 'rev-parse', 'HEAD')).toBe(f.evidence.headSha);
    expect(
      readWorktreeRecord(first.worktreeId, f.paths).lifecycleStatus,
    ).not.toBe('deleted');
    expect(await git(second.root, 'write-tree')).toBe(evidence.treeSha);
  },
);

it('classifies revocation during the remote read as known nonadmission before the final callback', async () => {
  const f = await committed();
  await git(
    f.source,
    'push',
    f.remote,
    `${f.evidence.headSha}:refs/heads/${f.pipeline.branch}`,
  );
  state.remoteRead = async () => {
    f.authority.mockRejectedValue(
      new Error('authority revoked during remote read'),
    );
  };
  await expect(f.push(f.evidence.headSha)).rejects.toBeInstanceOf(
    PublicationPushNotAttemptedError,
  );
  expect(f.beforePush).not.toHaveBeenCalled();
  expect(
    await git(f.remote, 'rev-parse', `refs/heads/${f.pipeline.branch}`),
  ).toBe(f.evidence.headSha);
});
