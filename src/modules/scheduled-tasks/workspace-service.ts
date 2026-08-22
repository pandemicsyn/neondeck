import { basename, relative, resolve } from 'node:path';
import { realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Sandbox, SandboxFactory } from '@flue/runtime';
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from '@flue/runtime';
import { redactGitText, runUnattendedGit } from '../../lib/git';
import { sshCommandUncertainty } from '../../sandboxes/exedev';
import { redactExecutionOutput } from '../execution/utils';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { readRepoRegistrySnapshot } from '../repos';
import { selectedRuntimeSkillSessionSnapshotsSync } from '../runtime';
import {
  cleanupWorktrees,
  createScheduledTaskWorktree,
  readWorktreeRecord,
  releaseWorktreeLock,
} from '../worktrees';
import {
  captureWorkspaceProviderSnapshot,
  physicalRemoteResourceKey,
  workspaceProviderFromSnapshot,
  type WorkspaceProvider,
  type WorkspaceProviderSnapshot,
  type WorkspaceConnection,
  type WorkspaceResource,
  WorkspaceOperationUncertainError,
  isWorkspaceOperationUncertainError,
} from '../workspace-providers';
import type { ScheduledTaskRecord, ScheduledWorkspacePolicy } from './schemas';
import {
  boundedContent,
  maxPersistedScheduledArtifactBytes,
  sanitizedBoundedContent,
} from './content';
import {
  acquireTaskWorkspaceLock,
  acquireAndBindScheduledWorktreeLock,
  acquireTaskWorkspaceCollectionLease,
  acquireWorkspaceProviderCoordinator,
  assertTaskWorkspaceCollectionLeaseSync,
  acquireTaskWorkspaceCleanupLease,
  assertTaskWorkspaceCleanupLeaseSync,
  assertScheduledWorkspaceRunAuthorizedSync,
  addScheduledRunArtifact,
  bindReusableWorkspaceToRun,
  createTaskWorkspaceRecord,
  findReusableTaskWorkspace,
  listScheduledRunArtifacts,
  listOrphanedScheduledWorktreeProvisions,
  readTaskWorkspace,
  releaseWorkspaceProviderCoordinator,
  superviseWorkspaceProviderCoordinator,
  renewTaskWorkspaceCollectionLease,
  finalizeTaskWorkspaceCollection,
  finalizeTaskWorkspaceCleanup,
  finalizeSuccessfulTaskWorkspaceCleanup,
  failTaskWorkspaceRunOwned,
  fenceTaskWorkspacePhysicalRelease,
  quarantinePhysicalWorkspace,
  readPhysicalWorkspaceQuarantine,
  recordTaskWorkspaceAuditFailureOwned,
  renewTaskWorkspaceCleanupLease,
  updateTaskWorkspace,
  type TaskWorkspaceRecord,
} from './workspace-store';

const commandTimeoutMs = 10 * 60 * 1_000;
const scheduledRunAbortControllers = new Map<string, AbortController>();
const scheduledWorkspaceReleaseForbidden = new Set<string>();
const durablyHandledWorkspaceUncertainties =
  new WeakSet<WorkspaceOperationUncertainError>();

function scheduledWorkspaceRunKey(runId: string, workspaceId: string) {
  return `${runId}\n${workspaceId}`;
}

export function invalidateScheduledWorkspaceRun(input: {
  workspaceId: string;
  runId: string;
}) {
  const key = scheduledWorkspaceRunKey(input.runId, input.workspaceId);
  scheduledRunAbortControllers
    .get(key)
    ?.abort(new Error('Scheduled workspace lease was lost.'));
  scheduledRunAbortControllers.delete(key);
}

async function persistScheduledWorkspaceUncertainty(
  input: {
    error: WorkspaceOperationUncertainError;
    workspaceId: string;
    runId: string;
    lockOwner: string;
    providerId: string;
    physicalResourceKey: string;
  },
  paths: RuntimePaths,
) {
  if (durablyHandledWorkspaceUncertainties.has(input.error)) return;
  const runKey = scheduledWorkspaceRunKey(input.runId, input.workspaceId);
  scheduledWorkspaceReleaseForbidden.add(runKey);
  scheduledRunAbortControllers.get(runKey)?.abort(input.error);
  let fenceError: unknown;
  try {
    const fenced = await fenceTaskWorkspacePhysicalRelease(
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        lockOwner: input.lockOwner,
      },
      paths,
    );
    if (!fenced) {
      throw new Error(
        'Scheduled workspace release fence lost its exact run owner.',
      );
    }
  } catch (error) {
    fenceError = error;
  }
  try {
    await quarantinePhysicalWorkspace(
      {
        physicalResourceKey: input.physicalResourceKey,
        providerId: input.providerId,
        source: 'scheduled-run',
        sourceId: input.runId,
        reason: `${input.error.uncertainty.operation}: ${input.error.uncertainty.message}`,
      },
      paths,
    );
    durablyHandledWorkspaceUncertainties.add(input.error);
  } catch (quarantineError) {
    throw new AggregateError(
      [input.error, ...(fenceError ? [fenceError] : []), quarantineError],
      'Remote operation was uncertain and its durable quarantine could not be recorded; the physical lease was preserved for recovery.',
    );
  }
  if (fenceError) {
    console.warn(
      `[neondeck] physical workspace was quarantined after its release fence could not be persisted: ${safeWorkspaceError(fenceError)}`,
    );
  }
}

export type PreparedScheduledWorkspace = {
  workspace: TaskWorkspaceRecord;
  cwd: string;
  sandbox: SandboxFactory;
  lockOwner: string;
};

