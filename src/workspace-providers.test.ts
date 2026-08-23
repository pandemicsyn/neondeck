import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@flue/runtime';
import type {
  WorkspaceProvider,
  WorkspaceResource,
} from './modules/workspace-providers';
import {
  WorkspaceOperationUncertainError,
  WorkspaceProviderRegistry,
  localWorkspaceProvider,
  physicalRemoteResourceKey,
  canonicalSshHost,
  remoteWorkspaceProvider,
  workspaceProviderFromSnapshot,
} from './modules/workspace-providers';
import {
  acquireTaskWorkspaceLock,
  acquirePhysicalWorkspaceLease,
  acquireTaskWorkspaceCollectionLease,
  acquireTaskWorkspaceCleanupLease,
  acquireWorkspaceProviderCoordinator,
  addScheduledRunArtifact,
  claimDueScheduledTasks,
  closeScheduledWorkspaceConnection,
  cleanupTaskRunWorkspace,
  cloneScheduledRepository,
  bindReusableWorkspaceToRun,
  activateScheduledTaskSubmission,
  createTaskWorkspaceRecord as createTaskWorkspaceRecordInternal,
  failTaskWorkspaceRunOwned,
  fenceTaskWorkspacePhysicalRelease,
  finalizeTaskWorkspaceCleanup,
  finalizeSuccessfulTaskWorkspaceCleanup,
  finalizeTaskWorkspaceCollection,
  quarantinePhysicalWorkspace,
  listPhysicalWorkspaceQuarantines,
  clearPhysicalWorkspaceQuarantine,
  instrumentedWorkspaceSandbox,
  listScheduledRunArtifacts,
  listRecoverableScheduledWorkspaceCleanups,
  readScheduledTask,
  readTaskWorkspace,
  readTaskWorkspaceForRun,
  readScheduledTaskRun,
  renewWorkspaceProviderCoordinator,
  releaseTaskWorkspaceLock,
  releasePhysicalWorkspaceLease,
  retainTaskWorkspace,
  renewTaskWorkspaceLock,
  renewTaskWorkspaceCleanupLease,
  removeTask,
  scheduledWorkspacePolicyIssue,
  settleScheduledTaskRun,
  assertWorkspaceProviderCoordinatorSync,
  startCleanupHeartbeat,
  updateTaskWorkspace,
  upsertScheduledTask,
} from './modules/scheduled-tasks';
import { openDb } from './lib/sqlite';
import { runSchedulerTick } from './modules/scheduler';
import { parseAppConfig, runtimePaths } from './runtime-home';

const createTaskWorkspaceRecord = (
  input: Omit<
    Parameters<typeof createTaskWorkspaceRecordInternal>[0],
    'providerSnapshot' | 'physicalResourceKey' | 'repoSnapshot'
  >,
  paths: Parameters<typeof createTaskWorkspaceRecordInternal>[1],
) => {
  process.env.TEST_SSH_KEY = join(process.cwd(), 'package.json');
  return createTaskWorkspaceRecordInternal(
    {
      ...input,
      resource:
        input.resource.providerId === 'local'
          ? input.resource
          : {
              ...input.resource,
              metadata: {
                host: 'test.example.com',
                username: 'user',
                providerRoot: '/workspaces',
                privateHome: `/workspaces/.neondeck-homes/${input.resource.externalId}`,
                managedInfrastructure: false,
                ...input.resource.metadata,
              },
            },
      providerSnapshot:
        input.resource.providerId === 'local'
          ? { version: 1, providerId: 'local', driver: 'local' }
          : {
              version: 1,
              providerId: input.resource.providerId,
              driver: 'ssh',
              config: {
                driver: 'ssh',
                hostEnv: 'TEST_SSH_HOST',
                privateKeyEnv: 'TEST_SSH_KEY',
                remoteRoot: '/workspaces',
              },
            },
      physicalResourceKey:
        input.resource.providerId === 'local'
          ? `local:${input.resource.root}`
          : `ssh://user@test.example.com:22/workspaces/${input.resource.externalId}`,
      repoSnapshot: {
        verified: true,
        id: input.policy.repoId,
        github: { owner: 'owner', name: input.policy.repoId },
        path: `/repos/${input.policy.repoId}`,
        defaultBranch: input.policy.revision.ref,
      },
    },
    paths,
  );
};

