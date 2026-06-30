import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listExecutionApprovals } from './execution-actions';
import { syncExeDevCheckout } from './exedev-checkouts';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('exe.dev checkout sync', () => {
  it('routes remote checkout commands through execution approval records', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    await mkdir(repoPath, { recursive: true });
    await writeFile(
      paths.repos,
      JSON.stringify(
        {
          repos: [
            {
              id: 'app',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: repoPath,
              defaultBranch: 'main',
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            enabledBackends: ['local', 'exe.dev'],
            exeDev: {
              lifecycle: 'existing-vm',
              remoteRoot: '/home/user/sandboxes',
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await syncExeDevCheckout({ repoId: 'app' }, paths);

    expect(result).toMatchObject({
      ok: false,
      action: 'exedev_checkout_sync',
      blockedStep: 'mkdir-parent',
      requires: ['approval'],
      checkout: {
        repoId: 'app',
        repoFullName: 'pandemicsyn/neondeck',
        remotePath: '/home/user/sandboxes/pandemicsyn-neondeck-repo',
      },
    });
    const approvals = await listExecutionApprovals(paths, {
      includeResolved: true,
    });
    expect(approvals.approvals).toEqual([
      expect.objectContaining({
        backend: 'exe.dev',
        command: "mkdir -p '/home/user/sandboxes'",
        status: 'pending',
        requestContext: expect.objectContaining({
          action: 'exedev_checkout_sync',
          step: 'mkdir-parent',
          repoId: 'app',
        }),
      }),
    ]);
  });

  it('rejects unsafe checkout refs at the action boundary', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);

    await expect(
      syncExeDevCheckout({ repoId: 'app', ref: '--detach' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      action: 'exedev_checkout_sync',
      requires: ['repoId'],
      message: expect.stringContaining('Expected a safe git ref or SHA'),
    });
  });

  it('does not treat an approval-blocked probe as a missing checkout', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    const calls: Array<Record<string, unknown>> = [];

    const result = await syncExeDevCheckout({ repoId: 'app' }, paths, {
      async runExecution(input: unknown) {
        calls.push(input as Record<string, unknown>);
        if (calls.length === 1) {
          return {
            ok: true,
            action: 'execution_run',
            changed: true,
            message: 'mkdir ok',
            approval: { id: 'approval-mkdir', status: 'executed' },
            result: { exitCode: 0, stdout: '', stderr: '' },
          };
        }
        return {
          ok: false,
          action: 'execution_run',
          changed: true,
          message: 'Execution requires user approval before running.',
          requires: ['approval'],
          approval: { id: 'approval-probe', status: 'pending' },
        };
      },
    });

    expect(result).toMatchObject({
      ok: false,
      blockedStep: 'probe',
      requires: ['approval'],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/home/user/neondeck/checkouts'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo' rev-parse --is-inside-work-tree",
    ]);
  });

  it('passes per-step approval ids when retrying a blocked sync step', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    const calls: Array<Record<string, unknown>> = [];

    await syncExeDevCheckout(
      {
        repoId: 'app',
        approvals: { 'mkdir-parent': 'approval-once' },
      },
      paths,
      {
        async runExecution(input: unknown) {
          calls.push(input as Record<string, unknown>);
          return {
            ok: false,
            action: 'execution_run',
            changed: true,
            message:
              'exe.dev VM host environment variable EXE_VM_HOST is not set.',
            requires: ['EXE_VM_HOST'],
            approval: { id: 'approval-once', status: 'failed' },
            result: { exitCode: null, stdout: '', stderr: '' },
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "mkdir -p '/home/user/neondeck/checkouts'",
      approvalId: 'approval-once',
    });
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-exedev-sync-'));
  tempRoots.push(path);
  return path;
}

async function writeRepo(paths: ReturnType<typeof runtimePaths>) {
  const repoPath = join(paths.home, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    paths.repos,
    JSON.stringify(
      {
        repos: [
          {
            id: 'app',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: repoPath,
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    ),
  );
}
