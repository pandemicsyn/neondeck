import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listExecutionApprovals,
  neondeckExecutionActions,
  requestExecutionApproval,
  resolveExecutionApproval,
  runApprovedExecution,
} from './modules/execution';
import { checkExecutionPolicy } from './modules/execution';
import {
  createChatSession,
  listChatSessionCommandEvents,
  type ChatSessionRecord,
} from './modules/sessions';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('execution actions', () => {
  it('does not expose approval resolution as a model-callable action', () => {
    expect(neondeckExecutionActions.map((action) => action.name)).toEqual([
      'neondeck_execution_request_approval',
      'neondeck_execution_run',
    ]);
  });

  it('runs a preapproved local command and records an execution audit', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);

    const result = await runApprovedExecution(
      { command: 'pwd', cwd: paths.home },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      action: 'execution_run',
      approval: {
        backend: 'local',
        command: 'pwd',
        status: 'executed',
        approvalDecision: 'preapproved',
        exitCode: 0,
      },
    });
    expect(readApproval(result).stdoutPreview).toContain(paths.home);

    const approvals = await listExecutionApprovals(paths, {
      includeResolved: true,
    });
    expect(approvals.approvals).toEqual([
      expect.objectContaining({ command: 'pwd', status: 'executed' }),
    ]);
  });

  it('requires approval for non-preapproved interactive commands and reuses session approvals', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const session = await createChatSession({ title: 'Execution' }, paths);
    const sessionId = (session as { session: ChatSessionRecord }).session.id;

    const request = await requestExecutionApproval(
      {
        command: 'node --version',
        cwd: paths.home,
        sessionId,
      },
      paths,
    );
    expect(request).toMatchObject({
      ok: true,
      approval: { status: 'pending', command: 'node --version' },
    });

    const approvalId = readApprovalId(request);
    expect(approvalId).toBeTruthy();
    await expect(
      resolveExecutionApproval(
        { id: approvalId, decision: 'allow-session' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      approval: { status: 'approved', approvalDecision: 'allow-session' },
    });
    await expect(
      listChatSessionCommandEvents({ sessionId }, paths),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          status: 'completed',
          input: expect.stringContaining(`approval ${approvalId} approved`),
        }),
      ],
    });

    await expect(
      runApprovedExecution(
        {
          command: 'node --version',
          cwd: paths.home,
          sessionId,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      approval: {
        status: 'executed',
        approvalDecision: 'allow-session',
        approverSurface: expect.stringContaining('session:'),
      },
    });
    const approvals = await listExecutionApprovals(paths, {
      includeResolved: true,
    });
    expect(approvals.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: approvalId,
          status: 'approved',
          usedAt: expect.any(String),
        }),
      ]),
    );
  });

  it('can promote an approval into a preapproved command', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const request = await requestExecutionApproval(
      { command: 'node --version', cwd: paths.home },
      paths,
    );
    const approvalId = readApprovalId(request);

    await expect(
      resolveExecutionApproval(
        { id: approvalId, decision: 'allow-always' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      approval: { status: 'approved', approvalDecision: 'allow-always' },
    });

    await expect(
      checkExecutionPolicy({ command: 'node --version' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      decision: 'allow',
      matchedPreapproval: { command: 'node --version' },
    });
  });

  it('scopes exe.dev approvals to the requested repo/worktree and env intent', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const appPath = join(paths.home, 'app');
    const otherPath = join(paths.home, 'other');
    await mkdir(appPath, { recursive: true });
    await mkdir(otherPath, { recursive: true });
    await writeFile(
      paths.repos,
      JSON.stringify(
        {
          repos: [
            {
              id: 'app',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: appPath,
              defaultBranch: 'main',
            },
            {
              id: 'other',
              github: { owner: 'pandemicsyn', name: 'other' },
              path: otherPath,
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
          },
        },
        null,
        2,
      ),
    );

    const request = await requestExecutionApproval(
      {
        command: 'node --version',
        backend: 'exe.dev',
        repoId: 'app',
        sessionId: 'session-1',
      },
      paths,
    );
    const approvalId = readApprovalId(request);
    expect(readApproval(request).requestContext).toMatchObject({
      neondeckExecutionScope: {
        backend: 'exe.dev',
        repoId: 'app',
        remotePath: '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo',
        forwardEnv: true,
        envSources: [],
      },
    });

    await expect(
      resolveExecutionApproval(
        { id: approvalId, decision: 'allow-always' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['preapprovedCommands'],
    });
    await expect(
      resolveExecutionApproval(
        { id: approvalId, decision: 'allow-session' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      approval: { status: 'approved', approvalDecision: 'allow-session' },
    });

    await expect(
      runApprovedExecution(
        {
          command: 'node --version',
          backend: 'exe.dev',
          repoId: 'other',
          sessionId: 'session-1',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['approval'],
      approval: {
        status: 'pending',
        requestContext: {
          neondeckExecutionScope: {
            repoId: 'other',
            remotePath: '/home/user/neondeck/checkouts/pandemicsyn-other-repo',
          },
        },
      },
    });
  });

  it('blocks hardline commands and writes a blocked audit record', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);

    await expect(
      runApprovedExecution({ command: 'rm -rf /' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      approval: {
        status: 'blocked',
        risk: 'hardline',
      },
    });
  });

  it('requires an exe.dev VM host env var for approved exe.dev execution', async () => {
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
            exeDev: {
              lifecycle: 'existing-vm',
              vmHostEnv: 'NEONDECK_TEST_EXE_VM_HOST',
              sshKeyEnv: 'NEONDECK_TEST_EXE_SSH_KEY',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(
      runApprovedExecution({ command: 'pwd', backend: 'exe.dev' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['NEONDECK_TEST_EXE_VM_HOST'],
      approval: {
        backend: 'exe.dev',
        status: 'failed',
      },
    });
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-exec-actions-'));
  tempRoots.push(path);
  return path;
}

function readApprovalId(result: unknown) {
  const approval = readApproval(result);
  expect(typeof approval?.id).toBe('string');
  return approval.id as string;
}

function readApproval(result: unknown) {
  const approval = (
    result as {
      approval?: {
        id?: unknown;
        stdoutPreview?: string | null;
        requestContext?: unknown;
      };
    }
  ).approval;
  if (!approval) throw new Error('Expected execution approval in result.');
  return approval;
}
