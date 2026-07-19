import { createHash } from 'node:crypto';
import { defineAction, defineTool } from '@flue/runtime';
import { openDb } from '../lib/sqlite';
import { currentTaskOrigin } from '../modules/flue/origin';
import {
  humanEffectSummary,
  evaluateRepoGuardrails,
  repoGuardrails,
} from '../modules/repo-guardrails';
import { resolveInteractiveRepoContext } from '../modules/sessions/repo-context';
import { recordSessionAudit } from '../modules/sessions/store';
import {
  lockWorktree,
  readWorktreeLock,
  readManagedWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  releaseWorktreeLock,
  revokeWorktreeLockLease,
  WORKTREE_LOCK_REVOCATION_GRACE_MS,
  type WorktreeLockRecord,
  type WorktreeRecord,
} from '../modules/worktrees';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../runtime-home';
import {
  gitCommitAll,
  gitCommitPaths,
  gitChangedPaths,
  gitCurrentSha,
  gitPushHead,
  gitStagedPaths,
  gitStatus,
} from './git';
import { assertRepoRelativePathAllowed } from './path-safety';
import {
  readRepoCheckoutStatus,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  searchRepoFiles,
  writeRepoFile,
} from './service';
import { patchRepoFiles } from './patch-service';
import {
  repoDiffInputSchema,
  repoCommitInputSchema,
  repoEditOutputSchema,
  repoPatchInputSchema,
  repoReadInputSchema,
  repoReplaceInputSchema,
  repoSearchInputSchema,
  repoStatusInputSchema,
  repoPushInputSchema,
  repoWriteInputSchema,
  type RepoCommitInput,
  type RepoPushInput,
} from './schemas';

export const repoFileReadAction = defineAction({
  name: 'neondeck_repo_file_read',
  description:
    'Read one text file from a configured Neondeck repo using a repo-relative path. Never prompts inside declared workspaces.',
  input: repoReadInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoFile(input);
  },
});

export const repoFileSearchAction = defineAction({
  name: 'neondeck_repo_file_search',
  description:
    'Search text files in a configured Neondeck repo using rg-style deterministic search.',
  input: repoSearchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return searchRepoFiles(input);
  },
});

export const repoFileWriteAction = defineAction({
  name: 'neondeck_repo_file_write',
  description:
    'Write a complete text file inside a configured Neondeck repo. Use for generated files or deliberate full rewrites.',
  input: repoWriteInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return writeRepoFile(input);
  },
});

export const repoFileReplaceAction = defineAction({
  name: 'neondeck_repo_file_replace',
  description:
    'Replace an exact or safe fuzzy old string with a new string inside one configured repo file.',
  input: repoReplaceInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return replaceRepoFile(input);
  },
});

export const repoFilePatchAction = defineAction({
  name: 'neondeck_repo_file_patch',
  description:
    'Apply a V4A/Codex-style multi-file patch inside a configured Neondeck repo. Validates all files before mutating.',
  input: repoPatchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return patchRepoFiles(input);
  },
});

export const repoDiffAction = defineAction({
  name: 'neondeck_repo_diff',
  description:
    'Return git-backed diff summary and optional patch content for a configured Neondeck repo.',
  input: repoDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoDiff(input);
  },
});

export const repoStatusAction = defineAction({
  name: 'neondeck_repo_checkout_status',
  description:
    'Return branch, upstream, ahead/behind, and changed file status for a configured Neondeck repo.',
  input: repoStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoCheckoutStatus(input);
  },
});

export const repoCommitAction = defineAction({
  name: 'neondeck_repo_commit',
  description:
    'Commit selected or all changes in a declared managed worktree. Interactive sessions only; never creates an execution approval.',
  input: repoCommitInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    if (currentTaskOrigin() === 'autopilot') {
      return originFailure('repo_commit', 'interactiveOnly');
    }
    return commitInteractiveRepo(input);
  },
});

export const repoPushAction = defineAction({
  name: 'neondeck_repo_push',
  description:
    'Push the current managed worktree HEAD to its linked PR head. Interactive sessions only; guardrail expansions require one effect-based confirmation.',
  input: repoPushInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    if (currentTaskOrigin() === 'autopilot') {
      return originFailure('repo_push', 'interactiveOnly');
    }
    return pushInteractiveRepo(input);
  },
});

