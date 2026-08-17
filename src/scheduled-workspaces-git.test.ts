import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupScheduledWorkspace,
  credentialFreeRepositoryUrl,
  activateScheduledTaskSubmission,
  claimDueScheduledTasks,
  collectScheduledWorkspaceResult,
  cleanupTaskRunWorkspace,
  makeScheduledTaskDue,
  listScheduledRunArtifacts,
  maxPersistedScheduledArtifactBytes,
  prepareScheduledWorkspace,
  readTaskWorkspace,
  settleScheduledTaskRun,
  upsertScheduledTask,
  type ScheduledTaskRecord,
} from './modules/scheduled-tasks';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { createWorktree, readWorktreeRecord } from './modules/worktrees';
import { openDb } from './lib/sqlite';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('scheduled local Git workspace lifecycle', () => {
  it('rejects selected runtime skills that collide with workspace-discovered skills', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-skill-collision-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await mkdir(join(paths.skills, 'review'), { recursive: true });
    await writeFile(
      join(paths.skills, 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Runtime review.\n---\nUse runtime review.\n',
    );
    await mkdir(join(fixture.checkout, '.agents', 'skills', 'review'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.checkout, '.agents', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Workspace review.\n---\nUse workspace review.\n',
    );
    await git(fixture.checkout, ['add', '.agents/skills/review/SKILL.md']);
    await git(fixture.checkout, ['commit', '-m', 'add workspace skill']);
    await git(fixture.checkout, ['push', 'origin', 'main']);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const record = task('continue');
    if (record.spec.kind !== 'run-agent-instruction') {
      throw new Error('Expected agent instruction task fixture.');
    }
    record.spec.skills = ['review'];
    await upsertScheduledTask(
      {
        id: record.id,
        spec: record.spec,
        trigger: record.trigger,
        nextRunAt: new Date().toISOString(),
      },
      paths,
    );
    const [claim] = await claimDueScheduledTasks(paths, new Date());
    await expect(
      prepareScheduledWorkspace(claim!.task, claim!.run.id, paths),
    ).rejects.toThrow(/collide with workspace-discovered skills: review/i);
    await expect(
      listScheduledRunArtifacts(claim!.run.id, paths),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'response',
        content: expect.stringMatching(/workspace-discovered skills: review/i),
      }),
    ]);
  });

  it('fails provider readiness before recording or provisioning a workspace', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-readiness-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        workspaces: {
          providers: {
            remote: {
              driver: 'ssh',
              hostEnv: 'NEONDECK_TEST_MISSING_SCHEDULED_HOST',
              privateKeyEnv: 'NEONDECK_TEST_SCHEDULED_KEY',
              remoteRoot: '/srv/neondeck',
            },
          },
        },
      })}\n`,
    );
    const baseRecord = task('latest-each-run');
    process.env.NEONDECK_TEST_SCHEDULED_KEY = join(
      process.cwd(),
      'package.json',
    );
    if (baseRecord.spec.kind !== 'run-agent-instruction') {
      throw new Error('Expected an agent instruction fixture.');
    }
    const record: ScheduledTaskRecord = {
      ...baseRecord,
      spec: {
        ...baseRecord.spec,
        workspace: {
          ...(baseRecord.spec.workspace as Extract<
            NonNullable<typeof baseRecord.spec.workspace>,
            { kind: 'repository' }
          >),
          providerId: 'remote',
          resource: { lifecycle: 'per-run' },
          revision: { ref: 'main', mode: 'latest-each-run' },
          git: { mode: 'run-branch' },
        },
      },
    };
    await upsertScheduledTask(
      {
        id: record.id,
        spec: record.spec,
        trigger: record.trigger,
        nextRunAt: new Date().toISOString(),
      },
      paths,
    );
    const [claim] = await claimDueScheduledTasks(paths, new Date());
    await expect(
      prepareScheduledWorkspace(claim!.task, claim!.run.id, paths),
    ).rejects.toThrow(/NEONDECK_TEST_MISSING_SCHEDULED_HOST/);
    const database = openDb(paths.neondeckDatabase, { readOnly: true });
    try {
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM task_workspaces;')
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('bootstraps continue mode and continues a persistent task branch outside the primary checkout', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-workspace-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );

    const unrelated = await createWorktree(
      {
        repoId: 'repo',
        baseRef: 'main',
        headRef: 'neondeck/schedules/persistent-maintenance',
        headSha: fixture.mainSha,
        createdBy: 'neondeck',
      },
      paths,
    );
    if (!unrelated.ok || !('worktree' in unrelated)) {
      throw new Error(unrelated.message);
    }

    const firstAdmission = await prepareActiveWorkspace(
      task('continue'),
      paths,
    );
    const first = firstAdmission.prepared;
    expect(first).not.toBeNull();
    expect(first!.workspace.localWorktreeId).not.toBe(unrelated.worktree.id);
    expect(first!.workspace.workspaceRoot).not.toBe(fixture.checkout);
    expect(first!.workspace.baseSha).toBe(fixture.mainSha);
    expect(first!.workspace.branchName).toBe(
      'neondeck/schedules/persistent-maintenance',
    );

    const environment = await first!.sandbox.createSandbox({ id: 'first' });
    await expect(
      environment.exec('x=status; git "$x" --short', { cwd: first!.cwd }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await environment.writeFile('scheduled.txt', 'created by schedule\n');
    const commit = await environment.exec(
      "git add scheduled.txt && git commit -m 'scheduled maintenance'",
      { cwd: first!.cwd, timeoutMs: 10_000 },
    );
    expect({ exitCode: commit.exitCode, stderr: commit.stderr }).toMatchObject({
      exitCode: 0,
    });
    const committed = (
      await environment.exec('git rev-parse HEAD', { cwd: first!.cwd })
    ).stdout.trim();
    await collectScheduledWorkspaceResult(
      {
        runId: firstAdmission.runId,
        workspaceId: first!.workspace.id,
        lockOwner: first!.lockOwner,
        response: 'Maintenance committed.',
        failed: false,
      },
      paths,
    );
    await settleScheduledTaskRun(
      {
        taskId: firstAdmission.taskId,
        runId: firstAdmission.runId,
        claimId: '',
        status: 'completed',
        outcome: 'recorded',
        message: 'First workspace run completed.',
      },
      paths,
    );
    await expect(
      environment.exec('git status --short', { cwd: first!.cwd }),
    ).rejects.toThrow(/no longer owns workspace/);
    await expect(environment.exists('scheduled.txt')).resolves.toBe(false);

    await makeScheduledTaskDue(firstAdmission.taskId, paths);
    const secondAdmission = await prepareActiveWorkspace(
      task('continue'),
      paths,
      false,
    );
    const second = secondAdmission.prepared;
    expect(second).not.toBeNull();
    expect(second!.workspace.id).toBe(first!.workspace.id);
    expect(second!.workspace.initialSha).toBe(committed);
    expect(second!.workspace.branchName).toBe(first!.workspace.branchName);
    await collectScheduledWorkspaceResult(
      {
        runId: secondAdmission.runId,
        workspaceId: second!.workspace.id,
        lockOwner: second!.lockOwner,
        response: 'No further changes.',
        failed: false,
      },
      paths,
    );
    await settleScheduledTaskRun(
      {
        taskId: secondAdmission.taskId,
        runId: secondAdmission.runId,
        claimId: '',
        status: 'completed',
        outcome: 'recorded',
        message: 'Second workspace run completed.',
      },
      paths,
    );
    await expect(
      cleanupScheduledWorkspace(second!.workspace.id, paths, {
        owningRunId: secondAdmission.runId,
      }),
    ).resolves.toMatchObject({ status: 'deleted' });
    await expect(
      git(fixture.checkout, ['status', '--porcelain']),
    ).resolves.toBe('');
  });

  it('adopts, serializes, and detaches an existing local worktree without deleting it', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-adopted-local-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const adoptedPath = join(
      fixture.checkout,
      '.neondeck',
      'worktrees',
      'scheduled-adopted',
    );
    await mkdir(join(fixture.checkout, '.neondeck', 'worktrees'), {
      recursive: true,
    });
    await execFileAsync('git', [
      '-C',
      fixture.checkout,
      'worktree',
      'add',
      '-b',
      'scheduled-adopted',
      adoptedPath,
      'main',
    ]);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const adopted = await createWorktree(
      {
        repoId: 'repo',
        localPath: adoptedPath,
        adopted: true,
        storage: 'repo-local',
        createdBy: 'user',
        baseRef: 'main',
        headRef: 'scheduled-adopted',
      },
      paths,
    );
    if (!adopted.ok || !('worktree' in adopted)) {
      throw new Error(adopted.message);
    }
    const baseRecord = task('latest-each-run');
    if (baseRecord.spec.kind !== 'run-agent-instruction') {
      throw new Error('Expected an agent instruction fixture.');
    }
    const record: ScheduledTaskRecord = {
      ...baseRecord,
      spec: {
        ...baseRecord.spec,
        workspace: {
          kind: 'repository',
          repoId: 'repo',
          providerId: 'local',
          resource: {
            lifecycle: 'existing',
            existingResourceId: adopted.worktree.id,
          },
          revision: { ref: 'main', mode: 'latest-each-run' },
          git: {
            mode: 'direct-branch',
            branch: 'scheduled-adopted',
            acknowledgeDirectBranch: true,
          },
          authority: 'trusted-workspace',
        },
      },
    };
    const admission = await prepareActiveWorkspace(record, paths);
    await collectScheduledWorkspaceResult(
      {
        runId: admission.runId,
        workspaceId: admission.prepared!.workspace.id,
        lockOwner: admission.prepared!.lockOwner,
        response: 'Existing local worktree inspected.',
        failed: false,
      },
      paths,
    );
    await settleScheduledTaskRun(
      {
        taskId: admission.taskId,
        runId: admission.runId,
        claimId: '',
        status: 'completed',
        outcome: 'recorded',
        message: 'done',
      },
      paths,
    );
    await expect(
      cleanupTaskRunWorkspace(admission.runId, { confirm: true }, paths),
    ).resolves.toMatchObject({ ok: true });
    await expect(stat(adoptedPath)).resolves.toBeDefined();
    expect(readWorktreeRecord(adopted.worktree.id, paths)).toMatchObject({
      adopted: true,
      lifecycleStatus: 'ready',
      localPath: adopted.worktree.localPath,
    });
  });

  it('rejects non-adopted and workflow-owned existing local worktrees', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-existing-local-eligibility-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const managed = await createWorktree(
      {
        repoId: 'repo',
        baseRef: 'main',
        headRef: 'managed-existing',
        headSha: fixture.mainSha,
        createdBy: 'neondeck',
      },
      paths,
    );
    if (!managed.ok || !('worktree' in managed)) {
      throw new Error(managed.message);
    }
    await expect(
      prepareActiveWorkspace(
        existingLocalTask('reject-managed', managed.worktree.id),
        paths,
      ),
    ).rejects.toThrow(/explicitly adopted/);

    const adoptedPath = join(home, 'worktrees', 'workflow-owned');
    await git(fixture.checkout, [
      'worktree',
      'add',
      '--detach',
      adoptedPath,
      fixture.mainSha,
    ]);
    const workflowOwned = await createWorktree(
      {
        repoId: 'repo',
        localPath: adoptedPath,
        adopted: true,
        createdBy: 'user',
        workflowRunId: 'autopilot:active',
        baseRef: 'main',
        headRef: 'workflow-owned',
      },
      paths,
    );
    if (!workflowOwned.ok || !('worktree' in workflowOwned)) {
      throw new Error(workflowOwned.message);
    }
    await expect(
      prepareActiveWorkspace(
        existingLocalTask('reject-workflow', workflowOwned.worktree.id),
        paths,
      ),
    ).rejects.toThrow(/workflow-unowned/);
  });

  it('derives public credential-free GitHub clone URLs from repository identity', () => {
    const url = credentialFreeRepositoryUrl({
      owner: 'owner@example.test',
      name: 'repo with spaces',
    });
    expect(url).toBe(
      'https://github.com/owner%40example.test/repo%20with%20spaces.git',
    );
    expect(url).not.toMatch(/https:\/\/[^/]*@github/);
  });

  it('rejects credentialed or mismatched ambient origins before fetching', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-origin-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    await git(fixture.checkout, [
      'remote',
      'set-url',
      'origin',
      'https://token@github.com/example/repo.git',
    ]);
    await expect(
      prepareScheduledWorkspace(
        task('latest-each-run'),
        'scheduled-task-run:credentialed-origin',
        paths,
      ),
    ).rejects.toThrow(/does not match registered GitHub repository/);
  });

  it('collects large Git evidence within a cumulative persisted byte budget', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-evidence-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const admission = await prepareActiveWorkspace(runBranchTask(), paths);
    const prepared = admission.prepared!;
    const environment = await prepared.sandbox.createSandbox({ id: 'large' });
    await environment.writeFile(
      'large.txt',
      'x'.repeat(maxPersistedScheduledArtifactBytes * 2),
    );
    await collectScheduledWorkspaceResult(
      {
        runId: admission.runId,
        workspaceId: prepared.workspace.id,
        lockOwner: prepared.lockOwner,
        failed: false,
      },
      paths,
    );
    const patch = (
      await listScheduledRunArtifacts(admission.runId, paths)
    ).find((artifact) => artifact.kind === 'patch');
    expect(patch).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(patch?.content ?? '', 'utf8')).toBeLessThanOrEqual(
      maxPersistedScheduledArtifactBytes,
    );
  });

  it('removes generated per-run branches after successful automatic cleanup', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-branch-cleanup-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const admission = await prepareActiveWorkspace(runBranchTask(), paths);
    const prepared = admission.prepared!;
    await collectScheduledWorkspaceResult(
      {
        runId: admission.runId,
        workspaceId: prepared.workspace.id,
        lockOwner: prepared.lockOwner,
        response: 'No changes required.',
        failed: false,
      },
      paths,
    );
    await expect(
      git(fixture.checkout, [
        'branch',
        '--list',
        prepared.workspace.branchName!,
      ]),
    ).resolves.toBe('');
  });

  it('converges legacy local cleanup while retaining an unverifiable generated branch', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-legacy-branch-cleanup-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const admission = await prepareActiveWorkspace(runBranchTask(), paths);
    const prepared = admission.prepared!;
    const branch = prepared.workspace.branchName!;
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `UPDATE task_workspaces SET repo_snapshot_json = ? WHERE id = ?;`,
        )
        .run(
          JSON.stringify({
            verified: false,
            id: 'repo',
            github: {
              owner: 'legacy-unavailable',
              name: 'legacy-unavailable',
            },
            path: '/legacy-unavailable',
            defaultBranch: 'main',
          }),
          prepared.workspace.id,
        );
    } finally {
      database.close();
    }
    await collectScheduledWorkspaceResult(
      {
        runId: admission.runId,
        workspaceId: prepared.workspace.id,
        lockOwner: prepared.lockOwner,
        response: 'No changes required.',
        failed: false,
      },
      paths,
    );
    await expect(
      readTaskWorkspace(prepared.workspace.id, paths),
    ).resolves.toMatchObject({
      status: 'deleted',
      retentionReason: expect.stringContaining('branch'),
    });
    await expect(
      git(fixture.checkout, ['branch', '--list', branch]),
    ).resolves.toContain(branch);
    await expect(
      listScheduledRunArtifacts(admission.runId, paths),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'cleanup',
          summary: 'Legacy schedule branch retained',
        }),
      ]),
    );
  });

  it('refuses a local direct branch held by the primary checkout', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-workspace-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );

    await expect(
      prepareScheduledWorkspace(
        directTask(),
        'scheduled-task-run:direct-main',
        paths,
      ),
    ).rejects.toThrow(/already checked out.*primary checkout/i);
    await expect(
      git(fixture.checkout, ['status', '--porcelain']),
    ).resolves.toBe('');
  });

  it('requires an existing direct branch to exactly match a pinned commit', async () => {
    const fixture = await createRepositoryFixture();
    const home = await tempDirectory('neondeck-scheduled-workspace-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: fixture.checkout,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    const adoptedPath = join(home, 'worktrees', 'adopted-pinned');
    await git(fixture.checkout, [
      'worktree',
      'add',
      '--detach',
      adoptedPath,
      fixture.mainSha,
    ]);
    const created = await createWorktree(
      {
        repoId: 'repo',
        baseRef: 'main',
        headRef: 'scheduled-pinned',
        localPath: adoptedPath,
        adopted: true,
        createdBy: 'user',
      },
      paths,
    );
    if (!created.ok || !('worktree' in created)) {
      throw new Error(created.message);
    }
    await git(created.worktree.localPath, ['switch', '-c', 'scheduled-pinned']);
    await writeFile(join(created.worktree.localPath, 'ahead.txt'), 'ahead\n');
    await git(created.worktree.localPath, ['add', 'ahead.txt']);
    await git(created.worktree.localPath, [
      '-c',
      'user.email=neondeck@example.test',
      '-c',
      'user.name=Neondeck Test',
      'commit',
      '-m',
      'ahead of pin',
    ]);
    await expect(
      prepareScheduledWorkspace(
        pinnedDirectTask(created.worktree.id, fixture.mainSha),
        'scheduled-task-run:pinned-direct',
        paths,
      ),
    ).rejects.toThrow(/not pinned commit/);
  });
});

function task(
  revisionMode: 'latest-each-run' | 'continue',
): ScheduledTaskRecord {
  const now = '2026-08-16T12:00:00.000Z';
  return {
    id: 'instruction:persistent-maintenance',
    spec: {
      kind: 'run-agent-instruction',
      prompt: 'Perform scheduled maintenance.',
      target: { kind: 'agent' },
      skills: [],
      workspace: {
        kind: 'repository',
        repoId: 'repo',
        providerId: 'local',
        resource: { lifecycle: 'reuse-task' },
        revision: { ref: 'main', mode: revisionMode },
        git: { mode: 'task-branch' },
        authority: 'trusted-workspace',
      },
    },
    trigger: { kind: 'interval', everySeconds: 300 },
    enabled: true,
    nextRunAt: now,
    claimId: null,
    claimExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
  };
}

function runBranchTask(): ScheduledTaskRecord {
  const record = task('latest-each-run');
  return {
    ...record,
    id: 'instruction:bounded-evidence',
    spec: {
      kind: 'run-agent-instruction',
      prompt: 'Create large evidence.',
      target: { kind: 'agent' },
      skills: [],
      workspace: {
        kind: 'repository',
        repoId: 'repo',
        providerId: 'local',
        resource: { lifecycle: 'per-run' },
        revision: { ref: 'main', mode: 'latest-each-run' },
        git: { mode: 'run-branch' },
        authority: 'trusted-workspace',
      },
    },
  };
}

function existingLocalTask(
  id: string,
  worktreeId: string,
): ScheduledTaskRecord {
  const record = task('latest-each-run');
  return {
    ...record,
    id: `instruction:${id}`,
    spec: {
      kind: 'run-agent-instruction',
      prompt: 'Inspect the adopted checkout.',
      target: { kind: 'agent' },
      skills: [],
      workspace: {
        kind: 'repository',
        repoId: 'repo',
        providerId: 'local',
        resource: { lifecycle: 'existing', existingResourceId: worktreeId },
        revision: { ref: 'main', mode: 'latest-each-run' },
        git: {
          mode: 'direct-branch',
          branch:
            id === 'reject-managed' ? 'managed-existing' : 'workflow-owned',
          acknowledgeDirectBranch: true,
        },
        authority: 'trusted-workspace',
      },
    },
  };
}

async function prepareActiveWorkspace(
  record: ScheduledTaskRecord,
  paths: ReturnType<typeof runtimePaths>,
  create = true,
) {
  if (create) {
    await upsertScheduledTask(
      {
        id: record.id,
        spec: record.spec,
        trigger: record.trigger,
        nextRunAt: new Date().toISOString(),
      },
      paths,
    );
  }
  const [claim] = await claimDueScheduledTasks(paths, new Date());
  if (!claim)
    throw new Error('Expected the scheduled workspace to be claimed.');
  const prepared = await prepareScheduledWorkspace(
    claim.task,
    claim.run.id,
    paths,
  );
  if (!prepared) throw new Error('Expected a repository workspace.');
  await activateScheduledTaskSubmission(
    {
      taskId: claim.task.id,
      runId: claim.run.id,
      claimId: claim.task.claimId ?? '',
      sessionId: `scheduled-workspace:${claim.run.id}`,
      dispatchKey: claim.run.id,
      dispatchPayload: {
        prompt:
          record.spec.kind === 'run-agent-instruction'
            ? record.spec.prompt
            : '',
        taskId: claim.task.id,
        runId: claim.run.id,
        workspaceId: prepared.workspace.id,
        cwd: prepared.cwd,
        lockOwner: prepared.lockOwner,
      },
    },
    paths,
  );
  return { prepared, runId: claim.run.id, taskId: claim.task.id };
}

function directTask(): ScheduledTaskRecord {
  const record = task('latest-each-run');
  return {
    ...record,
    id: 'instruction:direct-main',
    spec: {
      kind: 'run-agent-instruction',
      prompt: 'Exercise direct branch safety.',
      target: { kind: 'agent' },
      skills: [],
      workspace: {
        kind: 'repository',
        repoId: 'repo',
        providerId: 'local',
        resource: { lifecycle: 'reuse-task' },
        revision: { ref: 'main', mode: 'latest-each-run' },
        git: {
          mode: 'direct-branch',
          branch: 'main',
          acknowledgeDirectBranch: true,
        },
        authority: 'trusted-workspace',
      },
    },
  };
}

function pinnedDirectTask(
  existingResourceId: string,
  sha: string,
): ScheduledTaskRecord {
  const record = directTask();
  return {
    ...record,
    id: 'instruction:pinned-direct',
    spec: {
      kind: 'run-agent-instruction',
      prompt: 'Verify pinned direct branch safety.',
      target: { kind: 'agent' },
      skills: [],
      workspace: {
        kind: 'repository',
        repoId: 'repo',
        providerId: 'local',
        resource: { lifecycle: 'existing', existingResourceId },
        revision: { ref: 'main', mode: 'pinned', sha },
        git: {
          mode: 'direct-branch',
          branch: 'scheduled-pinned',
          acknowledgeDirectBranch: true,
        },
        authority: 'trusted-workspace',
      },
    },
  };
}

async function createRepositoryFixture() {
  const root = await tempDirectory('neondeck-scheduled-workspace-repo-');
  const remote = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  await git(root, ['init', '--bare', remote]);
  await git(checkout, ['init']);
  await git(checkout, ['config', 'user.email', 'neondeck@example.test']);
  await git(checkout, ['config', 'user.name', 'Neondeck Test']);
  await git(checkout, ['branch', '-M', 'main']);
  await writeFile(join(checkout, 'README.md'), '# fixture\n');
  await git(checkout, ['add', 'README.md']);
  await git(checkout, ['commit', '-m', 'initial']);
  await git(checkout, ['remote', 'add', 'origin', remote]);
  await git(checkout, ['push', '-u', 'origin', 'main']);
  await git(checkout, [
    'config',
    `url.${remote}.insteadOf`,
    'https://github.com/example/repo.git',
  ]);
  await git(checkout, [
    'remote',
    'set-url',
    'origin',
    'https://github.com/example/repo.git',
  ]);
  const mainSha = await git(checkout, ['rev-parse', 'HEAD']);
  return { checkout, mainSha };
}

async function tempDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}
