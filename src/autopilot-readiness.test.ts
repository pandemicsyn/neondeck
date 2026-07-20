import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probeGitPushAccess,
  runUnattendedGit,
  unattendedGitEnv,
} from './lib/git';
import { readAutopilotReadiness } from './modules/runtime/autopilot-readiness';
import type { GitHubPullRequestEventState } from './modules/github';
import { runDevDoctor } from './modules/runtime/doctor';
import { readRuntimeStatus } from './modules/runtime/status';
import {
  resolvePrPushTarget,
  resolvePrPushTargetForCheckout,
} from './modules/worktrees';
import { fetchExactPullRequestHead } from './modules/worktrees/pr-head';
import { gitPushHead } from './repo-edit/git';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { parseAutopilotModeFlag } from './cli/options';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('unattended Git', () => {
  it('composes caller SSH configuration with terminal, GCM, and BatchMode guards', () => {
    expect(
      unattendedGitEnv({
        GIT_SSH_COMMAND: 'wrapper --profile deploy',
        GIT_TERMINAL_PROMPT: '1',
        GCM_INTERACTIVE: 'Always',
      }),
    ).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND:
        'wrapper --profile deploy -oBatchMode=yes -oConnectTimeout=15',
    });
    expect(unattendedGitEnv({ GIT_SSH: '/tmp/my ssh' }).GIT_SSH_COMMAND).toBe(
      "'/tmp/my ssh' -oBatchMode=yes -oConnectTimeout=15",
    );
  });

  it('proves a helper credential without returning its secret', async () => {
    const root = await tempDir('neondeck-git-helper-');
    const repo = join(root, 'repo');
    const helper = join(root, 'helper.sh');
    await mkdir(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    await executable(
      helper,
      '#!/bin/sh\nprintf "username=automation\\npassword=super-secret-token\\n"\n',
    );
    await execFileAsync('git', ['config', 'credential.helper', helper], {
      cwd: repo,
    });
    const validateHttpsCredential = vi.fn<
      (input: {
        remote: URL;
        username: string;
        password: string;
        timeoutMs: number;
        signal?: AbortSignal;
      }) => Promise<{ login: string; repositoryPush: true }>
    >(async (input) => {
      expect(input.username).toBe('automation');
      expect(input.password === 'super-secret-token').toBe(true);
      return { login: 'automation', repositoryPush: true as const };
    });
    const sha = 'a'.repeat(40);

    const result = await probeGitPushAccess(
      repo,
      {
        remote: 'https://github.com/example/project.git',
        ref: 'refs/heads/feature',
      },
      {
        env: isolatedGitEnv(root),
        validateHttpsCredential,
        runGit: async (_cwd, args) => {
          expect(args).toEqual([
            'ls-remote',
            '--refs',
            '--',
            'https://github.com/example/project.git',
            'refs/heads/feature',
          ]);
          return `${sha}\trefs/heads/feature\n`;
        },
      },
    );

    expect(result).toMatchObject({
      credential: {
        protocol: 'https',
        login: 'automation',
        repositoryPush: true,
      },
      remote: { sha, reachable: true },
    });
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('aborts the sibling credential-validation request when one lookup fails', async () => {
    const root = await tempDir('neondeck-git-validation-abort-');
    const repo = join(root, 'repo');
    const helper = join(root, 'helper.sh');
    await mkdir(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    await executable(
      helper,
      '#!/bin/sh\nprintf "username=automation\\npassword=fixture-password\\n"\n',
    );
    await execFileAsync('git', ['config', 'credential.helper', helper], {
      cwd: repo,
    });
    let siblingSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/repos/')) {
          return Promise.reject(new Error('repository lookup failed'));
        }
        siblingSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          siblingSignal?.addEventListener(
            'abort',
            () => reject(new Error('sibling aborted')),
            { once: true },
          );
        });
      }),
    );

    await expect(
      probeGitPushAccess(
        repo,
        {
          remote: 'https://github.com/example/project.git',
          ref: 'refs/heads/feature',
        },
        {
          env: isolatedGitEnv(root),
          runGit: async () => '',
        },
      ),
    ).rejects.toThrow('repository lookup failed');
    expect(siblingSignal?.aborted).toBe(true);
  });

  it('terminates a stubborn credential helper process', async () => {
    const root = await tempDir('neondeck-git-helper-hang-');
    const repo = join(root, 'repo');
    const helper = join(root, 'helper.sh');
    const pidFile = join(root, 'helper.pid');
    await mkdir(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    await executable(
      helper,
      `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\ntrap '' TERM\nwhile :; do sleep 1; done\n`,
    );
    await execFileAsync('git', ['config', 'credential.helper', helper], {
      cwd: repo,
    });

    await expect(
      probeGitPushAccess(
        repo,
        {
          remote: 'https://github.com/example/project.git',
          ref: 'refs/heads/feature',
        },
        {
          timeoutMs: 2_000,
          env: isolatedGitEnv(root),
          runGit: async () => '',
          validateHttpsCredential: async () => ({
            login: 'unused',
            repositoryPush: true,
          }),
        },
      ),
    ).rejects.toMatchObject({ timedOut: true, cause: undefined });
    const pid = Number(await readFile(pidFile, 'utf8'));
    await expectProcessExited(pid);
  });

  it('terminates a stubborn askpass process and reports no credential secret', async () => {
    const root = await tempDir('neondeck-git-askpass-hang-');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const askpass = join(root, 'askpass.sh');
    const pidFile = join(root, 'askpass.pid');
    await mkdir(repo);
    await mkdir(bin);
    await executable(
      join(bin, 'git'),
      `#!/bin/sh\nexec '${askpass}' "Username for target"\n`,
    );
    await executable(
      askpass,
      `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\ntrap '' TERM\nwhile :; do sleep 1; done\n`,
    );
    const started = Date.now();

    await expect(
      probeGitPushAccess(
        repo,
        {
          remote: 'https://github.com/example/project.git',
          ref: 'refs/heads/feature',
        },
        {
          timeoutMs: 2_000,
          gitExecutable: join(bin, 'git'),
          env: {
            ...isolatedGitEnv(root),
            GIT_ASKPASS: askpass,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
          },
          runGit: async () => '',
          validateHttpsCredential: async () => ({
            login: 'unused',
            repositoryPush: true,
          }),
        },
      ),
    ).rejects.toMatchObject({ timedOut: true, cause: undefined });
    expect(Date.now() - started).toBeLessThan(4_000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await expectProcessExited(pid);
  });

  it('hard-bounds captured output while terminating a noisy process group', async () => {
    const root = await tempDir('neondeck-git-output-bound-');
    const git = join(root, 'git');
    await executable(
      git,
      "#!/bin/sh\ntrap '' TERM\nwhile :; do printf '0123456789abcdef0123456789abcdef'; done\n",
    );
    let thrown: unknown;
    try {
      await runUnattendedGit(root, ['status'], {
        gitExecutable: git,
        maxBuffer: 1_024,
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ signal: 'SIGTERM' });
    const stdout = (thrown as { stdout?: string }).stdout ?? '';
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(1_024);
    expect(recursiveErrorText(thrown)).toContain('output limit');
  });

  it('recursively redacts credential-protocol output and error causes', async () => {
    const root = await tempDir('neondeck-git-redaction-');
    const bin = join(root, 'bin');
    await mkdir(bin);
    await executable(
      join(bin, 'git'),
      '#!/bin/sh\nprintf "username=automation\\npassword=leaked-token\\n"\nprintf "oauth_token=leaked-token\\nhttps://automation:leaked-token@example.test/repo.git\\n" >&2\nexit 1\n', // trufflehog:ignore -- intentional fake credential URI exercises redaction
    );
    let thrown: unknown;
    try {
      await runUnattendedGit(root, ['credential', 'fill'], {
        gitExecutable: join(bin, 'git'),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(recursiveErrorText(thrown)).toContain('[redacted]');
    expect(recursiveErrorText(thrown)).not.toContain('leaked-token');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();

    let aborted: unknown;
    try {
      await runUnattendedGit(
        root,
        [
          'ls-remote',
          '?oauth_token=query-secret',
          'authorization: bearer abort-secret',
        ],
        { signal: AbortSignal.abort() },
      );
    } catch (error) {
      aborted = error;
    }
    const abortedText = recursiveErrorText(aborted);
    expect(abortedText).toContain('[redacted]');
    expect(abortedText).not.toContain('abort-secret');
    expect(abortedText).not.toContain('query-secret');
  });

  it('rejects embedded remote credentials, queries, and fragments before lookup', async () => {
    const runGit = vi.fn<(cwd: string, args: string[]) => Promise<string>>(
      async () => '',
    );
    const validateHttpsCredential = vi.fn<
      (input: {
        remote: URL;
        username: string;
        password: string;
        timeoutMs: number;
        signal?: AbortSignal;
      }) => Promise<{ login: string; repositoryPush: true }>
    >(async () => ({ login: 'automation', repositoryPush: true }));
    for (const remote of [
      'https://automation:secret@github.com/example/project.git',
      'https://github.com/example/project.git?token=secret',
      'https://github.com/example/project.git#secret',
    ]) {
      await expect(
        probeGitPushAccess(
          process.cwd(),
          { remote, ref: 'refs/heads/feature' },
          { runGit, validateHttpsCredential },
        ),
      ).rejects.toThrow(/credentials|query or fragment/);
    }
    expect(runGit).not.toHaveBeenCalled();
    expect(validateHttpsCredential).not.toHaveBeenCalled();
  });

  it('terminates fetch and push options before remote-controlled arguments', async () => {
    const sha = 'a'.repeat(40);
    const fetchCalls: string[][] = [];
    await fetchExactPullRequestHead(
      {
        sourceRepoPath: process.cwd(),
        baseRepoFullName: 'example/sample',
        headRepoFullName: 'example/sample',
        prNumber: 7,
        headRef: 'feature',
        headSha: sha,
      },
      {
        runGit: async (_cwd, args) => {
          fetchCalls.push(args);
          if (args[0] === 'remote' && args.length === 1) return 'origin\n';
          if (args[0] === 'remote') {
            return 'https://github.com/example/sample.git\n';
          }
          if (args[0] === 'rev-parse') return `${sha}\n`;
          return '';
        },
      },
    );
    expect(fetchCalls).toContainEqual([
      'fetch',
      '--no-tags',
      '--force',
      '--',
      'origin',
      'refs/pull/7/head:refs/neondeck/autopilot/pr-7',
    ]);

    const pushCalls: string[][] = [];
    await gitPushHead(
      process.cwd(),
      { remote: 'origin', branch: 'feature', sha },
      {
        runGit: async (_cwd, args) => {
          pushCalls.push(args);
          return '';
        },
        probePushAccess: async (_cwd, input) => ({
          credential: {
            protocol: 'local',
            provided: true,
            source: 'local-transport',
            login: null,
            repositoryPush: null,
          },
          remote: {
            remote: input.remote,
            ref: input.ref,
            sha,
            reachable: true,
          },
        }),
      },
    );
    expect(pushCalls).toEqual([
      ['push', '--', 'origin', `${sha}:refs/heads/feature`],
    ]);
  });

  it('prevents the push side effect when Git and API actors differ or cannot be bound', async () => {
    const sha = 'a'.repeat(40);
    for (const credential of [
      {
        protocol: 'https' as const,
        provided: true as const,
        source: 'credential-helper-or-askpass' as const,
        login: 'different-actor',
        repositoryPush: true,
      },
      {
        protocol: 'ssh' as const,
        provided: true as const,
        source: 'ssh-authenticated-remote' as const,
        login: null,
        repositoryPush: null,
      },
    ]) {
      const runGit = vi.fn<(cwd: string, args: string[]) => Promise<string>>(
        async () => '',
      );
      await expect(
        gitPushHead(
          process.cwd(),
          {
            remote: 'origin',
            branch: 'feature',
            sha,
            expectedAccess: {
              apiLogin: 'automation',
              requireBoundIdentity: true,
            },
          },
          {
            runGit,
            probePushAccess: async (_cwd, input) => ({
              credential,
              remote: {
                remote: input.remote,
                ref: input.ref,
                sha,
                reachable: true,
              },
            }),
          },
        ),
      ).rejects.toThrow(/blocked|warning/);
      expect(runGit).not.toHaveBeenCalled();
    }
  });

  it('prevents the push side effect when the target branch moved or disappeared', async () => {
    const sha = 'a'.repeat(40);
    for (const remoteSha of ['b'.repeat(40), null]) {
      const runGit = vi.fn<(cwd: string, args: string[]) => Promise<string>>(
        async () => '',
      );
      await expect(
        gitPushHead(
          process.cwd(),
          {
            remote: 'origin',
            branch: 'feature',
            sha: 'c'.repeat(40),
            expectedRemoteSha: sha,
          },
          {
            runGit,
            probePushAccess: async (_cwd, input) => ({
              credential: {
                protocol: 'local',
                provided: true,
                source: 'local-transport',
                login: null,
                repositoryPush: null,
              },
              remote: {
                remote: input.remote,
                ref: input.ref,
                sha: remoteSha,
                reachable: true,
              },
            }),
          },
        ),
      ).rejects.toThrow(/moved|no longer has/);
      expect(runGit).not.toHaveBeenCalled();
    }
  });
});

describe('Autopilot readiness facts', () => {
  it('surfaces central readiness through runtime status, doctor, and CLI mode parsing', async () => {
    const { paths } = await readinessFixture();
    const [status, doctor] = await Promise.all([
      readRuntimeStatus(paths, {}),
      runDevDoctor(paths, { repoId: 'sample', mode: 'prepare-only' }),
    ]);

    expect(status.autopilot).toMatchObject({
      repoId: 'sample',
      action: 'autopilot_readiness_read',
    });
    expect(status.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'autopilot-local-readiness' }),
      ]),
    );
    expect(doctor.autopilot).toMatchObject({
      repoId: 'sample',
      mode: 'prepare-only',
    });
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'autopilot-readiness' }),
      ]),
    );
    expect(parseAutopilotModeFlag('autofix-push-when-safe')).toBe(
      'autofix-push-when-safe',
    );
    expect(() => parseAutopilotModeFlag('unsafe')).toThrow('--mode');
  });

  it('keeps API, exact fetch, Git credential, comment, identity, checks, and gh facts separate', async () => {
    const { paths, repo } = await readinessFixture();
    const sha = 'a'.repeat(40);
    const readiness = await readAutopilotReadiness(
      {
        repoId: 'sample',
        prNumber: 7,
        mode: 'autofix-push-when-safe',
      },
      paths,
      {
        env: { GITHUB_TOKEN: 'api-token' },
        fetchGitHub: async (_token, url) =>
          url.endsWith('/user')
            ? new Response(JSON.stringify({ login: 'automation' }))
            : new Response(
                JSON.stringify({
                  private: false,
                  permissions: { push: true },
                }),
                { headers: { 'x-oauth-scopes': 'repo' } },
              ),
        fetchEventState: async () => eventState(),
        probeExactHead: async () => ({
          baseRemote: 'origin',
          fetchSource: 'origin',
          fetchRef: 'refs/pull/7/head',
          temporaryRef: 'refs/neondeck/autopilot/pr-7',
          fork: false,
          resolvedSha: sha,
        }),
        probePushAccess: async (_cwd, input) => ({
          credential: {
            protocol: 'https',
            provided: true,
            source: 'credential-helper-or-askpass',
            login: 'automation',
            repositoryPush: true,
          },
          remote: {
            remote: input.remote,
            ref: input.ref,
            sha,
            reachable: true,
          },
        }),
        runCommand: async (file, args) => ({
          stdout:
            file === 'gh' && args[0] === '--version' ? 'gh version 2.0\n' : '',
          stderr: '',
        }),
      },
    );

    expect(repo).toBeTruthy();
    expect(readiness.ready).toBe(true);
    expect(readiness.blocking).toEqual([]);
    expect(readiness.warnings).toEqual([]);
    expect(readiness.pushTarget).toMatchObject({
      repoFullName: 'example/sample',
      branch: 'feature',
      fork: false,
    });
    expect(readiness.facts).toMatchObject({
      api: { status: 'ready' },
      fetch: { status: 'ready' },
      'git-push': { status: 'ready' },
      comment: { status: 'ready' },
      identity: { status: 'ready' },
      'check-commands': { status: 'ready' },
      gh: { status: 'ready' },
    });
  });

  it('does not claim API permission readiness when branch facts are unknown', async () => {
    const { paths } = await readinessFixture();
    const readiness = await readAutopilotReadiness(
      { repoId: 'sample', prNumber: 7, mode: 'prepare-only' },
      paths,
      {
        env: { GITHUB_TOKEN: 'api-token' },
        fetchGitHub: async (_token, url) =>
          new Response(
            JSON.stringify(
              url.endsWith('/user')
                ? { login: 'automation' }
                : { private: false, permissions: { push: true } },
            ),
          ),
        fetchEventState: async () =>
          eventState({
            branchPermissions: {
              ...eventState().branchPermissions,
              headRepoPush: null,
            },
          }),
        probeExactHead: async () => ({
          baseRemote: 'origin',
          fetchSource: 'origin',
          fetchRef: 'refs/pull/7/head',
          temporaryRef: 'refs/neondeck/autopilot/pr-7',
          fork: false,
          resolvedSha: 'a'.repeat(40),
        }),
        runCommand: async () => ({ stdout: '', stderr: '' }),
      },
    );

    expect(readiness.facts.api).toMatchObject({ status: 'blocked' });
    expect(readiness.facts.api.message).toContain('permission facts');
  });

  it('blocks mismatched Git/API actors and warns for an unbound SSH actor', async () => {
    const { paths } = await readinessFixture();
    for (const [credential, expectedStatus] of [
      [
        {
          protocol: 'https' as const,
          provided: true as const,
          source: 'credential-helper-or-askpass' as const,
          login: 'different-actor',
          repositoryPush: true,
        },
        'blocked',
      ],
      [
        {
          protocol: 'ssh' as const,
          provided: true as const,
          source: 'ssh-authenticated-remote' as const,
          login: null,
          repositoryPush: null,
        },
        'warning',
      ],
    ] as const) {
      const readiness = await readAutopilotReadiness(
        {
          repoId: 'sample',
          prNumber: 7,
          mode: 'autofix-push-when-safe',
        },
        paths,
        {
          env: { GITHUB_TOKEN: 'api-token' },
          fetchGitHub: async (_token, url) =>
            new Response(
              JSON.stringify(
                url.endsWith('/user')
                  ? { login: 'automation' }
                  : {
                      private: false,
                      permissions: { push: true },
                    },
              ),
              { headers: { 'x-oauth-scopes': 'repo' } },
            ),
          fetchEventState: async () => eventState(),
          probeExactHead: async () => ({
            baseRemote: 'origin',
            fetchSource: 'origin',
            fetchRef: 'refs/pull/7/head',
            temporaryRef: 'refs/neondeck/autopilot/pr-7',
            fork: false,
            resolvedSha: 'a'.repeat(40),
          }),
          probePushAccess: async (_cwd, input) => ({
            credential,
            remote: {
              remote: input.remote,
              ref: input.ref,
              sha: 'a'.repeat(40),
              reachable: true,
            },
          }),
          runCommand: async () => ({ stdout: '', stderr: '' }),
        },
      );

      expect(readiness.ready).toBe(false);
      expect(readiness.facts['git-push'].status).toBe(expectedStatus);
    }
  });

  it('blocks push readiness when the expected PR branch is absent', async () => {
    const { paths } = await readinessFixture();
    const readiness = await readAutopilotReadiness(
      {
        repoId: 'sample',
        prNumber: 7,
        mode: 'autofix-push-when-safe',
      },
      paths,
      {
        env: { GITHUB_TOKEN: 'api-token' },
        fetchGitHub: async (_token, url) =>
          new Response(
            JSON.stringify(
              url.endsWith('/user')
                ? { login: 'automation' }
                : { private: false, permissions: { push: true } },
            ),
            { headers: { 'x-oauth-scopes': 'repo' } },
          ),
        fetchEventState: async () => eventState(),
        probeExactHead: async () => ({
          baseRemote: 'origin',
          fetchSource: 'origin',
          fetchRef: 'refs/pull/7/head',
          temporaryRef: 'refs/neondeck/autopilot/pr-7',
          fork: false,
          resolvedSha: 'a'.repeat(40),
        }),
        probePushAccess: async (_cwd, input) => ({
          credential: {
            protocol: 'https',
            provided: true,
            source: 'credential-helper-or-askpass',
            login: 'automation',
            repositoryPush: true,
          },
          remote: {
            remote: input.remote,
            ref: input.ref,
            sha: null,
            reachable: true,
          },
        }),
        runCommand: async () => ({ stdout: '', stderr: '' }),
      },
    );

    expect(readiness.facts['git-push']).toMatchObject({ status: 'blocked' });
    expect(readiness.facts['git-push'].message).toContain('was not found');
  });

  it('requires complete unattended author and committer identities', async () => {
    const { paths, repo } = await readinessFixture();
    await execFileAsync('git', ['config', '--unset-all', 'user.name'], {
      cwd: repo,
    });
    await execFileAsync('git', ['config', '--unset-all', 'user.email'], {
      cwd: repo,
    });
    const readiness = await readAutopilotReadiness(
      { repoId: 'sample', mode: 'autofix-with-approval' },
      paths,
      {
        remoteChecks: false,
        env: {
          GIT_AUTHOR_NAME: 'Patch Author',
          GIT_AUTHOR_EMAIL: 'author@example.test',
        },
      },
    );

    expect(readiness.facts.identity).toMatchObject({
      status: 'blocked',
      required: true,
    });
    expect(readiness.facts.identity.message).toContain('committer name');
    expect(readiness.facts.identity.message).toContain('committer email');
  });

  it('validates same-repository and fork push targets without falling back to base', () => {
    expect(
      resolvePrPushTarget({
        baseRepoFullName: 'example/sample',
        headRepoFullName: 'example/sample',
        headRef: 'feature',
        branchPermissions: eventState().branchPermissions,
      }),
    ).toMatchObject({ repoFullName: 'example/sample', fork: false });
    expect(
      resolvePrPushTarget({
        baseRepoFullName: 'example/sample',
        headRepoFullName: 'contributor/sample',
        headRef: 'feature',
        branchPermissions: {
          ...eventState().branchPermissions,
          headRepoFullName: 'contributor/sample',
          isFork: true,
        },
      }),
    ).toMatchObject({
      repoFullName: 'contributor/sample',
      remote: 'https://github.com/contributor/sample.git',
      fork: true,
    });
  });

  it('preserves the registered SSH transport for same-repo and fork push targets', async () => {
    const runGit = async (_cwd: string, args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) return 'upstream\n';
      return 'git@github.com:example/sample.git\n';
    };
    await expect(
      resolvePrPushTargetForCheckout(
        {
          sourceRepoPath: process.cwd(),
          baseRepoFullName: 'example/sample',
          headRepoFullName: 'example/sample',
          headRef: 'feature',
          branchPermissions: eventState().branchPermissions,
        },
        { runGit },
      ),
    ).resolves.toMatchObject({
      remote: 'git@github.com:example/sample.git',
      fork: false,
    });
    await expect(
      resolvePrPushTargetForCheckout(
        {
          sourceRepoPath: process.cwd(),
          baseRepoFullName: 'example/sample',
          headRepoFullName: 'contributor/sample',
          headRef: 'feature',
          branchPermissions: {
            ...eventState().branchPermissions,
            headRepoFullName: 'contributor/sample',
            isFork: true,
          },
        },
        { runGit },
      ),
    ).resolves.toMatchObject({
      remote: 'git@github.com:contributor/sample.git',
      fork: true,
    });
  });
});

