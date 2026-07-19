import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listNotifications } from './modules/app-state';
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
  setApprovalNudgeDispatchForTests,
  type ChatSessionRecord,
} from './modules/sessions';
import { runWithFlueExecutionContextForTests } from './modules/flue/execution-context';
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
        dispatchId: 'dispatch-execution-approval',
        acceptedAt: new Date().toISOString(),
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
        dispatchId: `dispatch-${dispatchCount}`,
        acceptedAt: new Date().toISOString(),
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
        dispatchId: 'unexpected-dispatch',
        acceptedAt: new Date().toISOString(),
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
        dispatchId: 'unexpected-dispatch',
        acceptedAt: new Date().toISOString(),
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