export async function commitInteractiveRepo(
  input: RepoCommitInput,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  try {
    const worktree = await readManagedWorktree(
      input.worktreeId,
      input.repoId,
      paths,
    );
    return await withInteractiveWorktreeLock(
      'repo_commit',
      worktree,
      input.sessionId,
      paths,
      async () => {
        const pathsToCommit =
          input.paths ?? (await gitChangedPaths(worktree.localPath));
        const stagedPaths = await gitStagedPaths(worktree.localPath);
        [...pathsToCommit, ...stagedPaths].forEach(
          assertRepoRelativePathAllowed,
        );
        const commit = input.paths
          ? await gitCommitPaths(worktree.localPath, input.message, input.paths)
          : await gitCommitAll(worktree.localPath, input.message);
        return {
          ok: true,
          action: 'repo_commit',
          changed: commit.committed,
          message: commit.message,
          data: { commit, worktreeId: worktree.id },
        };
      },
    );
  } catch (error) {
    return actionFailure('repo_commit', error);
  }
}

export async function pushInteractiveRepo(
  input: RepoPushInput,
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    resolveContext?: typeof resolveInteractiveRepoContext;
    contextDependencies?: Parameters<typeof resolveInteractiveRepoContext>[2];
    pushGit?: typeof gitPushHead;
  } = {},
) {
  await ensureRuntimeHome(paths);
  try {
    const context = await (
      dependencies.resolveContext ?? resolveInteractiveRepoContext
    )(input, paths, dependencies.contextDependencies);
    if (!context) {
      return requirementFailure(
        'repo_push',
        'No declared repository context is linked to this session.',
        'repoContext',
      );
    }
    if (!context.linkedPrHead || context.prNumber === null) {
      return requirementFailure(
        'repo_push',
        'No linked PR head is available as the push target.',
        'pushTarget',
      );
    }
    return await withInteractiveWorktreeLock(
      'repo_push',
      context.worktree,
      input.sessionId,
      paths,
      async () => {
        const status = await gitStatus(context.worktree.localPath);
        if (!status.clean) {
          return requirementFailure(
            'repo_push',
            'Commit the managed worktree changes before pushing the linked PR head.',
            'commitChanges',
          );
        }
        const commitSha = await gitCurrentSha(context.worktree.localPath);
        const appConfig = await readRuntimeJson(paths.config, parseAppConfig);
        const guardrails = await evaluateRepoGuardrails(
          {
            worktreeId: context.worktree.id,
            diffBaseRef:
              context.worktree.lastPushedSha ??
              context.worktree.headSha ??
              undefined,
            pushDestination: 'pull-request-head',
            guardrails: repoGuardrails(context.repo, appConfig),
          },
          paths,
        );
        if (guardrails.denied.length > 0) {
          return {
            ...requirementFailure(
              'repo_push',
              humanEffectSummary(guardrails.denied),
              'guardrail',
            ),
            data: { guardrails },
          };
        }
        const effect = humanEffectSummary(guardrails.expansions);
        const confirmationToken = pushConfirmationToken(
          commitSha,
          guardrails.policyHash,
          effect,
        );
        if (
          guardrails.expansions.length > 0 &&
          (!input.acknowledgeExpansion ||
            input.confirmationToken !== confirmationToken)
        ) {
          return {
            ...requirementFailure(
              'repo_push',
              input.acknowledgeExpansion
                ? 'The worktree or guardrail effect changed after confirmation; review the current push effect again.'
                : 'Pushing this diff expands the normal interactive guardrail boundary.',
              'confirmPush',
            ),
            effect,
            confirmationToken,
            data: { commitSha, guardrails },
          };
        }
        if (guardrails.expansions.length > 0) {
          const database = openDb(paths.neondeckDatabase);
          try {
            recordSessionAudit(database, {
              action: 'repo_push_expansion_ack',
              sessionId: input.sessionId ?? null,
              reason: effect,
              metadata: {
                effect,
                commitSha,
                repoId: context.repo.id,
                worktreeId: context.worktree.id,
                prNumber: context.prNumber,
              },
            });
          } finally {
            database.close();
          }
        }
        const push = await (dependencies.pushGit ?? gitPushHead)(
          context.worktree.localPath,
          {
            remote: context.pushRemote,
            branch: context.pushBranch,
            sha: commitSha,
          },
        );
        await recordWorktreePushSucceeded(
          context.worktree.id,
          {
            commitSha,
            message: `Interactive session pushed ${commitSha} to the linked PR head.`,
            data: {
              sessionId: input.sessionId ?? null,
              remote: context.pushRemote,
              branch: context.pushBranch,
            },
          },
          paths,
        );
        return {
          ok: true,
          action: 'repo_push',
          changed: true,
          message: `Pushed ${commitSha} to the linked PR head.`,
          data: { push, commitSha, guardrails },
        };
      },
    );
  } catch (error) {
    return actionFailure('repo_push', error);
  }
}