async function readinessFixture() {
  const home = await tempDir('neondeck-readiness-');
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const repo = join(home, 'repo');
  await mkdir(repo);
  await execFileAsync('git', ['init'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Automation'], {
    cwd: repo,
  });
  await execFileAsync('git', ['config', 'user.email', 'bot@example.test'], {
    cwd: repo,
  });
  await execFileAsync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/example/sample.git'],
    { cwd: repo },
  );
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: [
        {
          id: 'sample',
          github: { owner: 'example', name: 'sample' },
          path: repo,
          defaultBranch: 'main',
        },
      ],
    }),
  );
  await writeFile(
    paths.config,
    JSON.stringify({
      version: 1,
      guardrails: { requiredChecks: ['npm test'] },
      execution: {
        defaultBackend: 'local',
        enabledBackends: ['local'],
        unattended: 'allow-preapproved',
        preapprovedCommands: [
          {
            id: 'tests',
            command: 'npm test',
            match: 'exact',
            backends: ['local'],
          },
        ],
      },
    }),
  );
  return { home, paths, repo };
}

function eventState(
  overrides: Partial<GitHubPullRequestEventState> = {},
): GitHubPullRequestEventState {
  return {
    repo: 'example/sample',
    number: 7,
    url: 'https://github.com/example/sample/pull/7',
    title: 'Feature',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    headRepoFullName: 'example/sample',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    baseRepoFullName: 'example/sample',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [],
    requestedChangesState: { active: [], latestByReviewer: [], history: [] },
    conversationComments: [],
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
      checkedAt: '2026-07-19T00:00:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

async function tempDir(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function executable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

function recursiveErrorText(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined || seen.has(value)) return '';
  if (typeof value !== 'object') return String(value);
  seen.add(value);
  const record = value as Record<string, unknown>;
  return ['message', 'stdout', 'stderr', 'cause']
    .map((key) => recursiveErrorText(record[key], seen))
    .join('\n');
}

function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

async function expectProcessExited(pid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Process ${pid} was not reaped after the Git timeout.`);
}
