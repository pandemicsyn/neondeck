import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkExecutionPolicy, readExecutionPolicy } from './modules/execution';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('execution policy', () => {
  it('defaults to local execution with manual approvals and read-only preapprovals', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);

    await expect(readExecutionPolicy(paths)).resolves.toMatchObject({
      ok: true,
      defaultBackend: 'local',
      enabledBackends: ['local'],
      supportedBackends: ['local', 'exe.dev'],
      approvalMode: 'manual',
      unattended: 'deny',
      defaults: {
        localAccess: true,
        exeDevPlanned: true,
        hardlineBypassable: false,
      },
    });

    await expect(
      checkExecutionPolicy(
        { command: 'git status --short', context: 'unattended' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      decision: 'allow',
      risk: 'read-only',
      matchedPreapproval: { id: 'git-status-short' },
    });

    await expect(
      checkExecutionPolicy(
        {
          command:
            'gh pr checks pandemicsyn/neondeck#2 --repo pandemicsyn/neondeck',
          context: 'unattended',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      decision: 'allow',
      risk: 'read-only',
      matchedPreapproval: { id: 'gh-pr-checks' },
    });

    await expect(
      checkExecutionPolicy(
        { command: 'gh run view 123 --log', context: 'unattended' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      decision: 'allow',
      risk: 'read-only',
      matchedPreapproval: { id: 'gh-run-view' },
    });

    await expect(
      checkExecutionPolicy(
        { command: 'gh run watch 123', context: 'unattended' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      requires: ['preapprovedCommands'],
    });

    await expect(
      checkExecutionPolicy(
        {
          command: 'gh api repos/pandemicsyn/neondeck/actions/runs',
          context: 'unattended',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      requires: ['preapprovedCommands'],
    });

    await expect(
      checkExecutionPolicy(
        {
          command: 'gh repo delete pandemicsyn/neondeck --yes',
          context: 'unattended',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      requires: ['preapprovedCommands'],
    });

    await expect(
      checkExecutionPolicy(
        {
          command:
            'gh api -X DELETE repos/pandemicsyn/neondeck/git/refs/heads/main',
          context: 'unattended',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      requires: ['preapprovedCommands'],
    });

    await expect(
      checkExecutionPolicy(
        { command: 'ghx pr checks 123', context: 'unattended' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      requires: ['preapprovedCommands'],
    });
  });

  it('denies hardline commands even when approval mode is off', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            approvalMode: 'off',
            preapprovedCommands: [
              {
                id: 'bad',
                command: 'rm *',
                match: 'glob',
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    await expect(
      checkExecutionPolicy(
        { command: 'rm -rf /', context: 'interactive' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      risk: 'hardline',
    });
  });

  it('supports configured exe.dev preapprovals without enabling shell operators', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            defaultBackend: 'exe.dev',
            enabledBackends: ['local', 'exe.dev'],
            unattended: 'allow-preapproved',
            preapprovedCommands: [
              {
                id: 'tests',
                command: 'npm test',
                match: 'exact',
                backends: ['exe.dev'],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    await expect(
      checkExecutionPolicy(
        { command: 'npm test', backend: 'exe.dev', context: 'unattended' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      backend: 'exe.dev',
      decision: 'allow',
      matchedPreapproval: { id: 'tests' },
    });

    await expect(
      checkExecutionPolicy(
        {
          command: 'npm test && rm -rf /tmp/nope',
          backend: 'exe.dev',
          context: 'unattended',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      decision: 'deny',
      requires: ['preapprovedCommands'],
    });
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-exec-'));
  tempRoots.push(path);
  return path;
}
