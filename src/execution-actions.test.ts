import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNotifications } from './modules/app-state';
import {
  listExecutionApprovals,
  neondeckExecutionActions,
  requestExecutionApproval,
  resolveExecutionApproval,
  runApprovedExecution,
  closeWorkspaceExecutionConnection,
  approvedExecutionResourceIdentity,
} from './modules/execution';
import { checkExecutionPolicy } from './modules/execution';
import {
  createChatSession,
  listChatSessionCommandEvents,
  setApprovalNudgeDispatchForTests,
  type ChatSessionRecord,
} from './modules/sessions';
import { runWithFlueExecutionContextForTests } from './modules/flue/execution-context';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  insertApproval as insertExecutionApproval,
  readApproval as readExecutionApproval,
  updateApprovalResult,
} from './modules/execution/store';

vi.mock('./sandboxes/exedev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandboxes/exedev')>();
  return {
    ...actual,
    createSshSandbox: async () => ({
      env: {
        cwd: '/',
        resolvePath: (path: string) => path,
        exec: async (command: string) => {
          if (command.startsWith('realpath ')) {
            const candidate = command.match(/-- '([^']+)'/)?.[1] ?? '/';
            return { stdout: `${candidate}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        readFile: async () => '',
        readFileBuffer: async () => Buffer.alloc(0),
        writeFile: async () => undefined,
        stat: async () => ({ type: 'file', size: 0, mtimeMs: 0 }),
        readdir: async () => [],
        exists: async () => true,
        mkdir: async () => undefined,
        rm: async () => undefined,
      },
      dispose: () => undefined,
    }),
  };
});

const tempRoots: string[] = [];

afterEach(async () => {
  delete process.env.EXE_VM_HOST;
  delete process.env.EXE_SSH_KEY;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('execution actions', () => {
  it('derives distinct reusable remote HOME identities from physical roots', () => {
    expect(
      approvedExecutionResourceIdentity('exe.dev', '/srv/checkouts/one'),
    ).not.toBe(
      approvedExecutionResourceIdentity('exe.dev', '/srv/checkouts/two'),
    );
    expect(
      approvedExecutionResourceIdentity('exe.dev', '/srv/checkouts/one'),
    ).toBe(approvedExecutionResourceIdentity('exe.dev', '/srv/checkouts/one'));
  });
  it('binds approval scope to the resolved SSH credential without persisting it', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const firstKey = join(paths.home, 'first-key');
    const secondKey = join(paths.home, 'second-key');
    await writeFile(firstKey, 'first-private-key');
    await writeFile(secondKey, 'second-private-key');
    process.env.EXE_VM_HOST = 'configured.exe.dev';
    process.env.EXE_SSH_KEY = firstKey;
    const first = readApproval(
      await requestExecutionApproval(
        { command: 'node --version', backend: 'exe.dev' },
        paths,
      ),
    );
    process.env.EXE_SSH_KEY = secondKey;
    const second = readApproval(
      await requestExecutionApproval(
        { command: 'node --version', backend: 'exe.dev' },
        paths,
      ),
    );
    const firstScope = first.requestContext as {
      neondeckExecutionScope: { providerConnectionFingerprint: string };
    };
    const secondScope = second.requestContext as {
      neondeckExecutionScope: { providerConnectionFingerprint: string };
    };
    expect(
      firstScope.neondeckExecutionScope.providerConnectionFingerprint,
    ).not.toBe(
      secondScope.neondeckExecutionScope.providerConnectionFingerprint,
    );
    expect(JSON.stringify(first.requestContext)).not.toContain(
      'first-private-key',
    );
  });
  it('audits provider close failures without replacing a completed result', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const approval = insertExecutionApproval(paths, {
      command: 'npm test',
      backend: 'local',
      context: 'interactive',
      risk: 'safe-mutation',
      policyDecision: 'allow',
      status: 'executed',
      result: { exitCode: 0, stdout: 'passed' },
    });
    await expect(
      closeWorkspaceExecutionConnection(
        {
          env: {} as never,
          close: async () => {
            throw new Error(
              'close transport failed ghp_abcdefghijklmnopqrstuvwxyz',
            );
          },
        },
        paths,
        approval.id,
      ),
    ).resolves.toBeUndefined();
    expect(readExecutionApproval(paths, approval.id)).toMatchObject({
      status: 'executed',
      result: {
        exitCode: 0,
        stdout: 'passed',
        transportCloseError: 'close transport failed [redacted-github-token]',
      },
    });
  });

  it('redacts and byte-bounds execution errors and nested durable results', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const approval = insertExecutionApproval(paths, {
      command: 'npm test',
      backend: 'local',
      context: 'interactive',
      risk: 'safe-mutation',
      policyDecision: 'allow',
      status: 'approved',
    });
    updateApprovalResult(paths, approval.id, {
      status: 'failed',
      error: `failed sk-${'a'.repeat(128)}${'🙂'.repeat(20_000)}`,
      result: {
        provider: {
          message: `xoxb-${'b'.repeat(128)}${'界'.repeat(30_000)}`,
        },
      },
    });
    const stored = readExecutionApproval(paths, approval.id)!;
    expect(stored.error).toContain('[redacted-api-key]');
    expect(stored.error).not.toContain('sk-');
    expect(Buffer.byteLength(stored.error ?? '', 'utf8')).toBeLessThanOrEqual(
      16 * 1024,
    );
    const nested = (stored.result as { provider: { message: string } }).provider
      .message;
    expect(nested).toContain('[redacted-token]');
    expect(nested).not.toContain('xoxb-');
    expect(Buffer.byteLength(nested, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

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
    const restoreDispatch = setApprovalNudgeDispatchForTests(async (input) => {
      await expect(
        listChatSessionCommandEvents({ sessionId }, paths),
      ).resolves.toMatchObject({
        events: [
          expect.objectContaining({
            status: 'running',
            input: expect.stringContaining(`approval ${approvalId} approved`),
          }),
        ],
      });
      expect(input).toMatchObject({
        agent: 'display-assistant',
        id: sessionId,
      });
      expect(input.input).toContain(`approval ${approvalId} approved`);
      return {
        submissionId: 'dispatch-execution-approval',
        acceptedAt: new Date().toISOString(),
        uid: 'execution-approval-session',
      };
    });
    try {
      await expect(
        resolveExecutionApproval(
          { id: approvalId, decision: 'allow-session' },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        approval: { status: 'approved', approvalDecision: 'allow-session' },
      });
    } finally {
      restoreDispatch();
    }
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

  it('resolves a pending approval and dispatches its nudge only once under contention', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const session = await createChatSession(
      { title: 'Concurrent execution approval' },
      paths,
    );
    const sessionId = (session as { session: ChatSessionRecord }).session.id;
    const request = await requestExecutionApproval(
      { command: 'node --version', cwd: paths.home, sessionId },
      paths,
    );
    const approvalId = readApprovalId(request);
    let dispatchCount = 0;
    const restoreDispatch = setApprovalNudgeDispatchForTests(async () => {
      dispatchCount += 1;
      return {
        submissionId: `dispatch-${dispatchCount}`,
        acceptedAt: new Date().toISOString(),
        uid: 'execution-approval-session',
      };
    });

    try {
      const results = await Promise.all([
        resolveExecutionApproval(
          { id: approvalId, decision: 'allow-session' },
          paths,
        ),
        resolveExecutionApproval(
          { id: approvalId, decision: 'allow-session' },
          paths,
        ),
      ]);
      expect(results.filter((result) => result.changed)).toHaveLength(1);
      expect(results.filter((result) => !result.changed)).toHaveLength(1);
    } finally {
      restoreDispatch();
    }

    expect(dispatchCount).toBe(1);
    await expect(
      listChatSessionCommandEvents({ sessionId }, paths),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ status: 'completed' })],
    });
  });

  it('does not reuse a one-shot execution approval after it is claimed', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const request = await requestExecutionApproval(
      { command: 'node --version', cwd: paths.home },
      paths,
    );
    const approvalId = readApprovalId(request);

    await expect(
      resolveExecutionApproval(
        { id: approvalId, decision: 'allow-once' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      approval: { status: 'approved', approvalDecision: 'allow-once' },
    });
    await expect(
      runApprovedExecution(
        { command: 'node --version', cwd: paths.home, approvalId },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      approval: { status: 'executed', usedAt: expect.any(String) },
    });
    await expect(
      runApprovedExecution(
        { command: 'node --version', cwd: paths.home, approvalId },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['approval'],
      approval: { id: approvalId, usedAt: expect.any(String) },
    });
  });

  it('surfaces approval nudge delivery failures after resolving execution approval', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const session = await createChatSession(
      { title: 'Execution failed nudge' },
      paths,
    );
    const sessionId = (session as { session: ChatSessionRecord }).session.id;
    const request = await requestExecutionApproval(
      { command: 'node --version', cwd: paths.home, sessionId },
      paths,
    );
    const approvalId = readApprovalId(request);
    const restoreDispatch = setApprovalNudgeDispatchForTests(async () => {
      throw new Error('dispatch queue unavailable');
    });

    try {
      await expect(
        resolveExecutionApproval(
          { id: approvalId, decision: 'allow-session' },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        approval: { status: 'approved' },
        requires: ['approvalNudge'],
        errors: ['dispatch queue unavailable'],
      });
    } finally {
      restoreDispatch();
    }
    const notifications = await listNotifications(paths);
    const failedNotification = notifications.find(
      (notification) =>
        notification.title === 'Execution approval delivery failed',
    );
    expect(failedNotification).toMatchObject({
      message: expect.stringContaining(
        'the decision was recorded in this session command log',
      ),
    });
    expect(failedNotification?.message).not.toContain('Retry with approvalId');
  });

  it('does not claim failed approval delivery was command-logged when the session is stale', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const request = await requestExecutionApproval(
      {
        command: 'node --version',
        cwd: paths.home,
        sessionId: 'missing-session',
      },
      paths,
    );
    const approvalId = readApprovalId(request);
    let dispatched = false;
    const restoreDispatch = setApprovalNudgeDispatchForTests(async () => {
      dispatched = true;
      throw new Error('dispatch queue unavailable');
    });

    try {
      await expect(
        resolveExecutionApproval(
          { id: approvalId, decision: 'allow-session' },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        approval: { status: 'approved' },
        requires: ['approvalNudge'],
        errors: ['Session missing-session was not found.'],
      });
    } finally {
      restoreDispatch();
    }
    expect(dispatched).toBe(false);
    const notifications = await listNotifications(paths);
    const failedNotification = notifications.find(
      (notification) =>
        notification.title === 'Execution approval delivery failed',
    );
    expect(failedNotification).toMatchObject({
      message: expect.stringContaining(
        'could not be recorded in the session command log',
      ),
    });
    expect(failedNotification?.message).not.toContain(
      'recorded in this session command log',
    );
  });

  it('records denied execution approval nudges without dispatching a Flue turn', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const session = await createChatSession(
      { title: 'Execution denied' },
      paths,
    );
    const sessionId = (session as { session: ChatSessionRecord }).session.id;
    const request = await requestExecutionApproval(
      { command: 'node --version', cwd: paths.home, sessionId },
      paths,
    );
    const approvalId = readApprovalId(request);
    let dispatched = false;
    const restoreDispatch = setApprovalNudgeDispatchForTests(async () => {
      dispatched = true;
      return {
        submissionId: 'unexpected-dispatch',
        acceptedAt: new Date().toISOString(),
        uid: 'unexpected-session',
      };
    });

    try {
      await expect(
        resolveExecutionApproval({ id: approvalId, decision: 'deny' }, paths),
      ).resolves.toMatchObject({
        ok: true,
        approval: { status: 'denied' },
      });
    } finally {
      restoreDispatch();
    }
    expect(dispatched).toBe(false);
    await expect(
      listChatSessionCommandEvents({ sessionId }, paths),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          status: 'completed',
          input: expect.stringContaining(`approval ${approvalId} denied`),
        }),
      ],
    });
  });

  it('skips direct execution approval nudge dispatch for legacy whitespace session ids', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const request = await requestExecutionApproval(
      { command: 'node --version', cwd: paths.home },
      paths,
    );
    const approvalId = readApprovalId(request);
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `
          UPDATE execution_approvals
          SET session_id = '   '
          WHERE id = ?;
        `,
        )
        .run(approvalId);
    } finally {
      database.close();
    }

    let dispatched = false;
    const restoreDispatch = setApprovalNudgeDispatchForTests(async () => {
      dispatched = true;
      return {
        submissionId: 'unexpected-dispatch',
        acceptedAt: new Date().toISOString(),
        uid: 'unexpected-session',
      };
    });

    try {
      await expect(
        resolveExecutionApproval(
          { id: approvalId, decision: 'allow-session' },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        approval: {
          id: approvalId,
          sessionId: null,
          status: 'approved',
        },
      });
    } finally {
      restoreDispatch();
    }
    expect(dispatched).toBe(false);
  });

  it('links execution approval requests to the current Flue session when sessionId is omitted', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const requester = await createChatSession(
      { title: 'Execution requester', activate: false },
      paths,
    );
    const sessionId = (requester as { session: ChatSessionRecord }).session.id;
    const active = await createChatSession(
      { title: 'Active dashboard' },
      paths,
    );
    expect((active as { session: ChatSessionRecord }).session.id).not.toBe(
      sessionId,
    );

    const request = await runWithFlueExecutionContextForTests(
      { agentName: 'display-assistant', instanceId: sessionId },
      () =>
        requestExecutionApproval(
          { command: 'node --version', cwd: paths.home, sessionId: '   ' },
          paths,
        ),
    );

    expect(request).toMatchObject({
      ok: true,
      approval: { status: 'pending', sessionId },
    });
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
    process.env.EXE_VM_HOST = 'configured.exe.dev';
    process.env.EXE_SSH_KEY = join(process.cwd(), 'package.json');
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

  it('uses a custom provider snapshot driver and root for exe.dev approval scope', async () => {
    process.env.EXE_VM_HOST = 'configured.exe.dev';
    process.env.EXE_SSH_KEY = join(process.cwd(), 'package.json');
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const appPath = join(paths.home, 'app');
    await mkdir(appPath, { recursive: true });
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'app',
            github: { owner: 'example', name: 'app' },
            path: appPath,
            defaultBranch: 'trunk',
          },
        ],
      }),
    );
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        workspaces: {
          providers: {
            'custom-exe': {
              driver: 'exe.dev',
              remoteRoot: '/srv/custom-checkouts',
            },
          },
        },
        execution: { enabledBackends: ['local', 'custom-exe'] },
      }),
    );
    const request = await requestExecutionApproval(
      {
        command: 'node --version',
        backend: 'custom-exe',
        repoId: 'app',
      },
      paths,
    );
    expect(readApproval(request).requestContext).toMatchObject({
      neondeckExecutionScope: {
        backend: 'custom-exe',
        remotePath: '/srv/custom-checkouts/example-app-repo',
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
      requires: ['NEONDECK_TEST_EXE_VM_HOST', 'NEONDECK_TEST_EXE_SSH_KEY'],
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