export async function prepareScheduledWorkspace(
  task: ScheduledTaskRecord,
  runId: string,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedScheduledWorkspace | null> {
  if (task.spec.kind !== 'run-agent-instruction') return null;
  const policy = task.spec.workspace;
  if (!policy || policy.kind === 'virtual') return null;
  await ensureRuntimeHome(paths);
  let provider!: WorkspaceProvider;
  let providerSnapshot!: WorkspaceProviderSnapshot;
  const lockOwner = `scheduled-run:${runId}`;
  const coordinatorOwner = `workspace-admission:${randomUUID()}`;
  if (!(await acquireWorkspaceProviderCoordinator(coordinatorOwner, paths))) {
    throw new Error(
      'Repository or workspace-provider configuration is being updated. Retry admission shortly.',
    );
  }
  const coordinatorLease = superviseWorkspaceProviderCoordinator(
    coordinatorOwner,
    paths,
  );
  let repo: Awaited<
    ReturnType<typeof readRepoRegistrySnapshot>
  >['repos'][number];
  let workspace: TaskWorkspaceRecord | undefined;
  try {
    coordinatorLease.assertLease();
    const selectedRepo = (await readRepoRegistrySnapshot(paths)).repos.find(
      (candidate) => candidate.id === policy.repoId,
    );
    if (!selectedRepo) {
      throw new Error(`Repository "${policy.repoId}" is not configured.`);
    }
    repo = selectedRepo;
    workspace =
      policy.resource.lifecycle === 'per-run'
        ? undefined
        : await findReusableTaskWorkspace(task.id, paths);

    if (workspace) {
      providerSnapshot = workspace.providerSnapshot;
      provider = workspaceProviderFromSnapshot(providerSnapshot, paths);
      if (
        workspace.providerId !== policy.providerId ||
        workspace.repoId !== policy.repoId ||
        workspace.lifecycle !== policy.resource.lifecycle ||
        JSON.stringify(workspace.repoSnapshot) !==
          JSON.stringify(repositoryIdentity(repo))
      ) {
        throw new Error(
          'The reusable task workspace no longer matches the schedule policy or immutable repository identity. Clean it up before changing provider, repository, or lifecycle.',
        );
      }
      const readiness = await provider.readiness({
        lifecycle: policy.resource.lifecycle,
      });
      if (!readiness.ready) throw new Error(readiness.message);
      coordinatorLease.assertLease();
      await bindReusableWorkspaceToRun(workspace.id, runId, paths);
    } else {
      providerSnapshot = captureWorkspaceProviderSnapshot(
        policy.providerId,
        paths,
      );
      provider = workspaceProviderFromSnapshot(providerSnapshot, paths);
      const readiness = await provider.readiness({
        lifecycle: policy.resource.lifecycle,
      });
      if (!readiness.ready) throw new Error(readiness.message);
      coordinatorLease.assertLease();
      workspace = await provisionWorkspace(
        task,
        runId,
        policy,
        repo,
        provider,
        providerSnapshot,
        paths,
      );
      coordinatorLease.assertLease();
    }
  } finally {
    coordinatorLease.stop();
    await releaseWorkspaceProviderCoordinator(coordinatorOwner, paths);
  }
  if (!workspace) {
    throw new Error(
      'Scheduled workspace admission did not create a workspace.',
    );
  }

  if (
    workspace.providerId !== policy.providerId ||
    workspace.repoId !== policy.repoId
  ) {
    throw new Error(
      'The admitted workspace does not match the scheduled repository policy.',
    );
  }

  /*
   * Provider and repository configuration are now immutable snapshots on the
   * durable workspace row. Physical/worktree locking below no longer needs to
   * hold the config coordinator.
   */

  if (workspace.localWorktreeId) {
    const locked = await acquireAndBindScheduledWorktreeLock(
      {
        workspaceId: workspace.id,
        worktreeId: workspace.localWorktreeId,
        owner: lockOwner,
        runId,
        ttlMs: 7_200_000,
      },
      paths,
    );
    if (!locked.ok) {
      const message = `Lock is already held by ${locked.active.owner}.`;
      await retainPreparationFailure(workspace, message, paths);
      throw new Error(message);
    }
    workspace = (await readTaskWorkspace(workspace.id, paths)) ?? workspace;
  }

  const acquired = await acquireTaskWorkspaceLock(
    { workspaceId: workspace.id, taskId: task.id, owner: lockOwner },
    paths,
  );
  if (!acquired) {
    try {
      await releaseLocalWorktreeLock(workspace, lockOwner, paths);
    } catch (releaseError) {
      console.warn(
        `[neondeck] failed to release local worktree after physical lock conflict: ${safeWorkspaceError(releaseError)}`,
      );
    }
    await retainPreparationFailure(
      workspace,
      'The physical workspace is already locked by another run.',
      paths,
    );
    throw new Error(
      `Physical workspace ${workspace.providerResourceId} is already active for another scheduled or Autopilot run.`,
    );
  }

  const resource = workspaceResource(workspace);
  try {
    const connection = await provider.connect(resource);
    try {
      await assertCleanReusableWorkspace(connection.env, workspace);
      workspace = await prepareRepository(
        connection.env,
        workspace,
        policy,
        repo,
        runId,
        paths,
      );
      await assertNoWorkspaceSkillCollisions(
        connection.env,
        policy.subdirectory
          ? `${workspace.workspaceRoot}/${policy.subdirectory}`
          : workspace.workspaceRoot,
        task.spec.skills,
        paths,
      );
    } finally {
      await closeScheduledWorkspaceConnection(
        connection,
        {
          runId,
          workspaceId: workspace.id,
          preparationOwner: lockOwner,
          phase: 'preparation',
        },
        paths,
      );
    }
  } catch (error) {
    await quarantineWorkspaceIfUncertain(
      workspace,
      error,
      'preparation',
      runId,
      paths,
    );
    await failScheduledWorkspaceRun(
      {
        runId,
        workspaceId: workspace.id,
        lockOwner,
        message: `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      paths,
    );
    throw error;
  }

  return {
    workspace,
    cwd: policy.subdirectory
      ? `${workspace.workspaceRoot}/${policy.subdirectory}`
      : workspace.workspaceRoot,
    sandbox: instrumentedWorkspaceSandbox(
      provider.sandbox(resource),
      runId,
      workspace.id,
      policy.authority,
      lockOwner,
      paths,
    ),
    lockOwner,
  };
}

async function assertNoWorkspaceSkillCollisions(
  env: Sandbox,
  cwd: string,
  selectedSkillIds: readonly string[],
  paths: RuntimePaths,
) {
  if (selectedSkillIds.length === 0) return;
  const snapshots = selectedRuntimeSkillSessionSnapshotsSync(
    selectedSkillIds,
    paths,
  );
  const collisions: string[] = [];
  for (const snapshot of snapshots) {
    if (await env.exists(`${cwd}/.agents/skills/${snapshot.name}/SKILL.md`)) {
      collisions.push(snapshot.name);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Selected runtime skill names collide with workspace-discovered skills: ${collisions.join(', ')}. Remove the duplicate scheduled skill selection or rename the workspace skill.`,
    );
  }
}

async function provisionWorkspace(
  task: ScheduledTaskRecord,
  runId: string,
  policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>,
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  provider: WorkspaceProvider,
  providerSnapshot: WorkspaceProviderSnapshot,
  paths: RuntimePaths,
) {
  const resourceId = safeResourceName(
    `${taskSlug(task.id)}-${shortRunId(runId)}`,
  );

  if (policy.providerId === 'local') {
    if (policy.resource.lifecycle === 'existing') {
      const record = readWorktreeRecord(
        policy.resource.existingResourceId as string,
        paths,
      );
      const repoRoot = await realpath(repo.path);
      const worktreeRoot = await realpath(record.localPath);
      if (
        record.repoId !== policy.repoId ||
        record.lifecycleStatus !== 'ready' ||
        record.adopted !== true ||
        record.owningWorkflowRunId !== null ||
        record.createdBy === 'neondeck' ||
        record.createdBy === 'scheduled-task' ||
        worktreeRoot === repoRoot
      ) {
        throw new Error(
          'Existing local workspaces must be explicitly adopted, ready, workflow-unowned worktrees for the selected repository; the primary checkout is never eligible.',
        );
      }
      const resource = await provider.attach({
        externalId: record.id,
        root: record.localPath,
      });
      return createTaskWorkspaceRecord(
        {
          taskId: task.id,
          runId,
          policy,
          resource,
          providerSnapshot,
          repoSnapshot: repositoryIdentity(repo),
          physicalResourceKey: physicalResourceKey(resource),
          localWorktreeId: record.id,
          status: 'preparing',
        },
        paths,
      );
    }
    const baseSha = await resolveLocalBase(repo, policy);
    const branch = branchName(task.id, runId, policy);
    if (policy.git.mode === 'direct-branch') {
      await assertLocalDirectBranchAvailable(repo.path, '', branch);
    }
    const created = await createScheduledTaskWorktree(
      {
        repoId: policy.repoId,
        baseRef: policy.revision.ref,
        headRef: branch,
        headSha: baseSha,
        workflowRunId: runId,
      },
      paths,
    );
    if (!created.ok || !('worktree' in created)) {
      throw new Error(created.message);
    }
    const resource = await provider.attach({
      externalId: created.worktree.id,
      root: created.worktree.localPath,
    });
    let workspace: TaskWorkspaceRecord;
    try {
      workspace = await createTaskWorkspaceRecord(
        {
          taskId: task.id,
          runId,
          policy,
          resource,
          providerSnapshot,
          repoSnapshot: repositoryIdentity(repo),
          physicalResourceKey: physicalResourceKey(resource),
          localWorktreeId: created.worktree.id,
          status: 'preparing',
        },
        paths,
      );
    } catch (error) {
      await cleanupWorktrees(
        {
          worktreeId: created.worktree.id,
          force: true,
          confirmPreparedDiff: true,
        },
        paths,
      );
      throw error;
    }
    return updateTaskWorkspace(workspace.id, { baseSha }, paths);
  }

  let resource =
    policy.resource.lifecycle === 'existing'
      ? await provider.attach({
          externalId: policy.resource.existingResourceId as string,
        })
      : provider.planProvision({
          resourceId,
          lifecycle: policy.resource.lifecycle,
        });
  let workspace = await createTaskWorkspaceRecord(
    {
      taskId: task.id,
      runId,
      policy,
      resource,
      providerSnapshot,
      repoSnapshot: repositoryIdentity(repo),
      physicalResourceKey: physicalResourceKey(resource),
      status:
        policy.resource.lifecycle === 'existing' ? 'preparing' : 'provisioning',
    },
    paths,
  );
  if (policy.resource.lifecycle === 'existing') return workspace;
  try {
    const provisioned = await provider.provision({
      resourceId,
      lifecycle: policy.resource.lifecycle,
    });
    workspace = await updateTaskWorkspace(
      workspace.id,
      {
        workspaceRoot: provisioned.root,
        providerResourceId: provisioned.externalId,
        physicalResourceKey: physicalResourceKey(provisioned),
        resourceMetadata: provisioned.metadata,
        status: 'preparing',
      },
      paths,
    );
    return workspace;
  } catch (error) {
    if (
      isWorkspaceOperationUncertainError(error) ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      let fenceError: unknown;
      try {
        await fenceTaskWorkspacePhysicalRelease(
          { workspaceId: workspace.id, runId, lockOwner: null },
          paths,
        );
      } catch (caught) {
        fenceError = caught;
      }
      try {
        await quarantinePhysicalWorkspace(
          {
            physicalResourceKey: workspace.physicalResourceKey,
            providerId: workspace.providerId,
            source: 'preparation',
            sourceId: runId,
            reason:
              error instanceof Error
                ? error.message
                : 'Remote provisioning ended without confirmed settlement.',
          },
          paths,
        );
      } catch (quarantineError) {
        throw new AggregateError(
          [error, ...(fenceError ? [fenceError] : []), quarantineError],
          'Remote provisioning was uncertain and durable quarantine persistence failed; physical release remains fenced.',
        );
      }
      await updateTaskWorkspace(
        workspace.id,
        {
          status: 'cleanup-pending',
          providerError: error instanceof Error ? error.message : String(error),
          retentionReason:
            'Remote provisioning may still be mutating this resource; cleanup is blocked by durable quarantine until settlement is confirmed.',
          retainedAt: new Date().toISOString(),
        },
        paths,
      );
      throw error;
    }
    let recoveryError: string | null = null;
    try {
      await provider.destroy(resource);
    } catch (cleanupError) {
      recoveryError =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
    }
    const providerError =
      error instanceof Error ? error.message : String(error);
    await updateTaskWorkspace(
      workspace.id,
      {
        status: recoveryError ? 'cleanup-pending' : 'deleted',
        providerError: recoveryError
          ? `${providerError} Cleanup retry required: ${recoveryError}`
          : providerError,
        retentionReason: recoveryError
          ? 'Provider provisioning failed; durable cleanup intent remains pending.'
          : 'Provider provisioning failed and its recorded resource intent was cleaned up.',
        retainedAt: recoveryError ? new Date().toISOString() : null,
        deletedAt: recoveryError ? null : new Date().toISOString(),
      },
      paths,
    );
    throw error;
  }
}

function repositoryIdentity(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
) {
  return {
    verified: true,
    id: repo.id,
    github: { owner: repo.github.owner, name: repo.github.name },
    path: repo.path,
    defaultBranch: repo.defaultBranch,
  };
}

async function prepareRepository(
  env: Sandbox,
  workspace: TaskWorkspaceRecord,
  policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>,
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  runId: string,
  paths: RuntimePaths,
) {
  const branch = branchName(workspace.taskId, runId, policy);
  if (workspace.providerId === 'local' && policy.git.mode === 'direct-branch') {
    await assertLocalDirectBranchAvailable(
      repo.path,
      workspace.workspaceRoot,
      branch,
    );
  }
  if (!(await env.exists(`${workspace.workspaceRoot}/.git`))) {
    if (workspace.providerId === 'local') {
      throw new Error('Managed local worktree is missing its Git metadata.');
    }
    await cloneScheduledRepository(env, workspace.workspaceRoot, repo.github);
  }
  await assertSessionRepositoryOrigin(
    env,
    workspace.workspaceRoot,
    repo.github,
  );

  let baseSha = workspace.baseSha;
  if (policy.revision.mode !== 'continue') {
    baseSha = await resolveSessionBase(
      env,
      workspace.workspaceRoot,
      policy,
      repo.github,
    );
  } else if (!baseSha) {
    baseSha = await resolveSessionBase(
      env,
      workspace.workspaceRoot,
      policy,
      repo.github,
    );
  }

  await selectBranch(env, workspace, policy, branch, baseSha as string);
  const initialSha = await gitOutput(env, workspace.workspaceRoot, [
    'rev-parse',
    'HEAD',
  ]);
  const prepared = await updateTaskWorkspace(
    workspace.id,
    {
      status: 'active',
      branchName: branch,
      baseSha,
      initialSha,
      finalSha: initialSha,
      dirty: false,
      providerError: null,
    },
    paths,
  );
  return prepared;
}

export async function cloneScheduledRepository(
  env: Sandbox,
  workspaceRoot: string,
  repository: { owner: string; name: string },
) {
  const remoteUrl = credentialFreeRepositoryUrl(repository);
  await env.mkdir(workspaceRoot, { recursive: true });
  const clone = await env.exec(
    `git clone --no-checkout '${shellEscape(remoteUrl)}' .`,
    { cwd: workspaceRoot, timeoutMs: commandTimeoutMs },
  );
  assertCommandSucceeded(clone, 'Remote repository clone');
}

async function selectBranch(
  env: Sandbox,
  workspace: TaskWorkspaceRecord,
  policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>,
  branch: string,
  baseSha: string,
) {
  if (policy.revision.mode === 'continue' && workspace.branchName) {
    const current = await gitOutput(env, workspace.workspaceRoot, [
      'branch',
      '--show-current',
    ]);
    if (current !== workspace.branchName) {
      throw new Error(
        `Persistent workspace expected branch ${workspace.branchName}, found ${current || 'detached HEAD'}.`,
      );
    }
    return;
  }

  const exists = await gitResult(env, workspace.workspaceRoot, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (exists.exitCode === 0) {
    if (policy.git.mode === 'run-branch') {
      throw new Error(`Generated run branch ${branch} already exists.`);
    }
    await gitCommand(env, workspace.workspaceRoot, ['switch', branch]);
    const current = await gitOutput(env, workspace.workspaceRoot, [
      'rev-parse',
      'HEAD',
    ]);
    if (policy.git.mode === 'direct-branch' && current !== baseSha) {
      if (policy.revision.mode === 'pinned') {
        throw new Error(
          `Direct branch ${branch} is at ${current.slice(0, 12)}, not pinned commit ${baseSha.slice(0, 12)}. Select a matching dedicated branch before the next run.`,
        );
      }
      const fastForward = await gitResult(env, workspace.workspaceRoot, [
        'merge',
        '--ff-only',
        baseSha,
      ]);
      if (fastForward.exitCode !== 0) {
        throw new Error(
          `Direct branch ${branch} cannot fast-forward to resolved base ${baseSha.slice(0, 12)}. Resolve the divergence before the next run.`,
        );
      }
    }
    return;
  }
  await gitCommand(env, workspace.workspaceRoot, [
    'switch',
    '-c',
    branch,
    baseSha,
  ]);
}

async function resolveLocalBase(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>,
) {
  await assertLocalRepositoryOrigin(repo.path, repo.github);
  const canonicalRemote = credentialFreeRepositoryUrl(repo.github);
  if (policy.revision.mode === 'pinned') {
    const sha = policy.revision.sha as string;
    try {
      await runUnattendedGit(repo.path, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      await runUnattendedGit(repo.path, [
        'fetch',
        '--no-tags',
        canonicalRemote,
        policy.revision.ref,
      ]);
      await runUnattendedGit(repo.path, ['cat-file', '-e', `${sha}^{commit}`]);
    }
    const resolved = (
      await runUnattendedGit(repo.path, ['rev-parse', `${sha}^{commit}`])
    ).trim();
    if (resolved.toLowerCase() !== sha.toLowerCase()) {
      throw new Error(
        `Pinned revision resolved to ${resolved}, not the requested full commit ${sha}.`,
      );
    }
    return resolved;
  }
  await runUnattendedGit(repo.path, [
    'fetch',
    '--no-tags',
    canonicalRemote,
    policy.revision.ref,
  ]);
  return (
    await runUnattendedGit(repo.path, ['rev-parse', 'FETCH_HEAD^{commit}'])
  ).trim();
}

async function assertLocalDirectBranchAvailable(
  repoPath: string,
  selectedWorktreePath: string,
  branch: string,
) {
  const output = await runUnattendedGit(repoPath, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  let worktreePath = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length);
      continue;
    }
    if (
      line === `branch refs/heads/${branch}` &&
      worktreePath !== selectedWorktreePath
    ) {
      throw new Error(
        `Local direct branch ${branch} is already checked out at ${worktreePath}. Choose a schedule branch or an existing dedicated worktree; Neondeck will not mutate the primary checkout.`,
      );
    }
  }
}

async function resolveSessionBase(
  env: Sandbox,
  root: string,
  policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>,
  repository: { owner: string; name: string },
) {
  await assertSessionRepositoryOrigin(env, root, repository);
  const canonicalRemote = credentialFreeRepositoryUrl(repository);
  if (policy.revision.mode === 'pinned') {
    const sha = policy.revision.sha as string;
    const present = await gitResult(env, root, [
      'cat-file',
      '-e',
      `${sha}^{commit}`,
    ]);
    if (present.exitCode !== 0) {
      await gitCommand(env, root, [
        'fetch',
        '--no-tags',
        canonicalRemote,
        policy.revision.ref,
      ]);
    }
    const resolved = await gitOutput(env, root, [
      'rev-parse',
      `${sha}^{commit}`,
    ]);
    if (resolved.toLowerCase() !== sha.toLowerCase()) {
      throw new Error(
        `Pinned revision resolved to ${resolved}, not the requested full commit ${sha}.`,
      );
    }
    return resolved;
  }
  await gitCommand(env, root, [
    'fetch',
    '--no-tags',
    canonicalRemote,
    policy.revision.ref,
  ]);
  return gitOutput(env, root, ['rev-parse', 'FETCH_HEAD^{commit}']);
}

async function assertCleanReusableWorkspace(
  env: Sandbox,
  workspace: TaskWorkspaceRecord,
) {
  if (workspace.lifecycle === 'per-run') return;
  if (!(await env.exists(`${workspace.workspaceRoot}/.git`))) return;
  const status = await gitOutput(env, workspace.workspaceRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status) {
    throw new Error(
      'Reusable scheduled workspace has unresolved changes. Neondeck retained it without resetting or cleaning.',
    );
  }
}

export async function collectScheduledWorkspaceResult(
  input: {
    runId: string;
    workspaceId: string;
    lockOwner: string;
    response?: string;
    failed: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  try {
    return await collectScheduledWorkspaceResultInternal(input, paths);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('collection lease was lost')
    ) {
      return false;
    }
    const workspace = await readTaskWorkspace(input.workspaceId, paths);
    if (workspace) {
      await quarantineWorkspaceIfUncertain(
        workspace,
        error,
        'collection',
        input.runId,
        paths,
      );
    }
    await failScheduledWorkspaceRun(
      {
        ...input,
        message: `Workspace result collection failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      paths,
    );
    throw error;
  }
}

async function collectScheduledWorkspaceResultInternal(
  input: {
    runId: string;
    workspaceId: string;
    lockOwner: string;
    response?: string;
    failed: boolean;
  },
  paths: RuntimePaths,
) {
  const workspace = await readTaskWorkspace(input.workspaceId, paths);
  if (!workspace) {
    throw new Error(
      `Scheduled workspace "${input.workspaceId}" was not found during collection.`,
    );
  }
  const collectionOwner = `scheduled-collection:${randomUUID()}`;
  const acquired = await acquireTaskWorkspaceCollectionLease(
    { ...input, owner: collectionOwner },
    paths,
  );
  if (!acquired) {
    const current = await readTaskWorkspace(input.workspaceId, paths);
    return Boolean(
      current &&
      current.owningRunId === input.runId &&
      current.lockOwner === null &&
      current.collectionOwner === null &&
      ['retained', 'cleanup-pending', 'deleted', 'failed'].includes(
        current.status,
      ),
    );
  }
  const provider = workspaceProviderFromSnapshot(
    workspace.providerSnapshot,
    paths,
  );
  const heartbeat = setInterval(() => {
    void renewTaskWorkspaceCollectionLease(
      { workspaceId: workspace.id, runId: input.runId, owner: collectionOwner },
      paths,
    ).catch((error) =>
      console.warn(
        `[neondeck] scheduled collection lease renewal failed: ${safeWorkspaceError(error)}`,
      ),
    );
  }, 60_000);
  heartbeat.unref?.();
  const authorizeCollection = () =>
    assertTaskWorkspaceCollectionLeaseSync(
      { workspaceId: workspace.id, runId: input.runId, owner: collectionOwner },
      paths,
    );
  try {
    authorizeCollection();
    if (input.response !== undefined) {
      authorizeCollection();
      await addScheduledRunArtifact(
        {
          runId: input.runId,
          workspaceId: workspace.id,
          kind: 'response',
          summary: 'Final agent response',
          content: input.response,
          truncated: false,
          collectionOwner,
        },
        paths,
      );
    }

    let finalSha = workspace.initialSha;
    let dirty = false;
    let changed = false;
    const connection = await provider.connect(workspaceResource(workspace));
    try {
      authorizeCollection();
      finalSha = await gitOutput(connection.env, workspace.workspaceRoot, [
        'rev-parse',
        'HEAD',
      ]);
      const statusResult = await boundedGitCapture(
        connection.env,
        workspace.workspaceRoot,
        ['status', '--porcelain=v1', '--untracked-files=all', '-z', '--'],
        64 * 1024,
      );
      const status = formatNulGitStatus(statusResult.content);
      dirty = status.length > 0;
      changed = dirty || finalSha !== workspace.initialSha;
      authorizeCollection();
      await addScheduledRunArtifact(
        {
          runId: input.runId,
          workspaceId: workspace.id,
          kind: 'git-status',
          summary: dirty
            ? 'Workspace contains changes.'
            : 'Workspace is clean.',
          content: status || null,
          truncated: statusResult.truncated,
          collectionOwner,
        },
        paths,
      );
      if (changed && workspace.baseSha) {
        let remaining = maxPersistedScheduledArtifactBytes;
        let patch = '';
        let patchTruncated = false;
        const tracked = await boundedGitCapture(
          connection.env,
          workspace.workspaceRoot,
          ['diff', '--binary', workspace.baseSha, '--'],
          remaining,
        );
        patch = tracked.content;
        remaining -= Buffer.byteLength(patch, 'utf8');
        patchTruncated = tracked.truncated;
        const untrackedResult = await boundedGitCapture(
          connection.env,
          workspace.workspaceRoot,
          ['ls-files', '-z', '--others', '--exclude-standard', '--'],
          128 * 1024,
        );
        const untrackedPaths = untrackedResult.content
          .split('\0')
          .filter(Boolean);
        if (untrackedResult.truncated || untrackedPaths.length > 200) {
          patchTruncated = true;
        }
        for (const path of untrackedPaths.slice(0, 200)) {
          if (remaining <= 1) {
            patchTruncated = true;
            break;
          }
          const separator = patch ? '\n' : '';
          remaining -= Buffer.byteLength(separator, 'utf8');
          const result = await boundedGitCapture(
            connection.env,
            workspace.workspaceRoot,
            ['diff', '--no-index', '--binary', '--', '/dev/null', path],
            Math.max(0, remaining),
            [0, 1],
          );
          patch += `${separator}${result.content}`;
          remaining -= Buffer.byteLength(result.content, 'utf8');
          if (result.truncated) {
            patchTruncated = true;
            break;
          }
        }
        authorizeCollection();
        await addScheduledRunArtifact(
          {
            runId: input.runId,
            workspaceId: workspace.id,
            kind: 'patch',
            summary: `Changes from ${workspace.baseSha.slice(0, 12)} to ${finalSha?.slice(0, 12) ?? 'working tree'}.`,
            content: patch,
            truncated: patchTruncated,
            collectionOwner,
          },
          paths,
        );
      }
    } finally {
      await closeScheduledWorkspaceConnection(
        connection,
        {
          runId: input.runId,
          workspaceId: workspace.id,
          collectionOwner,
          phase: 'collection',
        },
        paths,
      );
    }

    const retain =
      input.failed ||
      changed ||
      workspace.retention === 'retain-always' ||
      workspace.lifecycle !== 'per-run';
    const now = new Date().toISOString();
    authorizeCollection();
    const collectionStatus = retain ? 'retained' : 'cleanup-pending';
    const retentionReason = retain
      ? input.failed
        ? 'Run failed; workspace retained for inspection.'
        : changed
          ? 'Workspace contains reviewable changes.'
          : 'Task policy retains this workspace.'
      : null;
    await finalizeTaskWorkspaceCollection(
      {
        workspaceId: workspace.id,
        runId: input.runId,
        lockOwner: input.lockOwner,
        collectionOwner,
        finalSha,
        dirty,
        status: collectionStatus,
        retentionReason,
        retainedAt: retain ? now : null,
        preservePhysicalLease: scheduledWorkspaceReleaseForbidden.has(
          scheduledWorkspaceRunKey(input.runId, workspace.id),
        ),
      },
      paths,
    );
    scheduledWorkspaceReleaseForbidden.delete(
      scheduledWorkspaceRunKey(input.runId, workspace.id),
    );
    if (!retain) {
      await cleanupScheduledWorkspace(workspace.id, paths, {
        owningRunId: input.runId,
      });
    }
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function closeScheduledWorkspaceConnection(
  connection: WorkspaceConnection,
  input: {
    runId: string;
    workspaceId: string;
    phase: 'preparation' | 'collection';
    runOwner?: string;
    preparationOwner?: string;
    collectionOwner?: string;
  },
  paths: RuntimePaths,
  recordArtifact: typeof addScheduledRunArtifact = addScheduledRunArtifact,
) {
  try {
    await connection.close();
  } catch (error) {
    const message = sanitizedBoundedContent(
      `Workspace provider connection close failed after successful ${input.phase}: ${error instanceof Error ? error.message : String(error)}`,
      16 * 1024,
    ).content;
    console.warn(`[neondeck] ${message}`);
    try {
      await recordArtifact(
        {
          runId: input.runId,
          workspaceId: input.workspaceId,
          kind: 'cleanup',
          summary: `Provider connection close failed after ${input.phase}.`,
          content: message,
          truncated: false,
          ...(input.runOwner ? { runOwner: input.runOwner } : {}),
          ...(input.preparationOwner
            ? { preparationOwner: input.preparationOwner }
            : {}),
          ...(input.collectionOwner
            ? { collectionOwner: input.collectionOwner }
            : {}),
        },
        paths,
      );
    } catch (artifactError) {
      console.warn(
        `[neondeck] failed to persist scheduled connection close audit: ${safeWorkspaceError(artifactError)}`,
      );
    }
  }
}

export async function failScheduledWorkspaceRun(
  input: {
    runId: string;
    workspaceId: string;
    lockOwner: string;
    message: string;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const workspace = await readTaskWorkspace(input.workspaceId, paths);
  if (!workspace || workspace.status === 'deleted') return workspace;
  try {
    await addScheduledRunArtifact(
      {
        runId: input.runId,
        workspaceId: workspace.id,
        kind: 'response',
        summary: 'Workspace lifecycle failure',
        content: input.message,
        truncated: false,
      },
      paths,
    );
  } catch (artifactError) {
    console.warn(
      `[neondeck] failed to persist scheduled workspace failure artifact: ${safeWorkspaceError(artifactError)}`,
    );
  }
  const sanitizedError = sanitizedBoundedContent(input.message, 16 * 1024);
  const quarantine = await readPhysicalWorkspaceQuarantine(
    workspace.physicalResourceKey,
    paths,
  );
  const updated = await failTaskWorkspaceRunOwned(
    {
      workspaceId: workspace.id,
      runId: input.runId,
      lockOwner: input.lockOwner,
      providerError: sanitizedError.content,
      retentionReason: quarantine
        ? 'A remote operation may still be mutating this resource; it is durably quarantined until confirmed cleanup or explicit operator clearance.'
        : 'Workspace lifecycle failed; retained for inspection.',
      preservePhysicalLease: scheduledWorkspaceReleaseForbidden.has(
        scheduledWorkspaceRunKey(input.runId, workspace.id),
      ),
    },
    paths,
  );
  scheduledWorkspaceReleaseForbidden.delete(
    scheduledWorkspaceRunKey(input.runId, workspace.id),
  );
  return updated ?? (await readTaskWorkspace(input.workspaceId, paths));
}

export async function cleanupScheduledWorkspace(
  workspaceId: string,
  paths: RuntimePaths = runtimePaths(),
  options: { owningRunId: string; allowAbandoned?: boolean },
) {
  let workspace = await readTaskWorkspace(workspaceId, paths);
  if (!workspace) return workspace;
  if (workspace.lifecycle === 'existing') {
    return detachExistingScheduledWorkspace(
      workspaceId,
      options.owningRunId,
      paths,
    );
  }
  const cleanupOwner = `scheduled-workspace-cleanup:${randomUUID()}`;
  const acquired = await acquireTaskWorkspaceCleanupLease(
    {
      workspaceId,
      owningRunId: options.owningRunId,
      owner: cleanupOwner,
      allowAbandoned: options.allowAbandoned,
    },
    paths,
  );
  if (!acquired) {
    throw new Error(
      'Workspace cleanup is blocked while the workspace is active, leased, or already being cleaned up.',
    );
  }
  workspace = (await readTaskWorkspace(workspaceId, paths)) ?? workspace;
  const cleanupLease = startCleanupHeartbeat(
    workspace.id,
    options.owningRunId,
    cleanupOwner,
    paths,
  );
  let cleanupRetentionReason: string | null = null;
  try {
    cleanupLease.assertLease();
    if (workspace.localWorktreeId) {
      const record = readWorktreeRecord(workspace.localWorktreeId, paths);
      if (record.createdBy !== 'scheduled-task' || record.adopted) {
        throw new Error(
          'Scheduled cleanup refused a local worktree that is not schedule-owned.',
        );
      }
      if (record.lifecycleStatus !== 'deleted') {
        const cleanup = await cleanupWorktrees(
          { worktreeId: record.id, force: true, confirmPreparedDiff: true },
          paths,
        );
        const outcome =
          cleanup.ok && 'results' in cleanup
            ? cleanup.results.find((result) => result.worktreeId === record.id)
            : undefined;
        if (!cleanup.ok || outcome?.outcome !== 'deleted') {
          throw new Error(
            cleanup.ok
              ? `Managed worktree cleanup was ${outcome?.outcome ?? 'not recorded'}: ${outcome?.reason ?? 'unknown reason'}.`
              : cleanup.message,
          );
        }
        cleanupLease.assertLease();
      }
      if (
        workspace.lifecycle === 'per-run' &&
        workspace.gitMode === 'run-branch' &&
        workspace.branchName === record.headRef &&
        record.headRef.startsWith('neondeck/schedules/')
      ) {
        if (!workspace.repoSnapshot.verified) {
          cleanupRetentionReason = `Legacy schedule-owned branch "${record.headRef}" was retained because its repository identity was not durably verified.`;
          await addScheduledRunArtifact(
            {
              runId: options.owningRunId,
              workspaceId: workspace.id,
              kind: 'cleanup',
              summary: 'Legacy schedule branch retained',
              content: cleanupRetentionReason,
              truncated: false,
            },
            paths,
          );
        } else {
          await assertLocalRepositoryOrigin(
            workspace.repoSnapshot.path,
            workspace.repoSnapshot.github,
          );
          const matching = (
            await runUnattendedGit(workspace.repoSnapshot.path, [
              'branch',
              '--list',
              '--format=%(refname:short)',
              '--',
              record.headRef,
            ])
          ).trim();
          if (matching === record.headRef) {
            await runUnattendedGit(workspace.repoSnapshot.path, [
              'branch',
              '-D',
              '--',
              record.headRef,
            ]);
          }
        }
        cleanupLease.assertLease();
      }
    } else {
      const provider = workspaceProviderFromSnapshot(
        workspace.providerSnapshot,
        paths,
      );
      await provider.destroy(workspaceResource(workspace), cleanupLease);
    }
    if (workspace.providerId === 'local') {
      await removeLocalPrivateHome(workspace, paths);
    }
    cleanupLease.assertLease();
    const finalized = await finalizeSuccessfulTaskWorkspaceCleanup(
      {
        workspaceId: workspace.id,
        owningRunId: options.owningRunId,
        owner: cleanupOwner,
        deletedAt: new Date().toISOString(),
        retentionReason: cleanupRetentionReason,
      },
      paths,
    );
    if (!finalized) {
      throw new Error('Scheduled workspace cleanup lease was lost.');
    }
  } catch (error) {
    await quarantineWorkspaceIfUncertain(
      workspace,
      error,
      'cleanup',
      options.owningRunId,
      paths,
      cleanupLease.signal.aborted,
    );
    const sanitized = sanitizedBoundedContent(
      error instanceof Error ? error.message : String(error),
      16 * 1024,
    );
    await finalizeTaskWorkspaceCleanup(
      {
        workspaceId: workspace.id,
        owningRunId: options.owningRunId,
        owner: cleanupOwner,
        status: 'cleanup-pending',
        deletedAt: null,
        providerError: sanitized.content,
      },
      paths,
    );
  } finally {
    cleanupLease.stop();
  }
  return readTaskWorkspace(workspace.id, paths);
}

export async function detachExistingScheduledWorkspace(
  workspaceId: string,
  owningRunId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const workspace = await readTaskWorkspace(workspaceId, paths);
  if (!workspace) return workspace;
  if (workspace.lifecycle !== 'existing') {
    throw new Error('Only adopted existing workspaces can be detached.');
  }
  const owner = `scheduled-workspace-detach:${randomUUID()}`;
  const acquired = await acquireTaskWorkspaceCleanupLease(
    { workspaceId, owningRunId, owner },
    paths,
  );
  if (!acquired) {
    throw new Error(
      'Workspace detach is blocked while the workspace is active or leased.',
    );
  }
  const cleanupLease = startCleanupHeartbeat(
    workspace.id,
    owningRunId,
    owner,
    paths,
  );
  try {
    cleanupLease.assertLease();
    if (workspace.providerId === 'local') {
      await removeLocalPrivateHome(workspace, paths);
    } else {
      const provider = workspaceProviderFromSnapshot(
        workspace.providerSnapshot,
        paths,
      );
      await provider.destroy(workspaceResource(workspace), cleanupLease);
    }
    const finalized = await finalizeTaskWorkspaceCleanup(
      {
        workspaceId,
        owningRunId,
        owner,
        status: 'deleted',
        deletedAt: new Date().toISOString(),
        providerError: null,
        retentionReason:
          'Detached from the scheduled task; provider infrastructure was preserved.',
      },
      paths,
    );
    if (!finalized) {
      throw new Error('Scheduled workspace detach lease was lost.');
    }
    return finalized;
  } catch (error) {
    await quarantineWorkspaceIfUncertain(
      workspace,
      error,
      'cleanup',
      owningRunId,
      paths,
      cleanupLease.signal.aborted,
    );
    const sanitized = sanitizedBoundedContent(
      error instanceof Error ? error.message : String(error),
      16 * 1024,
    );
    await finalizeTaskWorkspaceCleanup(
      {
        workspaceId,
        owningRunId,
        owner,
        status: 'cleanup-pending',
        deletedAt: null,
        providerError: sanitized.content,
      },
      paths,
    );
    throw error;
  } finally {
    cleanupLease.stop();
  }
}

export async function recoverAbandonedScheduledWorkspace(
  workspaceId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const workspace = await readTaskWorkspace(workspaceId, paths);
  if (!workspace?.owningRunId) return workspace;
  return cleanupScheduledWorkspace(workspaceId, paths, {
    owningRunId: workspace.owningRunId,
    allowAbandoned: true,
  });
}

async function quarantineWorkspaceIfUncertain(
  workspace: TaskWorkspaceRecord,
  error: unknown,
  source: 'preparation' | 'collection' | 'cleanup',
  sourceId: string,
  paths: RuntimePaths,
  authorityLost = false,
) {
  if (
    workspace.providerId === 'local' ||
    (!authorityLost &&
      !isWorkspaceOperationUncertainError(error) &&
      !(error instanceof DOMException && error.name === 'AbortError'))
  ) {
    return undefined;
  }
  let fenceError: unknown;
  try {
    await fenceTaskWorkspacePhysicalRelease(
      {
        workspaceId: workspace.id,
        runId: workspace.owningRunId ?? sourceId,
        lockOwner: workspace.lockOwner,
      },
      paths,
    );
  } catch (error) {
    fenceError = error;
  }
  try {
    const quarantine = await quarantinePhysicalWorkspace(
      {
        physicalResourceKey: workspace.physicalResourceKey,
        providerId: workspace.providerId,
        source,
        sourceId,
        reason: authorityLost
          ? 'Workspace authority was lost while a remote mutation was in flight; settlement could not be confirmed.'
          : error instanceof Error
            ? error.message
            : 'Remote operation ended without confirmed settlement.',
      },
      paths,
    );
    if (fenceError) {
      console.warn(
        `[neondeck] physical workspace was quarantined after its release fence could not be persisted: ${safeWorkspaceError(fenceError)}`,
      );
    }
    return quarantine;
  } catch (quarantineError) {
    scheduledWorkspaceReleaseForbidden.add(
      scheduledWorkspaceRunKey(sourceId, workspace.id),
    );
    throw new AggregateError(
      [error, ...(fenceError ? [fenceError] : []), quarantineError],
      'Remote operation was uncertain and durable quarantine persistence failed; physical release remains fenced.',
    );
  }
}

export async function recoverOrphanedScheduledWorktreeProvisions(
  paths: RuntimePaths = runtimePaths(),
) {
  const recovered: Array<{
    worktreeId: string;
    outcome: string;
    message: string;
  }> = [];
  for (const candidate of await listOrphanedScheduledWorktreeProvisions(
    paths,
  )) {
    const cleanup = await cleanupWorktrees(
      {
        worktreeId: candidate.worktreeId,
        force: true,
        confirmPreparedDiff: true,
      },
      paths,
    );
    const result =
      cleanup.ok && 'results' in cleanup
        ? cleanup.results.find(
            (item) => item.worktreeId === candidate.worktreeId,
          )
        : undefined;
    recovered.push({
      worktreeId: candidate.worktreeId,
      outcome: result?.outcome ?? (cleanup.ok ? 'retained' : 'failed'),
      message: cleanup.ok
        ? (result?.reason ?? cleanup.message)
        : cleanup.message,
    });
  }
  return recovered;
}

export async function scheduledRunWorkspaceDetail(
  runId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const { readTaskWorkspaceForRun } = await import('./workspace-store');
  const workspace = await readTaskWorkspaceForRun(runId, paths);
  return {
    workspace,
    artifacts: await listScheduledRunArtifacts(runId, paths),
  };
}

export function scheduledWorkspaceSandbox(
  workspace: TaskWorkspaceRecord,
  runId: string,
  lockOwner: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const provider = workspaceProviderFromSnapshot(
    workspace.providerSnapshot,
    paths,
  );
  return instrumentedWorkspaceSandbox(
    provider.sandbox(workspaceResource(workspace), {
      onOperationUncertain: async (error) => {
        await persistScheduledWorkspaceUncertainty(
          {
            error,
            workspaceId: workspace.id,
            runId,
            lockOwner,
            providerId: workspace.providerId,
            physicalResourceKey: workspace.physicalResourceKey,
          },
          paths,
        );
      },
      onTransportCloseError: async (message) => {
        await addScheduledRunArtifact(
          {
            runId,
            workspaceId: workspace.id,
            kind: 'command',
            summary: 'Remote transport close failed after a settled operation',
            content: message,
            truncated: false,
            runOwner: lockOwner,
          },
          paths,
        );
      },
    }),
    runId,
    workspace.id,
    workspace.authority,
    lockOwner,
    paths,
    undefined,
    provider.descriptor.capabilities.commandCancellation,
    {
      providerId: workspace.providerId,
      physicalResourceKey: workspace.physicalResourceKey,
    },
  );
}

export function instrumentedWorkspaceSandbox(
  factory: SandboxFactory,
  runId: string,
  workspaceId: string,
  authority: Extract<
    ScheduledWorkspacePolicy,
    { kind: 'repository' }
  >['authority'],
  lockOwner: string,
  paths: RuntimePaths,
  recordArtifact: typeof addScheduledRunArtifact = addScheduledRunArtifact,
  commandCancellation: 'native' | 'orphan-possible' = 'native',
  remoteIdentity?: { providerId: string; physicalResourceKey: string },
): SandboxFactory {
  return {
    ...factory,
    async createSandbox(options) {
      const runKey = `${runId}\n${workspaceId}`;
      const controller = new AbortController();
      scheduledRunAbortControllers.set(runKey, controller);
      const authorize = () => {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('Scheduled workspace execution was invalidated.');
        }
        try {
          assertScheduledWorkspaceRunAuthorizedSync(
            { workspaceId, runId, owner: lockOwner },
            paths,
          );
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      };
      authorize();
      let env: Sandbox;
      try {
        env = await factory.createSandbox(options);
      } catch (error) {
        if (remoteIdentity && isWorkspaceOperationUncertainError(error)) {
          await persistScheduledWorkspaceUncertainty(
            {
              error,
              workspaceId,
              runId,
              lockOwner,
              ...remoteIdentity,
            },
            paths,
          );
        }
        throw error;
      }
      const quarantine = async (
        kind:
          'abort' | 'timeout' | 'output-limit' | 'transport' | 'authority-loss',
        operation: string,
        message: string,
      ) => {
        if (!remoteIdentity) return;
        const error = new WorkspaceOperationUncertainError(
          { kind, operation, message },
          remoteIdentity.providerId,
        );
        await persistScheduledWorkspaceUncertainty(
          {
            error,
            workspaceId,
            runId,
            lockOwner,
            ...remoteIdentity,
          },
          paths,
        );
        throw error;
      };
      const remoteOperation = async <T>(
        operation: string,
        run: () => Promise<T>,
      ) => {
        authorize();
        try {
          return await run();
        } catch (error) {
          if (remoteIdentity && isWorkspaceOperationUncertainError(error)) {
            await persistScheduledWorkspaceUncertainty(
              {
                error,
                workspaceId,
                runId,
                lockOwner,
                ...remoteIdentity,
              },
              paths,
            );
          }
          throw error;
        }
      };
      const authorizeAfterMutation = async (operation: string) => {
        try {
          authorize();
        } catch (error) {
          if (remoteIdentity) {
            await quarantine(
              'authority-loss',
              operation,
              error instanceof Error
                ? error.message
                : 'Workspace authority was lost after a remote mutation.',
            );
          }
          throw error;
        }
      };
      const remoteMutation = async <T>(
        operation: string,
        mutate: () => Promise<T>,
      ) => {
        authorize();
        const mutation = Promise.resolve().then(mutate);
        let abortListener: (() => void) | undefined;
        const authorityLoss = new Promise<never>((_, reject) => {
          abortListener = () =>
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new DOMException(
                    'Scheduled workspace authority was lost.',
                    'AbortError',
                  ),
            );
          controller.signal.addEventListener('abort', abortListener, {
            once: true,
          });
        });
        try {
          // Flue file verbs do not carry an AbortSignal. Race the adapter
          // mutation against lease invalidation so the worker is fenced and
          // the physical resource is quarantined promptly; consume the late
          // adapter settlement because it may still finish remotely.
          const value = await Promise.race([mutation, authorityLoss]);
          await authorizeAfterMutation(operation);
          return value;
        } catch (error) {
          if (remoteIdentity && isWorkspaceOperationUncertainError(error)) {
            await persistScheduledWorkspaceUncertainty(
              {
                error,
                workspaceId,
                runId,
                lockOwner,
                ...remoteIdentity,
              },
              paths,
            );
            throw error;
          }
          if (
            remoteIdentity &&
            (controller.signal.aborted ||
              (error instanceof DOMException && error.name === 'AbortError'))
          ) {
            await quarantine(
              'abort',
              operation,
              'Remote mutation cancellation did not confirm process or operation settlement.',
            );
          }
          throw error;
        } finally {
          if (abortListener) {
            controller.signal.removeEventListener('abort', abortListener);
          }
          void mutation.catch(() => undefined);
        }
      };
      return {
        ...env,
        resolvePath(path) {
          authorize();
          return env.resolvePath(path);
        },
        async exec(command, execOptions) {
          authorize();
          const startedAt = Date.now();
          const signal = execOptions?.signal
            ? AbortSignal.any([execOptions.signal, controller.signal])
            : controller.signal;
          let result;
          try {
            result = await env.exec(command, { ...execOptions, signal });
          } catch (error) {
            if (remoteIdentity && isWorkspaceOperationUncertainError(error)) {
              await persistScheduledWorkspaceUncertainty(
                {
                  error,
                  workspaceId,
                  runId,
                  lockOwner,
                  ...remoteIdentity,
                },
                paths,
              );
              throw error;
            }
            if (
              commandCancellation === 'orphan-possible' &&
              (signal.aborted ||
                (error instanceof DOMException && error.name === 'AbortError'))
            ) {
              await quarantine(
                'abort',
                'exec',
                'Remote command cancellation did not confirm process settlement.',
              );
            }
            throw error;
          }
          const uncertainty = sshCommandUncertainty(result);
          if (uncertainty) {
            await quarantine(uncertainty.kind, 'exec', uncertainty.message);
          }
          await authorizeAfterMutation('exec');
          const preview = boundedContent(
            redactExecutionOutput(
              redactGitText(
                `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`,
              ),
            ),
            32 * 1024,
          );
          try {
            await recordArtifact(
              {
                runId,
                workspaceId,
                kind: 'command',
                summary: `${redactExecutionOutput(redactGitText(command)).slice(0, 240)} (${result.exitCode}, ${Date.now() - startedAt}ms)`,
                content: preview.content,
                truncated: preview.truncated,
                runOwner: lockOwner,
              },
              paths,
            );
          } catch (error) {
            console.warn(
              `[neondeck] completed scheduled command but failed to persist its audit artifact: ${safeWorkspaceError(error)}`,
            );
            try {
              await recordTaskWorkspaceAuditFailureOwned(
                {
                  workspaceId,
                  runId,
                  lockOwner,
                  message:
                    'A completed command audit artifact could not be persisted.',
                },
                paths,
              );
            } catch (recordError) {
              console.warn(
                `[neondeck] failed to record scheduled command audit persistence failure: ${safeWorkspaceError(recordError)}`,
              );
            }
          }
          return result;
        },
        async readFile(path) {
          return remoteIdentity
            ? remoteOperation('readFile', () => env.readFile(path))
            : (authorize(), env.readFile(path));
        },
        async readFileBuffer(path) {
          return remoteIdentity
            ? remoteOperation('readFileBuffer', () => env.readFileBuffer(path))
            : (authorize(), env.readFileBuffer(path));
        },
        async writeFile(path, content) {
          return remoteIdentity
            ? remoteMutation('writeFile', () => env.writeFile(path, content))
            : (authorize(), env.writeFile(path, content));
        },
        async stat(path) {
          return remoteIdentity
            ? remoteOperation('stat', () => env.stat(path))
            : (authorize(), env.stat(path));
        },
        async readdir(path) {
          return remoteIdentity
            ? remoteOperation('readdir', () => env.readdir(path))
            : (authorize(), env.readdir(path));
        },
        async exists(path) {
          try {
            return remoteIdentity
              ? await remoteOperation('exists', () => env.exists(path))
              : (authorize(), await env.exists(path));
          } catch {
            return false;
          }
        },
        async mkdir(path, mkdirOptions) {
          return remoteIdentity
            ? remoteMutation('mkdir', () => env.mkdir(path, mkdirOptions))
            : (authorize(), env.mkdir(path, mkdirOptions));
        },
        async rm(path, rmOptions) {
          return remoteIdentity
            ? remoteMutation('rm', () => env.rm(path, rmOptions))
            : (authorize(), env.rm(path, rmOptions));
        },
      };
    },
    tools:
      authority === 'read-only'
        ? (env) => [
            createReadTool(env),
            createGrepTool(env),
            createGlobTool(env),
          ]
        : (env) => [
            createReadTool(env),
            createWriteTool(env),
            createEditTool(env),
            createGrepTool(env),
            createGlobTool(env),
            createBashTool(env),
          ],
  };
}

export function credentialFreeRepositoryUrl(repo: {
  owner: string;
  name: string;
}) {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}.git`;
}

async function assertLocalRepositoryOrigin(
  root: string,
  repository: { owner: string; name: string },
) {
  const origin = (
    await runUnattendedGit(root, ['config', '--get', 'remote.origin.url'])
  ).trim();
  assertRegisteredRepositoryOrigin(origin, repository);
}

async function assertSessionRepositoryOrigin(
  env: Sandbox,
  root: string,
  repository: { owner: string; name: string },
) {
  const origin = await gitOutput(env, root, [
    'config',
    '--get',
    'remote.origin.url',
  ]);
  assertRegisteredRepositoryOrigin(origin, repository);
}

function assertRegisteredRepositoryOrigin(
  origin: string,
  repository: { owner: string; name: string },
) {
  const actual = githubRepositoryIdentity(origin);
  const expected = `${repository.owner}/${repository.name}`.toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `Repository origin does not match registered GitHub repository ${repository.owner}/${repository.name}.`,
    );
  }
}

function githubRepositoryIdentity(origin: string) {
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(origin);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (
    parsed.hostname.toLowerCase() !== 'github.com' ||
    parsed.password ||
    (parsed.protocol === 'https:' && parsed.username)
  ) {
    return null;
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  return `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1]).replace(/\.git$/, '')}`.toLowerCase();
}
function branchName(
  taskId: string,
  runId: string,
  policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>,
) {
  if (policy.git.branch) return policy.git.branch;
  const slug = taskSlug(taskId);
  return policy.git.mode === 'task-branch'
    ? `neondeck/schedules/${slug}`
    : `neondeck/schedules/${slug}/${shortRunId(runId)}`;
}

function taskSlug(taskId: string) {
  return taskId
    .replace(/^instruction:/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

function safeWorkspaceError(error: unknown) {
  return sanitizedBoundedContent(
    error instanceof Error ? error.message : String(error),
    16 * 1024,
  ).content;
}

function shortRunId(runId: string) {
  return basename(runId)
    .replace(/^scheduled-task-run:/, '')
    .slice(0, 12);
}

function safeResourceName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 62);
}

function workspaceResource(workspace: TaskWorkspaceRecord): WorkspaceResource {
  return {
    providerId: workspace.providerId,
    externalId: workspace.providerResourceId,
    root: workspace.workspaceRoot,
    metadata: workspace.resourceMetadata,
  };
}

function physicalResourceKey(resource: WorkspaceResource) {
  return resource.providerId === 'local'
    ? `local:${resolve(resource.root)}`
    : physicalRemoteResourceKey(resource);
}

export function startCleanupHeartbeat(
  workspaceId: string,
  owningRunId: string,
  owner: string,
  paths: RuntimePaths,
  options: {
    intervalMs?: number;
    renew?: typeof renewTaskWorkspaceCleanupLease;
  } = {},
) {
  const controller = new AbortController();
  let leaseError: Error | undefined;
  let renewing = false;
  const loseLease = (reason: unknown) => {
    if (leaseError) return;
    leaseError =
      reason instanceof Error
        ? reason
        : new Error('Scheduled workspace cleanup lease was lost.');
    controller.abort(leaseError);
  };
  const renew = options.renew ?? renewTaskWorkspaceCleanupLease;
  const heartbeat = setInterval(() => {
    if (renewing || leaseError) return;
    renewing = true;
    void renew({ workspaceId, owningRunId, owner }, paths)
      .then((renewed) => {
        if (!renewed) loseLease(undefined);
      })
      .catch((error) => {
        console.warn(
          `[neondeck] scheduled cleanup lease renewal failed: ${safeWorkspaceError(error)}`,
        );
        loseLease(error);
      })
      .finally(() => {
        renewing = false;
      });
  }, options.intervalMs ?? 60_000);
  heartbeat.unref?.();
  return {
    signal: controller.signal,
    assertLease() {
      if (leaseError) throw leaseError;
      try {
        assertTaskWorkspaceCleanupLeaseSync(
          { workspaceId, owningRunId, owner },
          paths,
        );
      } catch (error) {
        loseLease(error);
        throw error;
      }
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}

async function removeLocalPrivateHome(
  workspace: TaskWorkspaceRecord,
  paths: RuntimePaths,
) {
  const root = resolve(paths.home, 'workspace-homes');
  const expected = resolve(
    root,
    workspace.providerResourceId.replace(/[^A-Za-z0-9._-]/g, '-'),
  );
  const fromRoot = relative(root, expected);
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(
      'Local workspace private HOME is not a safe provider-owned child.',
    );
  }
  if (resolve(workspace.resourceMetadata.privateHome) !== expected) {
    throw new Error(
      'Local workspace private HOME metadata does not match its provider-owned path.',
    );
  }
  await rm(expected, { recursive: true, force: true });
}

async function retainPreparationFailure(
  workspace: TaskWorkspaceRecord,
  message: string,
  paths: RuntimePaths,
) {
  return updateTaskWorkspace(
    workspace.id,
    {
      status: 'retained',
      providerError: message,
      retentionReason: 'Workspace preparation failed; retained for inspection.',
      retainedAt: new Date().toISOString(),
    },
    paths,
  );
}

async function releaseLocalWorktreeLock(
  workspace: TaskWorkspaceRecord,
  owner: string,
  paths: RuntimePaths,
) {
  const lockId =
    'scheduledWorktreeLockId' in workspace.resourceMetadata
      ? workspace.resourceMetadata.scheduledWorktreeLockId
      : undefined;
  if (typeof lockId !== 'string') return;
  const released = await releaseWorktreeLock(
    { lockId, owner, finalStatus: 'ready' },
    paths,
  );
  if (!released.ok) throw new Error(released.message);
}

async function gitCommand(env: Sandbox, cwd: string, args: string[]) {
  const result = await gitResult(env, cwd, args);
  assertCommandSucceeded(result, `git ${args[0] ?? ''}`);
}

async function gitOutput(env: Sandbox, cwd: string, args: string[]) {
  const result = await gitResult(env, cwd, args);
  assertCommandSucceeded(result, `git ${args[0] ?? ''}`);
  return result.stdout.trim();
}

function gitResult(env: Sandbox, cwd: string, args: string[]) {
  return env.exec(`git ${args.map(shellArgument).join(' ')}`, {
    cwd,
    timeoutMs: commandTimeoutMs,
  });
}

async function boundedGitCapture(
  env: Sandbox,
  cwd: string,
  args: string[],
  maximum: number,
  acceptedExitCodes: number[] = [0],
) {
  const sentinel = `__NEONDECK_GIT_EXIT_${randomUUID().replaceAll('-', '')}__`;
  const outputLimit = Math.max(0, maximum) + 1;
  const command = [
    'tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/neondeck-git.XXXXXX") || exit 70',
    'trap \'rm -rf -- "$tmpdir"\' EXIT HUP INT TERM',
    'mkfifo "$tmpdir/output" || exit 70',
    `{ exec 3<"$tmpdir/output"; head -c ${outputLimit} <&3; cat <&3 >/dev/null; exec 3<&-; } & consumer=$!`,
    `git ${args.map(shellArgument).join(' ')} >"$tmpdir/output" 2>&1`,
    'code=$?',
    'wait "$consumer"',
    `printf '\\n${sentinel}%s\\n' "$code"`,
    'exit 0',
  ].join('; ');
  const result = await env.exec(command, { cwd, timeoutMs: commandTimeoutMs });
  assertCommandSucceeded(result, `bounded git ${args[0] ?? ''}`);
  const marker = result.stdout.lastIndexOf(`\n${sentinel}`);
  if (marker < 0) {
    throw new Error(`git ${args[0] ?? ''} did not report its exit status.`);
  }
  const exitCode = Number.parseInt(
    result.stdout.slice(marker + sentinel.length + 1).trim(),
    10,
  );
  if (!Number.isInteger(exitCode)) {
    throw new Error(`git ${args[0] ?? ''} reported an invalid exit status.`);
  }
  if (!acceptedExitCodes.includes(exitCode)) {
    throw new Error(`git ${args[0] ?? ''} failed with exit ${exitCode}.`);
  }
  const bounded = boundedContent(
    result.stdout.slice(0, marker),
    Math.max(0, maximum),
  );
  return {
    content: bounded.content,
    truncated: bounded.truncated,
    exitCode,
  };
}

function assertCommandSucceeded(
  result: { exitCode: number; stderr: string },
  operation: string,
) {
  const uncertainty = sshCommandUncertainty(result);
  if (uncertainty) {
    throw new WorkspaceOperationUncertainError({
      kind: uncertainty.kind,
      operation,
      message: `${operation} has an uncertain remote outcome: ${uncertainty.message}`,
    });
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
}

function shellArgument(value: string) {
  return `'${shellEscape(value)}'`;
}

function shellEscape(value: string) {
  return value.replace(/'/g, `'\\''`);
}

function formatNulGitStatus(value: string) {
  return value
    .split('\0')
    .filter(Boolean)
    .map((entry) => JSON.stringify(entry))
    .join('\n');
}
