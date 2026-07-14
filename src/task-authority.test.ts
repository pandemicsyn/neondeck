import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { fixPrReviewFeedbackAction } from './modules/autopilot';
import { listExecutionApprovals } from './modules/execution';
import { currentTaskOrigin } from './modules/flue/origin';
import { runWithFlueExecutionContextForTests } from './modules/flue/execution-context';
import { evaluateRepoGuardrails } from './modules/repo-guardrails';
import {
  parseLinkedWatchPrNumber,
  resolveInteractiveRepoContext,
} from './modules/sessions/repo-context';
import { createChatSession } from './modules/sessions';
import { postGitHubPrComment } from './modules/pr-events';
import { replaceRepoFile } from './repo-edit';
import {
  commitInteractiveRepo,
  pushInteractiveRepo,
  repoCommitAction,
  repoPushAction,
} from './repo-edit/actions';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import type { GitHubPullRequestEventState } from './modules/github';
import {
  lockWorktree,
  readWorktreeLock,
  releaseWorktreeLock,
} from './modules/worktrees';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('task authority', () => {
  it('derives origin only from the Flue workflow run id', () => {
    expect(currentTaskOrigin()).toBe('interactive');
    expect(
      runWithFlueExecutionContextForTests({ instanceId: 'chat' }, () =>
        currentTaskOrigin(),
      ),
    ).toBe('interactive');
    expect(
      runWithFlueExecutionContextForTests({ runId: 'workflow-run' }, () =>
        currentTaskOrigin(),
      ),
    ).toBe('autopilot');
  });

  it('enforces inverse origin guards at the action boundary', async () => {
    const commit = await runWithFlueExecutionContextForTests(
      { runId: 'workflow-run' },
      () =>
        Promise.resolve(
          repoCommitAction.run({
            input: {
              repoId: 'repo',
              worktreeId: 'worktree',
              message: 'test',
            },
          } as never),
        ),
    );
    const push = await runWithFlueExecutionContextForTests(
      { runId: 'workflow-run' },
      () => Promise.resolve(repoPushAction.run({ input: {} } as never)),
    );
    const autopilot = await Promise.resolve(
      fixPrReviewFeedbackAction.run({
        input: { repoId: 'repo', prNumber: 1 },
      } as never),
    );

    expect(commit).toMatchObject({ ok: false, requires: ['interactiveOnly'] });
    expect(push).toMatchObject({ ok: false, requires: ['interactiveOnly'] });
    expect(autopilot).toMatchObject({
      ok: false,
      requires: ['autopilotWorkflow'],
    });
  });

  it('classifies hardline denies separately from interactive expansions', async () => {
    const { paths, repo } = await fixture();
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(
      join(repo, 'src/blocked.ts'),
      'export const blocked = true;\n',
    );
    await writeFile(join(repo, '.github/workflows/ci.yml'), 'name: CI\n');

    const result = await evaluateRepoGuardrails(
      {
        repoId: 'sample',
        guardrails: {
          deniedFileGlobs: ['src/blocked.ts'],
          approvalRequiredFileGlobs: [],
          highRiskClasses: ['ci-config'],
          maxFilesChanged: 50,
          maxLinesChanged: 1_500,
          allowForcePush: false,
          allowedPushDestinations: ['pull-request-head'],
          requiredChecks: [],
          generatedFileSizeThresholdBytes: 256 * 1024,
        },
      },
      paths,
    );

    expect(result.denied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'denied-path' }),
      ]),
    );
    expect(result.expansions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'high-risk-file' }),
      ]),
    );
  });

  it('resolves linked-watch PR context and supports repo-only sessions', async () => {
    const { paths, sha } = await fixture();
    const linked = await createChatSession(
      {
        kind: 'watch',
        linkedRepoId: 'sample',
        linkedWatchId: 'example/sample#42',
        activate: false,
      },
      paths,
    );
    if (!linked.ok || !('session' in linked)) {
      throw new Error(linked.message);
    }
    const eventState = fakeEventState(sha);
    const context = await resolveInteractiveRepoContext(
      { sessionId: linked.session.id },
      paths,
      {
        token: 'test',
        fetchPullRequestEventState: async () => eventState,
      },
    );
    const repoOnly = await resolveInteractiveRepoContext(
      { repoId: 'sample', worktreeId: context!.worktree.id },
      paths,
    );

    expect(parseLinkedWatchPrNumber('example/sample#42')).toBe(42);
    expect(context).toMatchObject({
      prNumber: 42,
      linkedPrHead: true,
      pushBranch: 'feature',
    });
    expect(repoOnly).toMatchObject({ prNumber: null, linkedPrHead: false });
  });

  it('lets a notify-only linked session edit, commit, push, and comment with zero execution approvals', async () => {
    const { paths, repo, sha } = await fixture();
    const remote = await mkdtemp(join(tmpdir(), 'neondeck-authority-remote-'));
    tempRoots.push(remote);
    await execFileAsync('git', ['init', '--bare'], { cwd: remote });
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        guardrails: {
          deniedFileGlobs: [],
          approvalRequiredFileGlobs: [],
          highRiskClasses: [],
          maxFilesChanged: 50,
          maxLinesChanged: 1_500,
          allowForcePush: false,
          allowedPushDestinations: ['pull-request-head'],
          requiredChecks: [],
        },
        autopilot: { mode: 'notify-only' },
      })}\n`,
    );
    const sessionResult = await createChatSession(
      {
        kind: 'watch',
        linkedRepoId: 'sample',
        linkedWatchId: 'example/sample#42',
        activate: false,
      },
      paths,
    );
    if (!sessionResult.ok || !('session' in sessionResult)) {
      throw new Error(sessionResult.message);
    }
    const eventState = fakeEventState(sha);
    const contextDependencies = {
      token: 'test',
      fetchPullRequestEventState: async () => eventState,
    };
    const context = await resolveInteractiveRepoContext(
      { sessionId: sessionResult.session.id },
      paths,
      contextDependencies,
    );
    const edit = await replaceRepoFile(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        path: 'src/app.ts',
        oldString: 'value = 1',
        newString: 'value = 2',
        sessionId: sessionResult.session.id,
      },
      paths,
    );
    const commit = await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'fix: update value',
        sessionId: sessionResult.session.id,
      },
      paths,
    );
    const push = await pushInteractiveRepo(
      { sessionId: sessionResult.session.id },
      paths,
      {
        contextDependencies,
        pushGit: async (cwd, input) => {
          expect(input).toMatchObject({ branch: 'feature' });
          expect(input.force).toBeUndefined();
          const { stdout } = await execFileAsync(
            'git',
            ['push', remote, 'HEAD:refs/heads/feature'],
            { cwd },
          );
          return {
            remote,
            branch: input.branch,
            force: false,
            stdout,
          };
        },
      },
    );
    const comment = await postGitHubPrComment(
      {
        ref: 'example/sample#42',
        body: 'Fixed and pushed the requested change.',
      },
      paths,
      {
        token: 'test',
        fetchPullRequestEventState: async () => eventState,
        postPullRequestComment: async ({ body }) => ({
          id: 1,
          nodeId: 'comment-1',
          url: 'https://github.com/example/sample/pull/42#issuecomment-1',
          authorLogin: 'neon',
          body,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      },
    );
    const approvals = await listExecutionApprovals(paths, {
      includeResolved: true,
    });
    const { stdout: pushedSha } = await execFileAsync(
      'git',
      ['rev-parse', 'refs/heads/feature'],
      { cwd: remote },
    );

    expect(edit).toMatchObject({ ok: true, changed: true });
    expect(commit).toMatchObject({ ok: true, changed: true });
    expect(push).toMatchObject({ ok: true, changed: true });
    expect(comment).toMatchObject({ ok: true, changed: true });
    expect(approvals.approvals).toHaveLength(0);
    expect(pushedSha.trim()).not.toBe(sha);
    expect(
      await execFileAsync('git', ['status', '--porcelain'], { cwd: repo }),
    ).toMatchObject({ stdout: '' });
  });

  it('prompts once for an expansion and audits the acknowledged push', async () => {
    const { paths, sha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        guardrails: {
          deniedFileGlobs: [],
          approvalRequiredFileGlobs: [],
          highRiskClasses: ['ci-config'],
          maxFilesChanged: 50,
          maxLinesChanged: 1_500,
          allowForcePush: false,
          allowedPushDestinations: ['pull-request-head'],
          requiredChecks: [],
        },
        autopilot: { mode: 'notify-only' },
      })}\n`,
    );
    const session = await linkedSession(paths);
    const eventState = fakeEventState(sha);
    const contextDependencies = {
      token: 'test',
      fetchPullRequestEventState: async () => eventState,
    };
    const context = await resolveInteractiveRepoContext(
      { sessionId: session.id },
      paths,
      contextDependencies,
    );
    await mkdir(join(context!.worktree.localPath, '.github'), {
      recursive: true,
    });
    await writeFile(
      join(context!.worktree.localPath, '.github/ci.yml'),
      'name: CI\n',
    );
    await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'ci: add workflow',
        sessionId: session.id,
      },
      paths,
    );
    let pushCount = 0;
    const dependencies = {
      contextDependencies,
      pushGit: async (
        _cwd: string,
        input: { remote: string; branch: string; force?: boolean },
      ) => {
        pushCount += 1;
        return { ...input, force: false, stdout: '' };
      },
    };
    const needsConfirmation = await pushInteractiveRepo(
      { sessionId: session.id },
      paths,
      dependencies,
    );
    const confirmationToken =
      'confirmationToken' in needsConfirmation &&
      typeof needsConfirmation.confirmationToken === 'string'
        ? needsConfirmation.confirmationToken
        : undefined;
    const pushed = await pushInteractiveRepo(
      {
        sessionId: session.id,
        acknowledgeExpansion: true,
        confirmationToken,
      },
      paths,
      dependencies,
    );
    await replaceRepoFile(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        path: 'src/app.ts',
        oldString: 'value = 1',
        newString: 'value = 2',
      },
      paths,
    );
    await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'fix: safe follow-up',
        sessionId: session.id,
      },
      paths,
    );
    const secondPush = await pushInteractiveRepo(
      { sessionId: session.id },
      paths,
      dependencies,
    );
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    const auditCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM chat_session_audit WHERE action = 'repo_push_expansion_ack';",
      )
      .get() as { count: number };
    database.close();

    expect(needsConfirmation).toMatchObject({
      ok: false,
      requires: ['confirmPush'],
    });
    expect(needsConfirmation).toHaveProperty('effect');
    expect(needsConfirmation).toHaveProperty('confirmationToken');
    expect(pushed).toMatchObject({ ok: true });
    expect(secondPush).toMatchObject({ ok: true });
    expect(pushCount).toBe(2);
    expect(auditCount.count).toBe(1);
  });

  it('enforces hard path denies for both commit and push', async () => {
    const { paths, sha } = await fixture();
    const session = await linkedSession(paths);
    const eventState = fakeEventState(sha);
    const contextDependencies = {
      token: 'test',
      fetchPullRequestEventState: async () => eventState,
    };
    const context = await resolveInteractiveRepoContext(
      { sessionId: session.id },
      paths,
      contextDependencies,
    );
    await writeFile(
      join(context!.worktree.localPath, 'safe-key.txt'),
      'private fixture\n',
    );
    await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'test: add rename source',
        sessionId: session.id,
      },
      paths,
    );
    await mkdir(join(context!.worktree.localPath, '.ssh'), { recursive: true });
    await execFileAsync('git', ['mv', 'safe-key.txt', '.ssh/id_rsa'], {
      cwd: context!.worktree.localPath,
    });

    const blockedSelectedCommit = await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'bad: smuggle staged private key',
        paths: ['src/app.ts'],
        sessionId: session.id,
      },
      paths,
    );
    const blockedCommit = await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'bad: add private key',
        sessionId: session.id,
      },
      paths,
    );
    await execFileAsync('git', ['add', '-A'], {
      cwd: context!.worktree.localPath,
    });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'fixture bypass',
      ],
      { cwd: context!.worktree.localPath },
    );
    const blockedPush = await pushInteractiveRepo(
      { sessionId: session.id },
      paths,
      {
        contextDependencies,
        pushGit: async () => {
          throw new Error('push must not be called');
        },
      },
    );

    expect(blockedSelectedCommit).toMatchObject({ ok: false });
    expect(blockedCommit).toMatchObject({ ok: false });
    expect(blockedCommit.message).toContain('workspace policy');
    expect(blockedPush).toMatchObject({
      ok: false,
      requires: ['guardrail'],
    });
  });

  it('commits exactly selected paths and leaves unrelated safe staging intact', async () => {
    const { paths, sha } = await fixture();
    const session = await linkedSession(paths);
    const context = await resolveInteractiveRepoContext(
      { sessionId: session.id },
      paths,
      {
        token: 'test',
        fetchPullRequestEventState: async () => fakeEventState(sha),
      },
    );
    await writeFile(join(context!.worktree.localPath, 'notes.txt'), 'staged\n');
    await execFileAsync('git', ['add', 'notes.txt'], {
      cwd: context!.worktree.localPath,
    });
    await replaceRepoFile(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        path: 'src/app.ts',
        oldString: 'value = 1',
        newString: 'value = 5',
      },
      paths,
    );

    const commit = await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'fix: selected path only',
        paths: ['src/app.ts'],
        sessionId: session.id,
      },
      paths,
    );
    const committed = await execFileAsync(
      'git',
      ['show', '--format=', '--name-only', 'HEAD'],
      { cwd: context!.worktree.localPath },
    );
    const staged = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only'],
      { cwd: context!.worktree.localPath },
    );

    expect(commit).toMatchObject({ ok: true, changed: true });
    expect(committed.stdout.trim()).toBe('src/app.ts');
    expect(staged.stdout.trim()).toBe('notes.txt');
  });

  it('allows commits that delete an entire safe directory', async () => {
    const { paths, sha } = await fixture();
    const session = await linkedSession(paths);
    const context = await resolveInteractiveRepoContext(
      { sessionId: session.id },
      paths,
      {
        token: 'test',
        fetchPullRequestEventState: async () => fakeEventState(sha),
      },
    );
    await mkdir(join(context!.worktree.localPath, 'nested'), {
      recursive: true,
    });
    await writeFile(
      join(context!.worktree.localPath, 'nested/file.ts'),
      'export const nested = true;\n',
    );
    await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'test: add nested directory',
        sessionId: session.id,
      },
      paths,
    );
    await rm(join(context!.worktree.localPath, 'nested'), {
      recursive: true,
      force: true,
    });

    const deletion = await commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'test: remove nested directory',
        sessionId: session.id,
      },
      paths,
    );

    expect(deletion).toMatchObject({ ok: true, changed: true });
  });

  it('preempts an autopilot-owned PR lock within the first interactive call', async () => {
    const { paths, sha } = await fixture();
    const session = await linkedSession(paths);
    const eventState = fakeEventState(sha);
    const context = await resolveInteractiveRepoContext(
      { sessionId: session.id },
      paths,
      {
        token: 'test',
        fetchPullRequestEventState: async () => eventState,
      },
    );
    await replaceRepoFile(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        path: 'src/app.ts',
        oldString: 'value = 1',
        newString: 'value = 3',
      },
      paths,
    );
    const autonomousLock = await runWithFlueExecutionContextForTests(
      { runId: 'run-autopilot' },
      () =>
        lockWorktree(
          {
            worktreeId: context!.worktree.id,
            scope: 'pr',
            owner: 'autopilot-fix',
          },
          paths,
        ),
    );
    const preemptionPromise = commitInteractiveRepo(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        message: 'fix: interactive preemption',
        sessionId: session.id,
      },
      paths,
    );
    if (!autonomousLock.ok || !('lock' in autonomousLock)) {
      throw new Error('Expected autonomous lock.');
    }
    let revokedLock = await readWorktreeLock(autonomousLock.lock.id, paths);
    for (
      let attempt = 0;
      !revokedLock.revokedAt && attempt < 100;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      revokedLock = await readWorktreeLock(autonomousLock.lock.id, paths);
    }
    const staleMutation = await replaceRepoFile(
      {
        repoId: 'sample',
        worktreeId: context!.worktree.id,
        worktreeLockId: autonomousLock.lock.id,
        path: 'src/app.ts',
        oldString: 'value = 3',
        newString: 'value = 4',
      },
      paths,
    );
    await releaseWorktreeLock(
      {
        lockId: autonomousLock.lock.id,
        owner: 'autopilot-fix',
        finalStatus: 'prepared-diff',
      },
      paths,
    );
    const preemption = await preemptionPromise;
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    const recovery = database
      .prepare(
        "SELECT message FROM worktree_events WHERE worktree_id = ? AND message LIKE 'Interactive session preempted autopilot run %' LIMIT 1;",
      )
      .get(context!.worktree.id) as { message: string } | undefined;
    const activeLocks = database
      .prepare(
        'SELECT COUNT(*) AS count FROM worktree_locks WHERE worktree_id = ? AND released_at IS NULL;',
      )
      .get(context!.worktree.id) as { count: number };
    database.close();

    expect(autonomousLock).toMatchObject({ ok: true });
    expect(autonomousLock).toMatchObject({
      lock: { workflowRunId: 'run-autopilot' },
    });
    expect(revokedLock.revokedAt).not.toBeNull();
    expect(staleMutation).toMatchObject({
      ok: false,
      error: { code: 'WORKTREE_LOCKED' },
    });
    expect(preemption).toMatchObject({ ok: true, changed: true });
    expect(recovery?.message).toContain('run-autopilot');
    expect(activeLocks.count).toBe(0);
  });
});