describe('workspace provider registry', () => {
  it('renews and owner-fences the shared provider and repository coordinator', async () => {
    const home = await mkdtemp(
      join(tmpdir(), 'neondeck-provider-coordinator-'),
    );
    const paths = runtimePaths(home);
    try {
      await expect(
        acquireWorkspaceProviderCoordinator('admission-one', paths),
      ).resolves.toBe(true);
      await expect(
        renewWorkspaceProviderCoordinator('admission-one', paths),
      ).resolves.toBe(true);
      expect(() =>
        assertWorkspaceProviderCoordinatorSync('admission-one', paths),
      ).not.toThrow();

      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `UPDATE workspace_provider_coordinator
             SET owner = 'replacement-owner'
             WHERE id = 'config';`,
          )
          .run();
      } finally {
        database.close();
      }
      await expect(
        renewWorkspaceProviderCoordinator('admission-one', paths),
      ).resolves.toBe(false);
      expect(() =>
        assertWorkspaceProviderCoordinatorSync('admission-one', paths),
      ).toThrow('lease was lost');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('durably blocks quarantined physical resources across lease release until explicit clearance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-quarantine-'));
    const paths = runtimePaths(home);
    const physicalResourceKey = 'ssh://runner@example.com:22/workspaces/run';
    try {
      expect(
        await acquirePhysicalWorkspaceLease(
          {
            physicalResourceKey,
            providerId: 'build-box',
            owner: 'first',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).toBe(true);
      await quarantinePhysicalWorkspace(
        {
          physicalResourceKey,
          providerId: 'build-box',
          source: 'scheduled-run',
          sourceId: 'run-one',
          reason: 'Remote timeout did not confirm process settlement.',
        },
        paths,
      );
      await releasePhysicalWorkspaceLease(
        { physicalResourceKey, owner: 'first' },
        paths,
      );

      expect(
        await acquirePhysicalWorkspaceLease(
          {
            physicalResourceKey,
            providerId: 'build-box',
            owner: 'after-restart',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).toBe(false);
      await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual([
        expect.objectContaining({
          physicalResourceKey,
          providerId: 'build-box',
          sourceId: 'run-one',
        }),
      ]);
      await expect(
        clearPhysicalWorkspaceQuarantine(physicalResourceKey, paths),
      ).resolves.toBe(false);
      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `UPDATE app_metadata
             SET value = json_set(value, '$.expiresAt', ?)
             WHERE key = ?;`,
          )
          .run(
            '2000-01-01T00:00:00.000Z',
            `workspace-resource-lease:${physicalResourceKey}`,
          );
      } finally {
        database.close();
      }
      await expect(
        clearPhysicalWorkspaceQuarantine(physicalResourceKey, paths),
      ).resolves.toBe(true);
      expect(
        await acquirePhysicalWorkspaceLease(
          {
            physicalResourceKey,
            providerId: 'build-box',
            owner: 'after-clear',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).toBe(true);
      await expect(
        clearPhysicalWorkspaceQuarantine(physicalResourceKey, paths),
      ).resolves.toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('turns an expired remote lease into a restart-stable quarantine instead of reacquiring it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-expired-quarantine-'));
    const paths = runtimePaths(home);
    const physicalResourceKey = 'ssh://runner@example.com:22/workspaces/crash';
    try {
      await acquirePhysicalWorkspaceLease(
        {
          physicalResourceKey,
          providerId: 'exe.dev',
          owner: 'crashed-owner',
          ttlMs: 60_000,
        },
        paths,
      );
      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `UPDATE app_metadata
             SET value = json_set(value, '$.expiresAt', ?)
             WHERE key = ?;`,
          )
          .run(
            '2000-01-01T00:00:00.000Z',
            `workspace-resource-lease:${physicalResourceKey}`,
          );
      } finally {
        database.close();
      }
      await expect(
        acquirePhysicalWorkspaceLease(
          {
            physicalResourceKey,
            providerId: 'exe.dev',
            owner: 'restart-owner',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).resolves.toBe(false);
      await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual([
        expect.objectContaining({
          physicalResourceKey,
          providerId: 'exe.dev',
          sourceId: 'crashed-owner',
          reason: expect.stringContaining('expired'),
        }),
      ]);
      await expect(
        clearPhysicalWorkspaceQuarantine(physicalResourceKey, paths),
      ).resolves.toBe(true);
      await expect(
        acquirePhysicalWorkspaceLease(
          {
            physicalResourceKey,
            providerId: 'exe.dev',
            owner: 'cleared-owner',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual(
        [],
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('persists an uncertain remote release fence through failure settlement and restart-like reacquisition', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-release-fence-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: { lifecycle: 'reuse-task' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:release-fence',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'exercise uncertain remote settlement',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'once', at: '2026-08-17T12:00:00.000Z' },
          nextRunAt: '2026-08-17T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-17T12:00:00.000Z'),
      );
      const runId = claim!.run.id;
      const owner = `scheduled-run:${runId}`;
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'session:release-fence',
          dispatchKey: runId,
          dispatchPayload: {
            prompt: 'exercise uncertain remote settlement',
            taskId: claim!.task.id,
            runId,
            workspaceId: 'pending',
            lockOwner: owner,
          },
        },
        paths,
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId,
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'release-fence',
            root: '/workspaces/release-fence',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      await expect(
        acquireTaskWorkspaceLock(
          { workspaceId: workspace.id, taskId: claim!.task.id, owner },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        fenceTaskWorkspacePhysicalRelease(
          { workspaceId: workspace.id, runId, lockOwner: owner },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        failTaskWorkspaceRunOwned(
          {
            workspaceId: workspace.id,
            runId,
            lockOwner: owner,
            providerError: 'quarantine persistence failed',
            retentionReason: 'physical release is fenced',
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'retained',
        releaseFencedAt: expect.any(String),
      });

      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare('DELETE FROM app_metadata WHERE key = ?;')
          .run(
            `workspace-resource-quarantine:${workspace.physicalResourceKey}`,
          );
        database
          .prepare(
            `UPDATE app_metadata
             SET value = json_set(value, '$.expiresAt', ?)
             WHERE key = ?;`,
          )
          .run(
            '2000-01-01T00:00:00.000Z',
            `workspace-resource-lease:${workspace.physicalResourceKey}`,
          );
      } finally {
        database.close();
      }
      await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual([
        expect.objectContaining({
          physicalResourceKey: workspace.physicalResourceKey,
          providerId: 'remote',
          sourceId: runId,
          reason: expect.stringContaining('persistence did not complete'),
        }),
      ]);
      await expect(
        acquirePhysicalWorkspaceLease(
          {
            physicalResourceKey: workspace.physicalResourceKey,
            providerId: 'remote',
            owner: 'restart-owner',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).resolves.toBe(false);
      await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual([
        expect.objectContaining({
          physicalResourceKey: workspace.physicalResourceKey,
          providerId: 'remote',
          sourceId: owner,
        }),
      ]);
      const cleanupOwner = `cleanup:${workspace.id}`;
      await expect(
        acquireTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owningRunId: runId,
            owner: cleanupOwner,
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        finalizeTaskWorkspaceCleanup(
          {
            workspaceId: workspace.id,
            owningRunId: runId,
            owner: cleanupOwner,
            status: 'cleanup-pending',
            deletedAt: null,
            providerError: 'cleanup result remained uncertain',
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'cleanup-pending',
        releaseFencedAt: expect.any(String),
      });
      await expect(
        clearPhysicalWorkspaceQuarantine(workspace.physicalResourceKey, paths),
      ).resolves.toBe(false);
      const cleanupDatabase = openDb(paths.neondeckDatabase);
      try {
        cleanupDatabase
          .prepare(
            `UPDATE app_metadata
             SET value = json_set(value, '$.expiresAt', ?)
             WHERE key = ? AND json_extract(value, '$.owner') = ?;`,
          )
          .run(
            '2000-01-01T00:00:00.000Z',
            `workspace-resource-lease:${workspace.physicalResourceKey}`,
            cleanupOwner,
          );
      } finally {
        cleanupDatabase.close();
      }
      await expect(
        clearPhysicalWorkspaceQuarantine(workspace.physicalResourceKey, paths),
      ).resolves.toBe(true);
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({ releaseFencedAt: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('atomically clears a managed quarantine only for the exact successful cleanup owner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-success-'));
    const paths = runtimePaths(home);
    try {
      const runId = 'scheduled-task-run:cleanup-success';
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:cleanup-success',
          runId,
          policy: {
            kind: 'repository',
            repoId: 'repo',
            providerId: 'remote',
            resource: { lifecycle: 'per-run' },
            revision: { ref: 'main', mode: 'latest-each-run' },
            git: { mode: 'run-branch' },
            authority: 'trusted-workspace',
          },
          resource: {
            providerId: 'remote',
            externalId: 'cleanup-success',
            root: '/workspaces/cleanup-success',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      await fenceTaskWorkspacePhysicalRelease(
        { workspaceId: workspace.id, runId, lockOwner: null },
        paths,
      );
      await quarantinePhysicalWorkspace(
        {
          physicalResourceKey: workspace.physicalResourceKey,
          providerId: workspace.providerId,
          source: 'cleanup',
          sourceId: runId,
          reason: 'prior operation settlement was uncertain',
        },
        paths,
      );
      const owner = 'managed-cleanup:owner';
      await expect(
        acquireTaskWorkspaceCleanupLease(
          { workspaceId: workspace.id, owningRunId: runId, owner },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        finalizeSuccessfulTaskWorkspaceCleanup(
          {
            workspaceId: workspace.id,
            owningRunId: runId,
            owner: 'managed-cleanup:stale',
            deletedAt: new Date().toISOString(),
          },
          paths,
        ),
      ).resolves.toBeUndefined();
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({ status: 'cleanup-pending', lockOwner: owner });
      await expect(
        finalizeSuccessfulTaskWorkspaceCleanup(
          {
            workspaceId: workspace.id,
            owningRunId: runId,
            owner,
            deletedAt: new Date().toISOString(),
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'deleted',
        lockOwner: null,
        releaseFencedAt: null,
      });
      await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual(
        [],
      );
      await expect(
        clearPhysicalWorkspaceQuarantine(workspace.physicalResourceKey, paths),
      ).resolves.toBe(false);
      const database = openDb(paths.neondeckDatabase, { readOnly: true });
      try {
        expect(
          database
            .prepare('SELECT 1 FROM app_metadata WHERE key = ?;')
            .get(`workspace-resource-lease:${workspace.physicalResourceKey}`),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('audits scheduled connection close failures without replacing completed effects', async () => {
    const artifacts: Array<{ summary: string; content: string | null }> = [];
    await expect(
      closeScheduledWorkspaceConnection(
        {
          env: {} as Sandbox,
          close: async () => {
            throw new Error('transport close failed');
          },
        },
        {
          runId: 'scheduled-task-run:close',
          workspaceId: 'task-workspace:close',
          preparationOwner: 'scheduled-run:close',
          phase: 'preparation',
        },
        runtimePaths(join(tmpdir(), 'unused-close-audit')),
        async (artifact) => {
          artifacts.push({
            summary: artifact.summary,
            content: artifact.content,
          });
          return {} as never;
        },
      ),
    ).resolves.toBeUndefined();
    expect(artifacts).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining('close failed'),
        content: expect.stringContaining('transport close failed'),
      }),
    ]);
  });

  it('persists preparation close audits while the exact run is still claimed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-preparation-audit-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:preparation-audit',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'prepare',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'preparation-audit',
            root: '/workspace/preparation-audit',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      const owner = `scheduled-run:${claim!.run.id}`;
      expect(
        await acquireTaskWorkspaceLock(
          { workspaceId: workspace.id, taskId: claim!.task.id, owner },
          paths,
        ),
      ).toBe(true);
      await closeScheduledWorkspaceConnection(
        {
          env: {} as Sandbox,
          close: async () => {
            throw new Error('preparation transport close failed');
          },
        },
        {
          runId: claim!.run.id,
          workspaceId: workspace.id,
          preparationOwner: owner,
          phase: 'preparation',
        },
        paths,
      );
      await expect(
        listScheduledRunArtifacts(claim!.run.id, paths),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: 'cleanup',
          content: expect.stringContaining(
            'preparation transport close failed',
          ),
        }),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('derives provider-independent physical SSH identities', () => {
    const base = {
      externalId: 'ignored-provider-resource',
      root: '/srv/workspaces/shared',
      metadata: { host: 'Build.EXAMPLE.com', username: 'runner', port: 2222 },
    };
    expect(physicalRemoteResourceKey({ ...base, providerId: 'one' })).toBe(
      physicalRemoteResourceKey({ ...base, providerId: 'two' }),
    );
    expect(
      physicalRemoteResourceKey({
        ...base,
        providerId: 'two',
        root: '/srv/workspaces/distinct',
      }),
    ).not.toBe(physicalRemoteResourceKey({ ...base, providerId: 'one' }));
  });

  it('canonicalizes equivalent IPv6 spellings and rejects ambiguous numeric IPv4 hosts', () => {
    expect(canonicalSshHost('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalSshHost('[2001:db8::1]')).toBe('2001:db8::1');
    expect(canonicalSshHost('::ffff:192.0.2.128')).toBe('::ffff:c000:280');
    expect(() => canonicalSshHost('127.1')).toThrow(/canonical four-octet/i);
    expect(() => canonicalSshHost('127.000.0.1')).toThrow(
      /canonical four-octet/i,
    );
  });
  it('rejects duplicate and unknown providers without fallback', () => {
    const provider = fakeProvider('remote-one');
    const registry = new WorkspaceProviderRegistry().register(provider);
    expect(() => registry.register(provider)).toThrowError(
      expect.objectContaining({ code: 'invalid-config' }),
    );
    expect(() => registry.get('missing')).toThrowError(
      expect.objectContaining({ code: 'unknown-provider' }),
    );
  });

  it('rejects contradictory persisted provider adapter snapshots', () => {
    expect(() =>
      workspaceProviderFromSnapshot({
        version: 1,
        providerId: 'contradictory',
        driver: 'ssh',
        config: {
          driver: 'exe.dev',
          apiTokenEnv: 'EXE_API_TOKEN',
        },
      } as never),
    ).toThrow(/Expected "ssh"/i);
  });

  it('keeps transport close separate from infrastructure destroy', async () => {
    const provider = fakeProvider('fake');
    const resource = await provider.provision({
      resourceId: 'run-one',
      lifecycle: 'per-run',
    });
    const connection = await provider.connect(resource);
    await connection.close();
    expect(resource.metadata).toMatchObject({ closed: true, destroyed: false });
    await provider.destroy(resource);
    expect(resource.metadata).toMatchObject({ closed: true, destroyed: true });
  });

  it('provides conforming local file and command operations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neondeck-local-provider-'));
    try {
      await writeFile(join(directory, 'input.txt'), 'hello');
      const provider = localWorkspaceProvider();
      const resource = await provider.attach({
        externalId: 'managed:test',
        root: directory,
      });
      const connection = await provider.connect(resource);
      expect(await connection.env.readFile('input.txt')).toBe('hello');
      await connection.env.writeFile('nested/output.txt', 'world');
      expect(await connection.env.readFile('nested/output.txt')).toBe('world');
      await expect(connection.env.readFile('../outside.txt')).rejects.toThrow(
        /escapes the managed root/,
      );
      const outside = await mkdtemp(join(tmpdir(), 'neondeck-local-outside-'));
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(directory, 'escape'));
      await expect(
        connection.env.readFile('escape/secret.txt'),
      ).rejects.toThrow(/outside the managed root/);
      await expect(
        connection.env.writeFile('escape/created.txt', 'nope'),
      ).rejects.toThrow(/outside the managed root/);
      await expect(connection.env.stat('escape/secret.txt')).rejects.toThrow(
        /outside the managed root/,
      );
      await expect(connection.env.readdir('escape')).rejects.toThrow(
        /outside the managed root/,
      );
      await expect(connection.env.mkdir('escape/new')).rejects.toThrow(
        /outside the managed root/,
      );
      await expect(
        connection.env.exec('pwd', { cwd: 'escape' }),
      ).rejects.toThrow(/outside the managed root/);
      await expect(connection.env.exists('escape/secret.txt')).resolves.toBe(
        false,
      );
      await rm(outside, { recursive: true, force: true });
      await expect(connection.env.exists('../outside.txt')).resolves.toBe(
        false,
      );
      await expect(connection.env.exec('pwd')).resolves.toMatchObject({
        exitCode: 0,
      });
      await connection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports exe.dev readiness for the requested resource lifecycle', async () => {
    const previousHost = process.env.NEONDECK_TEST_EXE_HOST;
    const previousToken = process.env.NEONDECK_TEST_EXE_TOKEN;
    const previousKey = process.env.NEONDECK_TEST_EXE_KEY;
    process.env.NEONDECK_TEST_EXE_HOST = 'configured.exe.dev';
    process.env.NEONDECK_TEST_EXE_KEY = join(process.cwd(), 'package.json');
    delete process.env.NEONDECK_TEST_EXE_TOKEN;
    try {
      const provider = remoteWorkspaceProvider({
        id: 'exe.dev',
        config: {
          driver: 'exe.dev',
          vmHostEnv: 'NEONDECK_TEST_EXE_HOST',
          apiTokenEnv: 'NEONDECK_TEST_EXE_TOKEN',
          sshKeyEnv: 'NEONDECK_TEST_EXE_KEY',
        },
      });
      await expect(
        provider.readiness({ lifecycle: 'existing' }),
      ).resolves.toMatchObject({ ready: true });
      await expect(
        provider.readiness({ lifecycle: 'per-run' }),
      ).resolves.toMatchObject({
        ready: false,
        missingEnvironment: ['NEONDECK_TEST_EXE_TOKEN'],
      });
    } finally {
      if (previousHost === undefined) delete process.env.NEONDECK_TEST_EXE_HOST;
      else process.env.NEONDECK_TEST_EXE_HOST = previousHost;
      if (previousToken === undefined)
        delete process.env.NEONDECK_TEST_EXE_TOKEN;
      else process.env.NEONDECK_TEST_EXE_TOKEN = previousToken;
      if (previousKey === undefined) delete process.env.NEONDECK_TEST_EXE_KEY;
      else process.env.NEONDECK_TEST_EXE_KEY = previousKey;
    }
  });

  it('closes disposable remote sandbox connections after each operation', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker, {
      missingPaths: ['/workspaces/shared/missing'],
    });
    const workspace = await provider.attach({
      externalId: 'shared',
      root: '/workspaces/shared',
    });
    const env = await provider.sandbox(workspace).createSandbox({ id: 'run' });
    expect(tracker).toEqual({ connected: 2, disposed: 2 });
    await expect(env.exec('npm test')).resolves.toMatchObject({ exitCode: 0 });
    expect(tracker).toEqual({ connected: 3, disposed: 3 });
    await expect(env.exists('/workspaces/shared/missing')).resolves.toBe(false);
    expect(tracker).toEqual({ connected: 4, disposed: 4 });
  });

  it('reports private-HOME setup uncertainty for exec, read, stat, and exists while exists stays false', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker, { uncertainPrivateHome: true });
    const workspace = await provider.attach({ externalId: 'shared' });
    const uncertain: string[] = [];
    const env = await provider
      .sandbox(workspace, {
        onOperationUncertain(error) {
          uncertain.push(error.uncertainty.operation);
        },
      })
      .createSandbox({ id: 'run' });

    await expect(env.exec('npm test')).rejects.toBeInstanceOf(
      WorkspaceOperationUncertainError,
    );
    await expect(env.readFile('README.md')).rejects.toBeInstanceOf(
      WorkspaceOperationUncertainError,
    );
    await expect(env.stat('README.md')).rejects.toBeInstanceOf(
      WorkspaceOperationUncertainError,
    );
    await expect(env.exists('README.md')).resolves.toBe(false);
    expect(uncertain).toEqual([
      'Remote private HOME setup',
      'Remote private HOME setup',
      'Remote private HOME setup',
      'Remote private HOME setup',
    ]);

    const readTracker = { connected: 0, disposed: 0 };
    const readProvider = testSshProvider(readTracker, {
      id: 'uncertain-read-ssh',
      uncertainExists: true,
    });
    const readWorkspace = await readProvider.attach({ externalId: 'shared' });
    const readUncertainty: string[] = [];
    const readEnvironment = await readProvider
      .sandbox(readWorkspace, {
        onOperationUncertain(error) {
          readUncertainty.push(error.uncertainty.operation);
        },
      })
      .createSandbox({ id: 'read-run' });
    await expect(readEnvironment.exists('README.md')).resolves.toBe(false);
    expect(readUncertainty).toEqual(['exists']);
  });

  it('rejects an already-aborted disposable command before opening SSH or preparing HOME', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const commands: string[] = [];
    const provider = testSshProvider(tracker, { commands });
    const workspace = await provider.attach({ externalId: 'shared' });
    const env = await provider.sandbox(workspace).createSandbox({ id: 'run' });
    const before = {
      tracker: { ...tracker },
      commandCount: commands.length,
    };
    const controller = new AbortController();
    controller.abort(new Error('cancelled before dispatch'));

    await expect(
      env.exec('npm test', { signal: controller.signal, timeoutMs: 30_000 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracker).toEqual(before.tracker);
    expect(commands).toHaveLength(before.commandCount);
  });

  it('abandons and closes an SSH connection aborted during setup without preparing HOME', async () => {
    process.env.NEONDECK_TEST_SSH_HOST = 'ssh.test';
    process.env.NEONDECK_TEST_SSH_KEY = join(process.cwd(), 'package.json');
    const tracker = { connected: 0, disposed: 0 };
    const commands: string[] = [];
    type Connection = {
      env: Sandbox;
      dispose(): Promise<void>;
    };
    let resolvePending!: (connection: Connection) => void;
    const pendingConnection = new Promise<Connection>((resolve) => {
      resolvePending = resolve;
    });
    const connection = (): Connection => ({
      env: fakeRemoteEnv({ commands }),
      dispose: async () => {
        tracker.disposed += 1;
      },
    });
    const provider = remoteWorkspaceProvider({
      id: 'abortable-ssh',
      config: {
        driver: 'ssh',
        hostEnv: 'NEONDECK_TEST_SSH_HOST',
        privateKeyEnv: 'NEONDECK_TEST_SSH_KEY',
        remoteRoot: '/workspaces',
      },
      connectSsh: async () => {
        tracker.connected += 1;
        return tracker.connected === 3 ? pendingConnection : connection();
      },
    });
    const workspace = await provider.attach({ externalId: 'shared' });
    const env = await provider.sandbox(workspace).createSandbox({ id: 'run' });
    const setupCommandCount = commands.length;
    const controller = new AbortController();
    const execution = env.exec('npm test', {
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    await Promise.resolve();
    expect(tracker.connected).toBe(3);
    controller.abort(new Error('cancelled during SSH setup'));
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    resolvePending(connection());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(tracker.disposed).toBe(3);
    expect(commands).toHaveLength(setupCommandCount);
  });

  it('charges SSH security setup against the disposable command timeout', async () => {
    process.env.NEONDECK_TEST_SSH_HOST = 'ssh.test';
    process.env.NEONDECK_TEST_SSH_KEY = join(process.cwd(), 'package.json');
    const setupTimeouts: number[] = [];
    const commands: string[] = [];
    const env = fakeRemoteEnv({ commands });
    const originalExec = env.exec.bind(env);
    env.exec = async (command, options) => {
      if (command.startsWith('set -eu;')) {
        setupTimeouts.push(options?.timeoutMs ?? 0);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      return originalExec(command, options);
    };
    const provider = remoteWorkspaceProvider({
      id: 'timed-ssh',
      config: {
        driver: 'ssh',
        hostEnv: 'NEONDECK_TEST_SSH_HOST',
        privateKeyEnv: 'NEONDECK_TEST_SSH_KEY',
        remoteRoot: '/workspaces',
      },
      connectSsh: async () => ({ env, dispose: async () => undefined }),
    });
    const workspace = await provider.attach({ externalId: 'shared' });
    const sandbox = await provider
      .sandbox(workspace)
      .createSandbox({ id: 'run' });

    await expect(sandbox.exec('npm test', { timeoutMs: 5 })).rejects.toThrow(
      /exhausted the command timeout/,
    );
    expect(setupTimeouts).toHaveLength(1);
    expect(setupTimeouts[0]).toBeGreaterThan(0);
    expect(setupTimeouts[0]).toBeLessThanOrEqual(5);
    expect(commands).not.toContain('npm test');
  });

  it('attaches targetless approved execution to the provider root with an isolated HOME identity', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker);
    const workspace = await provider.attach({
      externalId: 'configured',
      allowProviderRoot: true,
      privateHomeIdentity: 'approved-scope-one',
    });
    expect(workspace).toMatchObject({
      root: '/workspaces',
      metadata: {
        allowProviderRoot: true,
        privateHome: expect.stringMatching(
          /^\/workspaces\/\.neondeck-homes\/[a-f0-9]{24}$/,
        ),
      },
    });
    const connection = await provider.connect(workspace);
    await connection.close();
  });

  it('reports remote close errors separately without rejecting a completed sandbox operation', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker, { failDisposeAfter: 2 });
    const workspace = await provider.attach({ externalId: 'shared' });
    const closeErrors: string[] = [];
    const env = await provider
      .sandbox(workspace, {
        onTransportCloseError: (message) => {
          closeErrors.push(message);
        },
      })
      .createSandbox({ id: 'run' });
    await expect(env.exec('npm test')).resolves.toMatchObject({ exitCode: 0 });
    expect(closeErrors).toEqual([expect.stringContaining('close failed')]);
  });

  it('rejects ambient remote credentials and physical root escapes', async () => {
    const credentialTracker = { connected: 0, disposed: 0 };
    const credentialProvider = testSshProvider(credentialTracker, {
      credentialAudit: 'GH_TOKEN\n',
    });
    const credentialWorkspace = await credentialProvider.attach({
      externalId: 'shared',
      root: '/workspaces/shared',
    });
    await expect(
      credentialProvider.connect(credentialWorkspace),
    ).rejects.toThrow(/credential-free SSH account/);
    expect(credentialTracker.disposed).toBe(2);

    const escapeTracker = { connected: 0, disposed: 0 };
    const escapeProvider = testSshProvider(escapeTracker, {
      realPaths: { '/workspaces/shared': '/outside/shared' },
    });
    await expect(
      escapeProvider.attach({
        externalId: 'shared',
        root: '/workspaces/shared',
      }),
    ).rejects.toThrow(/outside its configured provider root/);
    expect(escapeTracker.disposed).toBe(1);
  });

  it('does not report an SSH workspace deleted when rm fails', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker, { failRemove: true });
    const workspace: WorkspaceResource = {
      providerId: 'test-ssh',
      externalId: 'managed',
      root: '/workspaces/managed',
      metadata: {
        host: 'ssh.test',
        username: 'user',
        managedInfrastructure: false,
        managedDirectory: true,
        providerRoot: '/workspaces',
        privateHome: '/workspaces/.neondeck-homes/managed',
      },
    };
    await expect(provider.destroy(workspace)).rejects.toThrow(/cleanup failed/);
    expect(tracker).toEqual({ connected: 1, disposed: 1 });
  });

  it('normalizes remote roots and rejects relative or filesystem-root config', () => {
    const config = parseAppConfig(
      {
        version: 1,
        workspaces: {
          providers: {
            remote: {
              driver: 'ssh',
              hostEnv: 'NEONDECK_TEST_SSH_HOST',
              privateKeyEnv: 'NEONDECK_TEST_SSH_KEY',
              remoteRoot: '/srv/neondeck/../workspaces/',
            },
          },
        },
      },
      'test-config.json',
    );
    expect(config.workspaces?.providers?.remote).toMatchObject({
      remoteRoot: '/srv/workspaces',
    });
    for (const remoteRoot of ['relative/workspaces', '/']) {
      expect(() =>
        parseAppConfig(
          {
            version: 1,
            workspaces: {
              providers: {
                remote: {
                  driver: 'ssh',
                  hostEnv: 'NEONDECK_TEST_SSH_HOST',
                  privateKeyEnv: 'NEONDECK_TEST_SSH_KEY',
                  remoteRoot,
                },
              },
            },
          },
          'test-config.json',
        ),
      ).toThrow(/absolute, non-root POSIX directory/);
    }
  });

  it('fails closed for missing SSH keys and rejects ambiguous hosts', async () => {
    process.env.NEONDECK_HOST_VALIDATION_HOST = ' ssh://user@host/path ';
    delete process.env.NEONDECK_HOST_VALIDATION_KEY;
    const provider = remoteWorkspaceProvider({
      id: 'validated-ssh',
      config: {
        driver: 'ssh',
        hostEnv: 'NEONDECK_HOST_VALIDATION_HOST',
        privateKeyEnv: 'NEONDECK_HOST_VALIDATION_KEY',
        remoteRoot: '/workspaces',
      },
    });
    expect(provider.descriptor.capabilities.commandCancellation).toBe(
      'orphan-possible',
    );
    await expect(provider.readiness()).resolves.toMatchObject({
      ready: false,
      missingEnvironment: ['NEONDECK_HOST_VALIDATION_KEY'],
    });
    process.env.NEONDECK_HOST_VALIDATION_KEY = join(
      process.cwd(),
      'package.json',
    );
    await expect(provider.readiness()).resolves.toMatchObject({
      ready: false,
      message: expect.stringMatching(/whitespace|hostname or IP/i),
    });
    expect(() =>
      provider.planProvision({ resourceId: 'run-one', lifecycle: 'per-run' }),
    ).toThrow(/whitespace|hostname or IP/i);

    process.env.NEONDECK_HOST_VALIDATION_HOST = '[2001:db8::1]';
    const ipv6 = provider.planProvision({
      resourceId: 'run-two',
      lifecycle: 'per-run',
    });
    expect(physicalRemoteResourceKey(ipv6)).toBe(
      'ssh://user@[2001:db8::1]:22/workspaces/run-two',
    );
  });

  it('keys generic SSH resources by canonical host and root', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker);
    const first = await provider.attach({
      externalId: 'alias-one',
      root: '/workspaces/one',
    });
    const second = await provider.attach({
      externalId: 'alias-two',
      root: '/workspaces/two',
    });
    const sameAsFirst = await provider.attach({
      externalId: 'another-alias',
      root: '/workspaces/one',
    });
    expect(first.externalId).not.toBe(second.externalId);
    expect(sameAsFirst.externalId).toBe(first.externalId);
  });

  it('maps generic SSH existing resource ids to safe provider children', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const provider = testSshProvider(tracker);
    await expect(
      provider.attach({ externalId: 'shared' }),
    ).resolves.toMatchObject({ root: '/workspaces/shared' });
    await expect(provider.attach({ externalId: '../outside' })).rejects.toThrow(
      /Unsafe workspace resource id/,
    );
  });

  it.each([
    ['exe.dev per-run', '/workspaces/run-one'],
    ['generic SSH reuse', '/workspaces/reusable'],
  ])(
    'clones %s repositories from inside the contained workspace root',
    async (_label, root) => {
      const executions: Array<{
        command: string;
        options: { cwd?: string } | undefined;
      }> = [];
      const env = {
        cwd: root,
        resolvePath: (path: string) => path,
        exec: async (command: string, options?: { cwd?: string }) => {
          executions.push({ command, options });
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        mkdir: async () => undefined,
      } as unknown as Sandbox;
      await cloneScheduledRepository(env, root, {
        owner: 'example',
        name: 'repo',
      });
      expect(executions).toEqual([
        {
          command:
            "git clone --no-checkout 'https://github.com/example/repo.git' .",
          options: expect.objectContaining({ cwd: root }),
        },
      ]);
    },
  );

  it('canonicalizes provisioned SSH roots before deriving physical identity', async () => {
    const firstTracker = { connected: 0, disposed: 0 };
    const secondTracker = { connected: 0, disposed: 0 };
    const first = testSshProvider(firstTracker, {
      id: 'first-alias',
      remoteRoot: '/workspaces',
      realPathPrefix: { from: '/workspaces', to: '/srv/neondeck' },
    });
    const second = testSshProvider(secondTracker, {
      id: 'second-alias',
      remoteRoot: '/alias',
      realPathPrefix: { from: '/alias', to: '/srv/neondeck' },
    });
    const firstResource = await first.provision({
      resourceId: 'run-one',
      lifecycle: 'per-run',
    });
    const secondResource = await second.provision({
      resourceId: 'run-one',
      lifecycle: 'per-run',
    });
    expect(firstResource.root).toBe('/srv/neondeck/run-one');
    expect(secondResource.root).toBe('/srv/neondeck/run-one');
    expect(physicalRemoteResourceKey(firstResource)).toBe(
      physicalRemoteResourceKey(secondResource),
    );
  });

  it('converges missing managed SSH cleanup and removes the private HOME', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const commands: string[] = [];
    const provider = testSshProvider(tracker, {
      commands,
      missingPaths: ['/workspaces/missing'],
    });
    const workspace = await provider.attach({
      externalId: 'missing',
      root: '/workspaces/missing',
    });
    workspace.metadata.managedDirectory = true;
    await expect(provider.inspect(workspace)).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(provider.destroy(workspace)).resolves.toBeUndefined();
    expect(
      commands.some((command) => command.includes("'/workspaces/missing'")),
    ).toBe(true);
    expect(
      commands.some((command) => command.includes('/.neondeck-homes/')),
    ).toBe(true);
  });

  it('preserves adopted SSH infrastructure while removing its private HOME', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const commands: string[] = [];
    const provider = testSshProvider(tracker, { commands });
    const workspace = await provider.attach({ externalId: 'shared' });
    await provider.destroy(workspace);
    const removeCommands = commands.filter((command) =>
      command.startsWith('rm -rf'),
    );
    expect(removeCommands).toHaveLength(1);
    expect(removeCommands[0]).toContain('/.neondeck-homes/');
    expect(removeCommands[0]).not.toContain("'/workspaces/shared'");
  });

  it('treats an absent SSH provider root as already cleaned up', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const commands: string[] = [];
    const provider = testSshProvider(tracker, {
      commands,
      missingPaths: ['/workspaces'],
    });
    const workspace = await provider.attach({ externalId: 'shared' });
    workspace.metadata.managedDirectory = true;
    await expect(provider.destroy(workspace)).resolves.toBeUndefined();
    expect(commands.filter((command) => command.startsWith('rm -rf'))).toEqual(
      [],
    );
  });

  it('cleans immutable attached canonical paths after a provider alias retargets', async () => {
    const tracker = { connected: 0, disposed: 0 };
    const commands: string[] = [];
    const realPathPrefix = { from: '/workspaces', to: '/srv/original' };
    const provider = testSshProvider(tracker, {
      commands,
      realPathPrefix,
    });
    const workspace = await provider.attach({ externalId: 'shared' });
    expect(workspace).toMatchObject({
      root: '/srv/original/shared',
      metadata: {
        providerRoot: '/srv/original',
        pathsCanonical: true,
      },
    });
    realPathPrefix.to = '/srv/retargeted';
    await provider.destroy(workspace);
    const cleanup = commands.filter((command) => command.startsWith('rm -rf'));
    expect(cleanup.join('\n')).toContain('/srv/original/.neondeck-homes/');
    expect(cleanup.join('\n')).not.toContain('/srv/retargeted');
  });
});

function testSshProvider(
  tracker: { connected: number; disposed: number },
  behavior: {
    id?: string;
    remoteRoot?: string;
    credentialAudit?: string;
    realPaths?: Record<string, string>;
    realPathPrefix?: { from: string; to: string };
    failRemove?: boolean;
    missingPaths?: string[];
    commands?: string[];
    failDisposeAfter?: number;
    uncertainPrivateHome?: boolean;
    uncertainExists?: boolean;
  } = {},
) {
  process.env.NEONDECK_TEST_SSH_HOST = 'ssh.test';
  process.env.NEONDECK_TEST_SSH_KEY = join(process.cwd(), 'package.json');
  return remoteWorkspaceProvider({
    id: behavior.id ?? 'test-ssh',
    config: {
      driver: 'ssh',
      hostEnv: 'NEONDECK_TEST_SSH_HOST',
      privateKeyEnv: 'NEONDECK_TEST_SSH_KEY',
      remoteRoot: behavior.remoteRoot ?? '/workspaces',
    },
    connectSsh: async () => {
      tracker.connected += 1;
      return {
        env: fakeRemoteEnv(behavior),
        dispose: async () => {
          tracker.disposed += 1;
          if (
            behavior.failDisposeAfter !== undefined &&
            tracker.disposed > behavior.failDisposeAfter
          ) {
            throw new Error('transport close failed with TOKEN=secret');
          }
        },
      };
    },
  });
}

function fakeRemoteEnv(behavior: {
  credentialAudit?: string;
  realPaths?: Record<string, string>;
  realPathPrefix?: { from: string; to: string };
  failRemove?: boolean;
  uncertainPrivateHome?: boolean;
  uncertainExists?: boolean;
  missingPaths?: string[];
  commands?: string[];
}): Sandbox {
  const unsupported = async (): Promise<never> => {
    throw new Error('Unexpected fake remote file operation.');
  };
  return {
    cwd: '/',
    resolvePath: (path) => path,
    async exec(command) {
      behavior.commands?.push(command);
      if (command.startsWith('set -eu;')) {
        return {
          stdout: behavior.credentialAudit ?? '',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.startsWith('realpath ')) {
        const candidate = command.match(/-- '([^']+)'/)?.[1] ?? '/';
        const prefixed =
          behavior.realPathPrefix &&
          (candidate === behavior.realPathPrefix.from ||
            candidate.startsWith(`${behavior.realPathPrefix.from}/`))
            ? `${behavior.realPathPrefix.to}${candidate.slice(behavior.realPathPrefix.from.length)}`
            : candidate;
        return {
          stdout: `${behavior.realPaths?.[candidate] ?? prefixed}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.startsWith('mkdir -p -- ') && behavior.uncertainPrivateHome) {
        return {
          stdout: '',
          stderr: 'remote private HOME setup timed out',
          exitCode: 124,
          uncertainty: {
            kind: 'timeout' as const,
            message:
              'Remote private HOME setup timed out without confirmed settlement.',
          },
        };
      }
      if (command.startsWith('rm -rf') && behavior.failRemove) {
        return { stdout: '', stderr: 'permission denied', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    readFile: unsupported,
    readFileBuffer: unsupported,
    writeFile: unsupported,
    stat: unsupported,
    readdir: unsupported,
    async exists(path) {
      if (behavior.uncertainExists) {
        throw new WorkspaceOperationUncertainError({
          kind: 'transport',
          operation: 'exists',
          message: 'Remote exists transport settlement was unknown.',
        });
      }
      return !behavior.missingPaths?.includes(path);
    },
    async mkdir() {},
    rm: unsupported,
  };
}

describe('scheduled workspace policy', () => {
  const base = {
    kind: 'repository' as const,
    repoId: 'repo',
    providerId: 'local',
    resource: { lifecycle: 'per-run' as const },
    revision: { ref: 'main', mode: 'latest-each-run' as const },
    git: { mode: 'run-branch' as const },
    authority: 'trusted-workspace' as const,
  };

  it('accepts safe defaults and generated persistent branch names', () => {
    expect(scheduledWorkspacePolicyIssue(base)).toBeUndefined();
    expect(
      scheduledWorkspacePolicyIssue({
        ...base,
        resource: { lifecycle: 'reuse-task' },
        revision: { ref: 'main', mode: 'continue' },
        git: { mode: 'task-branch' },
      }),
    ).toBeUndefined();
  });

  it('requires isolated run branches for parallel work and acknowledgement for direct branches', () => {
    expect(
      scheduledWorkspacePolicyIssue({
        ...base,
        resource: { lifecycle: 'reuse-task' },
        overlap: 'allow-parallel',
      }),
    ).toMatch(/Parallel runs/);
    expect(
      scheduledWorkspacePolicyIssue({
        ...base,
        resource: { lifecycle: 'reuse-task' },
        git: { mode: 'direct-branch', branch: 'main' },
      }),
    ).toMatch(/explicit acknowledgement/);
  });

  it('requires full pinned SHAs and rejects ambiguous task-branch revision modes', async () => {
    expect(
      scheduledWorkspacePolicyIssue({
        ...base,
        revision: { ref: 'main', mode: 'pinned', sha: 'deadbeef' },
      }),
    ).toBeUndefined();
    await expect(
      upsertScheduledTask({
        id: 'instruction:short-pinned-sha',
        spec: {
          kind: 'run-agent-instruction',
          prompt: 'Pinned.',
          target: { kind: 'agent' },
          skills: [],
          workspace: {
            ...base,
            revision: { ref: 'main', mode: 'pinned', sha: 'deadbeef' },
          },
        },
        trigger: { kind: 'interval', everySeconds: 300 },
      }),
    ).rejects.toThrow(/full 40- or 64-character commit SHA/);
    expect(
      scheduledWorkspacePolicyIssue({
        ...base,
        resource: { lifecycle: 'reuse-task' },
        git: { mode: 'task-branch' },
      }),
    ).toMatch(/require continue/);
  });
});

describe('scheduled workspace persistence', () => {
  it('returns completed shell results when command audit persistence fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-command-audit-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:audit-failure',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'audit',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'audit',
            root: '/tmp/audit',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      const lockOwner = `scheduled-run:${claim!.run.id}`;
      await acquireTaskWorkspaceLock(
        { workspaceId: workspace.id, taskId: claim!.task.id, owner: lockOwner },
        paths,
      );
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'session:audit',
          dispatchKey: claim!.run.id,
          dispatchPayload: {
            prompt: 'audit',
            taskId: claim!.task.id,
            runId: claim!.run.id,
            workspaceId: workspace.id,
            lockOwner,
          },
        },
        paths,
      );
      let deferred = false;
      let finishCommand: (() => void) | undefined;
      const baseEnvironment = {
        cwd: '/tmp/audit',
        resolvePath: (path: string) => path,
        exec: async () => {
          if (deferred) {
            await new Promise<void>((resolve) => {
              finishCommand = resolve;
            });
          }
          return {
            stdout: 'ghp_abcdefghijklmnopqrstuvwxyz',
            stderr: '',
            exitCode: 0,
          };
        },
        readFile: async () => '',
        readFileBuffer: async () => Buffer.alloc(0),
        writeFile: async () => undefined,
        stat: async () => ({ type: 'file', size: 0, mtimeMs: 0 }),
        readdir: async () => [],
        exists: async () => false,
        mkdir: async () => undefined,
        rm: async () => undefined,
      } as unknown as Sandbox;
      const sandbox = instrumentedWorkspaceSandbox(
        { createSandbox: async () => baseEnvironment },
        claim!.run.id,
        workspace.id,
        'trusted-workspace',
        lockOwner,
        paths,
        async () => {
          throw new Error('artifact store unavailable');
        },
      );
      const env = await sandbox.createSandbox({ id: 'audit' });
      expect(
        sandbox.tools?.(env, { subagents: {} }).map((tool) => tool.name),
      ).toEqual(['read', 'write', 'edit', 'grep', 'glob', 'bash']);
      const readOnly = instrumentedWorkspaceSandbox(
        { createSandbox: async () => baseEnvironment },
        claim!.run.id,
        workspace.id,
        'read-only',
        lockOwner,
        paths,
      );
      expect(
        readOnly.tools?.(env, { subagents: {} }).map((tool) => tool.name),
      ).toEqual(['read', 'grep', 'glob']);
      await expect(env.exec('printf token')).resolves.toEqual({
        stdout: 'ghp_abcdefghijklmnopqrstuvwxyz',
        stderr: '',
        exitCode: 0,
      });
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        providerError:
          'A completed command audit artifact could not be persisted.',
      });
      await updateTaskWorkspace(workspace.id, { providerError: null }, paths);
      deferred = true;
      const staleCommand = env.exec('npm test');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await releaseTaskWorkspaceLock(
        workspace.id,
        lockOwner,
        'retained',
        paths,
      );
      finishCommand?.();
      await expect(staleCommand).rejects.toThrow(/no longer owns workspace/);
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'retained',
        providerError: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('durably quarantines uncertain remote setup and read-only verbs while exists never throws', async () => {
    const operations = ['setup', 'exec', 'readFile', 'stat', 'exists'] as const;
    for (const operation of operations) {
      const home = await mkdtemp(
        join(tmpdir(), `neondeck-sandbox-uncertain-${operation}-`),
      );
      const paths = runtimePaths(home);
      try {
        const taskId = `instruction:sandbox-uncertain-${operation}`;
        await upsertScheduledTask(
          {
            id: taskId,
            spec: {
              kind: 'run-agent-instruction',
              prompt: 'exercise remote uncertainty',
              target: { kind: 'agent' },
              skills: [],
              workspace: {
                kind: 'repository',
                repoId: 'repo',
                providerId: 'remote',
                resource: { lifecycle: 'per-run' },
                revision: { ref: 'main', mode: 'latest-each-run' },
                git: { mode: 'run-branch' },
                authority: 'trusted-workspace',
              },
            },
            trigger: { kind: 'once', at: '2026-08-17T12:00:00.000Z' },
            nextRunAt: '2026-08-17T12:00:00.000Z',
          },
          paths,
        );
        const claim = (
          await claimDueScheduledTasks(
            paths,
            new Date('2026-08-17T12:00:00.000Z'),
          )
        ).find((candidate) => candidate.task.id === taskId)!;
        const runId = claim.run.id;
        const lockOwner = `scheduled-run:${runId}`;
        if (claim.task.spec.kind !== 'run-agent-instruction') {
          throw new Error('Expected an instruction task.');
        }
        const policy = claim.task.spec.workspace;
        if (!policy || policy.kind !== 'repository') {
          throw new Error('Expected a repository workspace policy.');
        }
        const workspace = await createTaskWorkspaceRecord(
          {
            taskId,
            runId,
            policy,
            resource: {
              providerId: 'remote',
              externalId: `uncertain-${operation}`,
              root: `/workspaces/uncertain-${operation}`,
              metadata: {},
            },
            status: 'preparing',
          },
          paths,
        );
        await acquireTaskWorkspaceLock(
          { workspaceId: workspace.id, taskId, owner: lockOwner },
          paths,
        );
        await activateScheduledTaskSubmission(
          {
            taskId,
            runId,
            claimId: claim.task.claimId ?? '',
            sessionId: `session:${operation}`,
            dispatchKey: runId,
            dispatchPayload: {
              prompt: 'exercise remote uncertainty',
              taskId,
              runId,
              workspaceId: workspace.id,
              lockOwner,
            },
          },
          paths,
        );
        const uncertain = () =>
          new WorkspaceOperationUncertainError(
            {
              kind: 'transport',
              operation,
              message: `${operation} transport settlement was unknown`,
            },
            'remote',
          );
        const baseEnvironment = {
          cwd: workspace.workspaceRoot,
          resolvePath: (path: string) => path,
          exec: async () => {
            if (operation === 'exec') throw uncertain();
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          readFile: async () => {
            if (operation === 'readFile') throw uncertain();
            return '';
          },
          readFileBuffer: async () => Buffer.alloc(0),
          writeFile: async () => undefined,
          stat: async () => {
            if (operation === 'stat') throw uncertain();
            return { type: 'file', size: 0, mtimeMs: 0 };
          },
          readdir: async () => [],
          exists: async () => {
            if (operation === 'exists') throw uncertain();
            return false;
          },
          mkdir: async () => undefined,
          rm: async () => undefined,
        } as unknown as Sandbox;
        const sandbox = instrumentedWorkspaceSandbox(
          {
            async createSandbox() {
              if (operation === 'setup') throw uncertain();
              return baseEnvironment;
            },
          },
          runId,
          workspace.id,
          'trusted-workspace',
          lockOwner,
          paths,
          undefined,
          'orphan-possible',
          {
            providerId: workspace.providerId,
            physicalResourceKey: workspace.physicalResourceKey,
          },
        );
        const attempt = sandbox
          .createSandbox({ id: operation })
          .then<unknown>((env) =>
            ({
              setup: async () => env,
              exec: () => env.exec('npm test'),
              readFile: () => env.readFile('README.md'),
              stat: () => env.stat('README.md'),
              exists: () => env.exists('README.md'),
            })[operation](),
          );
        const outcome = await attempt.then(
          (value) => ({ status: 'fulfilled', value }),
          (error: unknown) => ({ status: 'rejected', value: error }),
        );
        const uncertainOutcome = () => ({
          status: 'rejected',
          value: expect.any(WorkspaceOperationUncertainError),
        });
        expect(outcome).toEqual(
          {
            setup: uncertainOutcome(),
            exec: uncertainOutcome(),
            readFile: uncertainOutcome(),
            stat: uncertainOutcome(),
            exists: { status: 'fulfilled', value: false },
          }[operation],
        );
        await expect(
          readTaskWorkspace(workspace.id, paths),
        ).resolves.toMatchObject({ releaseFencedAt: expect.any(String) });
        await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual([
          expect.objectContaining({
            providerId: 'remote',
            physicalResourceKey: workspace.physicalResourceKey,
            sourceId: runId,
          }),
        ]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  it('fences duplicate collectors and permits expired collection recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-collection-lease-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:collection-lease',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'collect',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'session:collection',
          dispatchKey: claim!.run.id,
          dispatchPayload: {
            prompt: 'collect',
            taskId: claim!.task.id,
            runId: claim!.run.id,
            workspaceId: 'pending',
            lockOwner: `scheduled-run:${claim!.run.id}`,
          },
        },
        paths,
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'collection',
            root: '/tmp/collection',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      const lockOwner = `scheduled-run:${claim!.run.id}`;
      await acquireTaskWorkspaceLock(
        { workspaceId: workspace.id, taskId: claim!.task.id, owner: lockOwner },
        paths,
      );
      await expect(
        acquireTaskWorkspaceCollectionLease(
          {
            workspaceId: workspace.id,
            runId: claim!.run.id,
            lockOwner,
            owner: 'collector:one',
            ttlMs: 60_000,
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        acquireTaskWorkspaceCollectionLease(
          {
            workspaceId: workspace.id,
            runId: claim!.run.id,
            lockOwner,
            owner: 'collector:two',
          },
          paths,
        ),
      ).resolves.toBe(false);
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare(
          'UPDATE task_workspaces SET collection_expires_at = ? WHERE id = ?;',
        )
        .run('2020-01-01T00:00:00.000Z', workspace.id);
      database.close();
      await expect(
        acquireTaskWorkspaceCollectionLease(
          {
            workspaceId: workspace.id,
            runId: claim!.run.id,
            lockOwner,
            owner: 'collector:two',
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        finalizeTaskWorkspaceCollection(
          {
            runId: claim!.run.id,
            workspaceId: workspace.id,
            lockOwner,
            collectionOwner: 'collector:two',
            finalSha: 'f'.repeat(40),
            dirty: true,
            status: 'retained',
            retentionReason: 'Atomic fixture settled.',
            retainedAt: '2026-08-16T12:00:01.000Z',
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'retained',
        lockOwner: null,
        collectionOwner: null,
        finalSha: 'f'.repeat(40),
      });
      await expect(
        readTaskWorkspaceForRun(claim!.run.id, paths),
      ).resolves.toMatchObject({
        status: 'retained',
        lockOwner: null,
        collectionOwner: null,
        finalSha: 'f'.repeat(40),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('rejects malformed lifecycle data at live-row and snapshot DB boundaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-workspace-parse-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:strict-row',
          runId: 'scheduled-task-run:strict-row',
          policy,
          resource: {
            providerId: 'local',
            externalId: 'strict-row',
            root: '/workspace/strict-row',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare(
          'UPDATE scheduled_run_workspace_snapshots SET snapshot_json = ? WHERE run_id = ?;',
        )
        .run('{}', 'scheduled-task-run:strict-row');
      database.close();
      await expect(
        readTaskWorkspaceForRun('scheduled-task-run:strict-row', paths),
      ).rejects.toThrow(/Invalid (key|type)|workspace/i);

      const secondDatabase = openDb(paths.neondeckDatabase);
      secondDatabase
        .prepare('UPDATE task_workspaces SET authority = ? WHERE id = ?;')
        .run('root', workspace.id);
      secondDatabase.close();
      await expect(readTaskWorkspace(workspace.id, paths)).rejects.toThrow(
        /Invalid (key|type)|workspace/i,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('records exact revision state, locks, and run artifacts without replacing the row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-workspace-store-'));
    const paths = runtimePaths(home);
    try {
      const policy = {
        kind: 'repository' as const,
        repoId: 'repo',
        providerId: 'local',
        resource: { lifecycle: 'per-run' as const },
        revision: { ref: 'main', mode: 'latest-each-run' as const },
        git: { mode: 'run-branch' as const },
        authority: 'trusted-workspace' as const,
      };
      await upsertScheduledTask(
        {
          id: 'instruction:persisted-workspace',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Check the repository.',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'worktree:test',
            root: '/workspace',
            metadata: {},
          },
        },
        paths,
      );
      expect(
        await acquireTaskWorkspaceLock(
          { workspaceId: workspace.id, taskId: claim!.task.id, owner: 'run' },
          paths,
        ),
      ).toBe(true);
      await updateTaskWorkspace(
        workspace.id,
        { baseSha: 'a'.repeat(40), branchName: 'neondeck/schedules/test/run' },
        paths,
      );
      expect(await readTaskWorkspace(workspace.id, paths)).toMatchObject({
        lockOwner: 'run',
        baseSha: 'a'.repeat(40),
      });
      await expect(
        cleanupTaskRunWorkspace(claim!.run.id, {}, paths),
      ).resolves.toMatchObject({
        ok: false,
        requires: ['confirm'],
      });
      await expect(
        cleanupTaskRunWorkspace(claim!.run.id, { confirm: true }, paths),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('active or leased'),
      });
      await addScheduledRunArtifact(
        {
          runId: claim!.run.id,
          workspaceId: workspace.id,
          kind: 'command',
          summary: 'npm test ghp_abcdefghijklmnopqrstuvwxyz (0)',
          content: 'passed github_pat_abcdefghijklmnopqrstuvwxyz',
          truncated: false,
        },
        paths,
      );
      expect(await listScheduledRunArtifacts(claim!.run.id, paths)).toEqual([
        expect.objectContaining({
          kind: 'command',
          summary: expect.not.stringContaining('ghp_'),
          content: 'passed [redacted-github-token]',
        }),
      ]);
      await releaseTaskWorkspaceLock(workspace.id, 'run', 'retained', paths);
      expect(await readTaskWorkspace(workspace.id, paths)).toMatchObject({
        lockOwner: null,
        status: 'retained',
      });
      await expect(removeTask(claim!.task.id, paths)).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('linked workspace still exists'),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('deletes run workspace snapshots when their scheduled task is deleted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-snapshot-delete-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:delete-snapshot',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Create a workspace snapshot.',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'delete-snapshot',
            root: '/workspace/delete-snapshot',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      await updateTaskWorkspace(
        workspace.id,
        { status: 'deleted', deletedAt: new Date().toISOString() },
        paths,
      );
      await settleScheduledTaskRun(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          status: 'failed',
          outcome: 'failed',
          message: 'Fixture settled.',
        },
        paths,
      );
      await expect(removeTask(claim!.task.id, paths)).resolves.toMatchObject({
        ok: true,
      });
      const database = openDb(paths.neondeckDatabase, { readOnly: true });
      const row = database
        .prepare(
          'SELECT COUNT(*) AS count FROM scheduled_run_workspace_snapshots WHERE run_id = ?;',
        )
        .get(claim!.run.id) as { count: number };
      database.close();
      expect(row.count).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('serializes a shared physical provider workspace across different tasks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-workspace-lock-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'shared-ssh',
      resource: {
        lifecycle: 'existing' as const,
        existingResourceId: 'shared',
      },
      revision: { ref: 'main', mode: 'continue' as const },
      git: { mode: 'task-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      for (const id of ['instruction:one', 'instruction:two']) {
        await upsertScheduledTask(
          {
            id,
            spec: {
              kind: 'run-agent-instruction',
              prompt: id,
              target: { kind: 'agent' },
              skills: [],
              workspace: policy,
            },
            trigger: { kind: 'interval', everySeconds: 300 },
          },
          paths,
        );
      }
      const first = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:one',
          runId: 'run:one',
          policy,
          resource: {
            providerId: 'shared-ssh',
            externalId: 'shared',
            root: '/workspaces/shared-second-root',
            metadata: {},
          },
        },
        paths,
      );
      const second = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:two',
          runId: 'run:two',
          policy,
          resource: {
            providerId: 'shared-ssh',
            externalId: 'shared',
            root: '/workspaces/shared',
            metadata: {},
          },
        },
        paths,
      );
      await expect(
        acquireTaskWorkspaceLock(
          { workspaceId: first.id, taskId: first.taskId, owner: 'run:one' },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        acquireTaskWorkspaceLock(
          { workspaceId: second.id, taskId: second.taskId, owner: 'run:two' },
          paths,
        ),
      ).resolves.toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('allows one task to lease distinct per-run workspaces in parallel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-parallel-locks-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
      overlap: 'allow-parallel' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:parallel',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'parallel',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
        },
        paths,
      );
      const workspaces = await Promise.all(
        ['one', 'two'].map((suffix) =>
          createTaskWorkspaceRecord(
            {
              taskId: 'instruction:parallel',
              runId: `run:${suffix}`,
              policy,
              resource: {
                providerId: 'remote',
                externalId: suffix,
                root: `/workspaces/${suffix}`,
                metadata: {},
              },
            },
            paths,
          ),
        ),
      );
      await expect(
        acquireTaskWorkspaceLock(
          {
            workspaceId: workspaces[0]!.id,
            taskId: 'instruction:parallel',
            owner: 'run:one',
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        acquireTaskWorkspaceLock(
          {
            workspaceId: workspaces[1]!.id,
            taskId: 'instruction:parallel',
            owner: 'run:two',
          },
          paths,
        ),
      ).resolves.toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses to resurrect an expired run lease while preventing physical reacquisition', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-workspace-heartbeat-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:heartbeat',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Long running task.',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const owner = `scheduled-run:${claim!.run.id}`;
      const first = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'same-physical',
            root: '/workspaces/one',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      const second = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:other',
          runId: 'scheduled-task-run:other',
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'same-physical',
            root: '/workspaces/one',
            metadata: {},
          },
          status: 'ready',
        },
        paths,
      );
      await acquireTaskWorkspaceLock(
        {
          workspaceId: first.id,
          taskId: first.taskId,
          owner,
          ttlMs: 1,
        },
        paths,
      );
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'scheduled-workspace:heartbeat',
          dispatchKey: claim!.run.id,
          dispatchPayload: {
            prompt: 'Long running task.',
            taskId: claim!.task.id,
            runId: claim!.run.id,
            workspaceId: first.id,
            cwd: first.workspaceRoot,
            lockOwner: owner,
          },
        },
        paths,
      );
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare('UPDATE task_workspaces SET lock_expires_at = ? WHERE id = ?;')
        .run('2020-01-01T00:00:00.000Z', first.id);
      database.close();
      await expect(
        acquireTaskWorkspaceLock(
          {
            workspaceId: second.id,
            taskId: second.taskId,
            owner: 'other-run',
          },
          paths,
        ),
      ).resolves.toBe(false);
      await expect(
        renewTaskWorkspaceLock(
          { workspaceId: first.id, runId: claim!.run.id, owner },
          paths,
        ),
      ).resolves.toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps immutable per-run workspace snapshots when a reusable row advances', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-run-snapshots-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: { lifecycle: 'reuse-task' as const },
      revision: { ref: 'main', mode: 'continue' as const },
      git: { mode: 'task-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:snapshots',
          runId: 'scheduled-task-run:one',
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'physical',
            root: '/workspaces/physical',
            metadata: {},
          },
          status: 'ready',
        },
        paths,
      );
      await updateTaskWorkspace(
        workspace.id,
        {
          baseSha: 'a'.repeat(40),
          initialSha: 'a'.repeat(40),
          finalSha: 'b'.repeat(40),
          branchName: 'neondeck/schedules/snapshots',
          status: 'retained',
        },
        paths,
      );
      await bindReusableWorkspaceToRun(
        workspace.id,
        'scheduled-task-run:two',
        paths,
      );
      await updateTaskWorkspace(
        workspace.id,
        {
          baseSha: 'c'.repeat(40),
          initialSha: 'c'.repeat(40),
          finalSha: 'd'.repeat(40),
        },
        paths,
      );
      await expect(
        readTaskWorkspaceForRun('scheduled-task-run:one', paths),
      ).resolves.toMatchObject({
        baseSha: 'a'.repeat(40),
        finalSha: 'b'.repeat(40),
      });
      await expect(
        readTaskWorkspaceForRun('scheduled-task-run:two', paths),
      ).resolves.toMatchObject({
        baseSha: 'c'.repeat(40),
        finalSha: 'd'.repeat(40),
      });
      await expect(
        retainTaskWorkspace(
          workspace.id,
          'scheduled-task-run:one',
          'Historical retain must lose the CAS.',
          paths,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prevents acquisition while an atomic cleanup lease is held', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-lease-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:cleanup-race',
          runId: 'scheduled-task-run:cleanup-race',
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'cleanup-race',
            root: '/workspaces/cleanup-race',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      await expect(
        acquireTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owningRunId: workspace.owningRunId!,
            owner: 'cleanup-owner',
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        acquireTaskWorkspaceLock(
          {
            workspaceId: workspace.id,
            taskId: workspace.taskId,
            owner: 'late-run',
          },
          paths,
        ),
      ).resolves.toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('renews cleanup leases and fences a stale cleaner after takeover', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-fence-'));
    const paths = runtimePaths(home);
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:cleanup-fence',
          runId: 'scheduled-task-run:cleanup-fence',
          policy: {
            kind: 'repository',
            repoId: 'repo',
            providerId: 'remote',
            resource: { lifecycle: 'per-run' },
            revision: { ref: 'main', mode: 'latest-each-run' },
            git: { mode: 'run-branch' },
            authority: 'trusted-workspace',
          },
          resource: {
            providerId: 'remote',
            externalId: 'cleanup-fence',
            root: '/workspaces/cleanup-fence',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      await expect(
        acquireTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owningRunId: workspace.owningRunId!,
            owner: 'cleaner:one',
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        renewTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owningRunId: workspace.owningRunId!,
            owner: 'cleaner:one',
          },
          paths,
        ),
      ).resolves.toBe(true);
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare('UPDATE task_workspaces SET lock_expires_at = ? WHERE id = ?;')
        .run('2020-01-01T00:00:00.000Z', workspace.id);
      database
        .prepare(
          `UPDATE app_metadata SET value = json_set(value, '$.expiresAt', ?)
           WHERE key = ?;`,
        )
        .run(
          '2020-01-01T00:00:00.000Z',
          `workspace-resource-lease:${workspace.physicalResourceKey}`,
        );
      database.close();
      await expect(
        acquireTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owningRunId: workspace.owningRunId!,
            owner: 'cleaner:two',
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        finalizeTaskWorkspaceCleanup(
          {
            workspaceId: workspace.id,
            owningRunId: workspace.owningRunId!,
            owner: 'cleaner:one',
            status: 'deleted',
            deletedAt: new Date().toISOString(),
            providerError: null,
          },
          paths,
        ),
      ).resolves.toBeUndefined();
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'cleanup-pending',
        lockOwner: 'cleaner:two',
      });
      await expect(
        finalizeTaskWorkspaceCleanup(
          {
            workspaceId: workspace.id,
            owningRunId: workspace.owningRunId!,
            owner: 'cleaner:two',
            status: 'deleted',
            deletedAt: new Date().toISOString(),
            providerError: null,
          },
          paths,
        ),
      ).resolves.toMatchObject({ status: 'deleted', lockOwner: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses historical cleanup after a reusable workspace is rebound', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-run-fence-'));
    const paths = runtimePaths(home);
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:cleanup-run-fence',
          runId: 'scheduled-task-run:old',
          policy: {
            kind: 'repository',
            repoId: 'repo',
            providerId: 'remote',
            resource: { lifecycle: 'reuse-task' },
            revision: { ref: 'main', mode: 'continue' },
            git: { mode: 'task-branch' },
            authority: 'trusted-workspace',
          },
          resource: {
            providerId: 'remote',
            externalId: 'cleanup-run-fence',
            root: '/workspaces/cleanup-run-fence',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare(
          `UPDATE task_workspaces
           SET owning_run_id = 'scheduled-task-run:new'
           WHERE id = ?;`,
        )
        .run(workspace.id);
      database.close();
      await expect(
        acquireTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owningRunId: 'scheduled-task-run:old',
            owner: 'historical-cleaner',
          },
          paths,
        ),
      ).resolves.toBe(false);
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        owningRunId: 'scheduled-task-run:new',
        status: 'retained',
        lockOwner: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('actively loses a cleanup lease when renewal returns false', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-heartbeat-'));
    const paths = runtimePaths(home);
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:cleanup-heartbeat',
          runId: 'scheduled-task-run:cleanup-heartbeat',
          policy: {
            kind: 'repository',
            repoId: 'repo',
            providerId: 'remote',
            resource: { lifecycle: 'per-run' },
            revision: { ref: 'main', mode: 'latest-each-run' },
            git: { mode: 'run-branch' },
            authority: 'trusted-workspace',
          },
          resource: {
            providerId: 'remote',
            externalId: 'cleanup-heartbeat',
            root: '/workspaces/cleanup-heartbeat',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      await acquireTaskWorkspaceCleanupLease(
        {
          workspaceId: workspace.id,
          owningRunId: workspace.owningRunId!,
          owner: 'cleaner',
        },
        paths,
      );
      const heartbeat = startCleanupHeartbeat(
        workspace.id,
        workspace.owningRunId!,
        'cleaner',
        paths,
        {
          intervalMs: 1,
          renew: async () => false,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(heartbeat.signal.aborted).toBe(true);
      expect(() => heartbeat.assertLease()).toThrow(/lease was lost/i);
      heartbeat.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prevents a late failed run from overwriting a rebound workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-failure-fence-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'reuse-task' as const },
      revision: { ref: 'main', mode: 'continue' as const },
      git: { mode: 'task-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:failure-fence',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'fail late',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'session:failure-fence',
          dispatchKey: claim!.run.id,
          dispatchPayload: {
            prompt: 'fail late',
            taskId: claim!.task.id,
            runId: claim!.run.id,
            workspaceId: 'pending',
            lockOwner: `scheduled-run:${claim!.run.id}`,
          },
        },
        paths,
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'failure-fence',
            root: '/workspace/failure-fence',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      const oldOwner = `scheduled-run:${claim!.run.id}`;
      await acquireTaskWorkspaceLock(
        { workspaceId: workspace.id, taskId: claim!.task.id, owner: oldOwner },
        paths,
      );
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare(
          `UPDATE task_workspaces
           SET owning_run_id = ?, lock_owner = ?, status = 'active'
           WHERE id = ?;`,
        )
        .run('scheduled-task-run:new', 'scheduled-run:new', workspace.id);
      database.close();
      await expect(
        failTaskWorkspaceRunOwned(
          {
            workspaceId: workspace.id,
            runId: claim!.run.id,
            lockOwner: oldOwner,
            providerError: 'late failure',
            retentionReason: 'late failure',
          },
          paths,
        ),
      ).resolves.toBeUndefined();
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        owningRunId: 'scheduled-task-run:new',
        lockOwner: 'scheduled-run:new',
        status: 'active',
        providerError: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('allows the owning active run to acquire its post-collection cleanup lease', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-owned-cleanup-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:owned-cleanup',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Clean up after collection.',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'owned-cleanup',
            root: '/workspaces/owned-cleanup',
            metadata: {},
          },
          status: 'ready',
        },
        paths,
      );
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'scheduled-workspace:owned-cleanup',
          dispatchKey: claim!.run.id,
          dispatchPayload: {
            prompt: 'Clean up after collection.',
            taskId: claim!.task.id,
            runId: claim!.run.id,
            workspaceId: workspace.id,
            cwd: workspace.workspaceRoot,
            lockOwner: `scheduled-run:${claim!.run.id}`,
          },
        },
        paths,
      );
      await expect(
        acquireTaskWorkspaceCleanupLease(
          {
            workspaceId: workspace.id,
            owner: 'post-collection-cleanup',
            owningRunId: claim!.run.id,
          },
          paths,
        ),
      ).resolves.toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses the persisted provider snapshot when configured providers change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-adapter-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'removed-provider',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:missing-adapter',
          runId: 'scheduled-task-run:missing-adapter',
          policy,
          resource: {
            providerId: 'removed-provider',
            externalId: 'resource',
            root: '/workspaces/resource',
            metadata: {},
          },
          status: 'retained',
        },
        paths,
      );
      await cleanupTaskRunWorkspace(
        'scheduled-task-run:missing-adapter',
        { confirm: true },
        paths,
      );
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'cleanup-pending',
        lockOwner: null,
        providerError: expect.stringContaining('Cannot parse privateKey'),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('retains and unlocks preparation work abandoned before dispatch activation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-workspace-recovery-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:abandoned-preparation',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'prepare then crash',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'orphaned',
            root: '/workspace/orphaned',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      await acquireTaskWorkspaceLock(
        {
          workspaceId: workspace.id,
          taskId: claim!.task.id,
          owner: `scheduled-run:${claim!.run.id}`,
        },
        paths,
      );

      await runSchedulerTick(paths, new Date('2026-08-16T12:00:01.000Z'));
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'retained',
        lockOwner: null,
      });
      await expect(
        readScheduledTaskRun(claim!.run.id, paths),
      ).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(
        readScheduledTask(claim!.task.id, paths),
      ).resolves.toMatchObject({
        claimId: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recovers a pre-lock preparing row and terminalizes its claimed run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-prelock-recovery-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'local',
      resource: { lifecycle: 'per-run' as const },
      revision: { ref: 'main', mode: 'latest-each-run' as const },
      git: { mode: 'run-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:prelock-crash',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Crash before lock.',
            target: { kind: 'agent' },
            skills: [],
            workspace: policy,
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          policy,
          resource: {
            providerId: 'local',
            externalId: 'prelock',
            root: '/workspace/prelock',
            metadata: {},
          },
          status: 'preparing',
        },
        paths,
      );
      await runSchedulerTick(paths, new Date('2026-08-16T12:00:01.000Z'));
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'deleted',
        lockOwner: null,
      });
      await expect(
        readScheduledTaskRun(claim!.run.id, paths),
      ).resolves.toMatchObject({
        status: 'failed',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recovers an expired cleanup lease during scheduler startup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-cleanup-recovery-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: {
        lifecycle: 'existing' as const,
        existingResourceId: 'shared',
      },
      revision: { ref: 'main', mode: 'continue' as const },
      git: { mode: 'task-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:expired-cleanup',
          runId: 'scheduled-task-run:expired-cleanup',
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'shared',
            root: '/workspaces/shared',
            metadata: { managedInfrastructure: false },
          },
          status: 'retained',
        },
        paths,
      );
      const database = openDb(paths.neondeckDatabase);
      database
        .prepare(
          `UPDATE task_workspaces
           SET status = 'cleanup-pending', lock_owner = ?, lock_expires_at = ?
           WHERE id = ?;`,
        )
        .run('crashed-cleanup-owner', '2020-01-01T00:00:00.000Z', workspace.id);
      database.close();
      await expect(
        listRecoverableScheduledWorkspaceCleanups(
          paths,
          new Date('2026-08-16T12:00:00.000Z'),
        ),
      ).resolves.toHaveLength(1);
      await runSchedulerTick(paths, new Date('2026-08-16T12:00:00.000Z'));
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'cleanup-pending',
        lockOwner: null,
        providerError: expect.stringContaining('Cannot parse privateKey'),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('detaches adopted existing workspaces without deleting infrastructure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-existing-detach-'));
    const paths = runtimePaths(home);
    const policy = {
      kind: 'repository' as const,
      repoId: 'repo',
      providerId: 'remote',
      resource: {
        lifecycle: 'existing' as const,
        existingResourceId: 'shared',
      },
      revision: { ref: 'main', mode: 'continue' as const },
      git: { mode: 'task-branch' as const },
      authority: 'trusted-workspace' as const,
    };
    try {
      const workspace = await createTaskWorkspaceRecord(
        {
          taskId: 'instruction:existing-detach',
          runId: 'scheduled-task-run:existing-detach',
          policy,
          resource: {
            providerId: 'remote',
            externalId: 'shared-physical',
            root: '/workspaces/shared',
            metadata: { managedInfrastructure: false },
          },
          status: 'retained',
        },
        paths,
      );
      await expect(
        cleanupTaskRunWorkspace(
          'scheduled-task-run:existing-detach',
          { confirm: true },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('Cannot parse privateKey'),
      });
      await expect(
        readTaskWorkspace(workspace.id, paths),
      ).resolves.toMatchObject({
        status: 'cleanup-pending',
        providerError: expect.stringContaining('Cannot parse privateKey'),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function fakeProvider(id: string): WorkspaceProvider {
  return {
    descriptor: {
      id,
      label: id,
      location: 'remote',
      capabilities: {
        provision: true,
        attachExisting: true,
        persistentResources: true,
        snapshots: false,
        commandCancellation: 'native',
      },
    },
    validateConfig: () => ({ ok: true }),
    planProvision: ({ resourceId }) => ({
      providerId: id,
      externalId: resourceId,
      root: `/workspaces/${resourceId}`,
      metadata: {},
    }),
    readiness: async () => ({
      ready: true,
      message: 'ready',
      missingEnvironment: [],
    }),
    provision: async ({ resourceId }) => ({
      providerId: id,
      externalId: resourceId,
      root: '/workspace',
      metadata: { closed: false, destroyed: false },
    }),
    attach: async ({ externalId }) => ({
      providerId: id,
      externalId,
      root: '/workspace',
      metadata: { closed: false, destroyed: false },
    }),
    connect: async (resource) => ({
      env: {} as never,
      close: async () => {
        resource.metadata.closed = true;
      },
    }),
    sandbox: () => ({ createSandbox: async () => ({}) as never }),
    inspect: async () => ({ status: 'ready', message: 'ready' }),
    destroy: async (resource) => {
      resource.metadata.destroyed = true;
    },
  };
}