export const repoDiffTool = defineTool({
  name: 'neondeck_repo_diff_lookup',
  description: 'Read git diff summary for a configured Neondeck repo.',
  input: repoDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoDiff(input);
  },
});

export const repoStatusTool = defineTool({
  name: 'neondeck_repo_checkout_status_lookup',
  description: 'Read checkout status for a configured Neondeck repo.',
  input: repoStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoCheckoutStatus(input);
  },
});

export const neondeckRepoEditActions = [
  repoFileReadAction,
  repoFileSearchAction,
  repoFileWriteAction,
  repoFileReplaceAction,
  repoFilePatchAction,
  repoDiffAction,
  repoStatusAction,
  repoCommitAction,
  repoPushAction,
];

export const neondeckRepoEditTools = [repoDiffTool, repoStatusTool];

function originFailure(action: string, requirement: string) {
  return requirementFailure(
    action,
    'This capability is only available in a human-driven interactive session.',
    requirement,
  );
}

function requirementFailure(action: string, message: string, requires: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    requires: [requires],
  };
}

function actionFailure(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'WORKTREE_ERROR', message },
  };
}

async function withInteractiveWorktreeLock<T>(
  action: string,
  worktree: WorktreeRecord,
  sessionId: string | undefined,
  paths: ReturnType<typeof runtimePaths>,
  run: () => Promise<T>,
) {
  const owner = `interactive:${sessionId ?? 'session'}`;
  let locked = await lockWorktree(
    {
      worktreeId: worktree.id,
      scope: worktree.prNumber === null ? 'worktree' : 'pr',
      owner,
      ttlSeconds: 3_600,
    },
    paths,
  );
  if (!locked.ok) {
    const active =
      'lock' in locked ? (locked.lock as WorktreeLockRecord) : null;
    if (!active?.workflowRunId) {
      return requirementFailure(action, locked.message, 'worktreeLock');
    }
    await revokeWorktreeLockLease(active.id, paths);
    await recordWorktreePushBlocked(
      worktree.id,
      {
        message: `Interactive session preempted autopilot run ${active.workflowRunId}; recover from the retained prepared diff before resuming.`,
        data: {
          preemptedWorkflowRunId: active.workflowRunId,
          preemptedBy: owner,
          recoveryRequired: true,
        },
      },
      paths,
    );
    await waitForWorktreeLockHandoff(active.id, paths);
    locked = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: worktree.prNumber === null ? 'worktree' : 'pr',
        owner,
        ttlSeconds: 3_600,
      },
      paths,
    );
  }
  if (!locked.ok || !('lock' in locked)) {
    return requirementFailure(action, locked.message, 'worktreeLock');
  }
  const interactiveLock = locked.lock;
  try {
    return await run();
  } finally {
    const current = await readManagedWorktree(
      worktree.id,
      worktree.repoId,
      paths,
    ).catch(() => null);
    await releaseWorktreeLock(
      {
        lockId: interactiveLock.id,
        owner,
        finalStatus:
          current?.lifecycleStatus === 'succeeded' ? 'succeeded' : 'ready',
      },
      paths,
    );
  }
}

async function waitForWorktreeLockHandoff(
  lockId: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  const deadline = Date.now() + WORKTREE_LOCK_REVOCATION_GRACE_MS;
  while (Date.now() < deadline) {
    const lock = await readWorktreeLock(lockId, paths);
    if (lock.releasedAt) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pushConfirmationToken(
  commitSha: string,
  policyHash: string,
  effect: string,
) {
  return createHash('sha256')
    .update(JSON.stringify({ commitSha, policyHash, effect }))
    .digest('hex');
}