async function linkedSession(paths: RuntimePaths) {
  const result = await createChatSession(
    {
      kind: 'watch',
      linkedRepoId: 'sample',
      linkedWatchId: 'example/sample#42',
      activate: false,
    },
    paths,
  );
  if (!result.ok || !('session' in result)) throw new Error(result.message);
  return result.session;
}

async function fixture(): Promise<{
  paths: RuntimePaths;
  repo: string;
  sha: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-authority-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-authority-repo-'));
  tempRoots.push(home, repo);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['add', '-A'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'init',
    ],
    { cwd: repo },
  );
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
  });
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  await writeFile(
    paths.repos,
    `${JSON.stringify({
      repos: [
        {
          id: 'sample',
          github: { owner: 'example', name: 'sample' },
          path: repo,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
  return { paths, repo, sha: stdout.trim() };
}

function fakeEventState(sha: string): GitHubPullRequestEventState {
  return {
    repo: 'example/sample',
    number: 42,
    url: 'https://github.com/example/sample/pull/42',
    title: 'Fixture',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: sha,
    headRef: 'feature',
    baseRef: 'main',
    baseSha: sha,
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [],
    requestedChangesState: { active: [], latestByReviewer: [], history: [] },
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'example/sample',
      baseRepoFullName: 'example/sample',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: new Date().toISOString(),
    },
    isOutOfDate: false,
    fetchedAt: new Date().toISOString(),
  };
}
