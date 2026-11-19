import { runApprovedExecution } from '../execution';
import { recordPreparedDiffVerification } from '../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  listWorktrees,
  lockWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  type WorktreeRecord,
} from '../worktrees';

type VerificationExecutionResult = Awaited<
  ReturnType<typeof runApprovedExecution>
>;

type WorktreeVerificationRunContext = {
  command: string;
  defaultRun: () => Promise<VerificationExecutionResult>;
  repo: RepoConfig;
  worktree: WorktreeRecord;
};

export type WorktreeVerificationResult = {
  ok: boolean;
  blocked: boolean;
  checks: string[];
  results: Array<{
    command: string;
    ok: boolean;
    message: string;
    requires: string[];
    approvalId: string | null;
    exitCode: number | null;
  }>;
  repo: RepoConfig;
  repoFullName: string;
  worktree: WorktreeRecord;
  status: unknown;
  preparedDiffVerification: Awaited<
    ReturnType<typeof recordPreparedDiffVerification>
  >;
};

export type VerifyWorktreeChecksInput = {
  worktreeId: string;
  checks: string[];
  backend?: 'local' | 'exe.dev';
  context?: 'interactive' | 'unattended';
  lock?: boolean;
  lockOwner?: string;
  lockTtlSeconds?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  finalLockStatus?: 'ready' | 'prepared-diff';
  requestContext?: {
    source: string;
    workflow: string;
  };
};

export type VerifyWorktreeChecksDependencies = {
  runExecution?: typeof runApprovedExecution;
  runCheck?: (
    context: WorktreeVerificationRunContext,
  ) => Promise<
    VerificationExecutionResult | { blocked: true; message: string }
  >;
};

export async function verifyWorktreeChecks(
  input: VerifyWorktreeChecksInput,
  paths: RuntimePaths = runtimePaths(),
  dependencies: VerifyWorktreeChecksDependencies = {},
): Promise<WorktreeVerificationResult> {
  await ensureRuntimeHome(paths);
  let acquiredLockId: string | undefined;
  const lockOwner = input.lockOwner ?? 'verify_worktree_checks';
  let finalLockStatus = input.finalLockStatus ?? 'ready';

  try {
    const [registry, worktreeSnapshot] = await Promise.all([
      readRepoRegistrySnapshot(paths),
      listWorktrees(paths),
    ]);
    const worktree = worktreeSnapshot.worktrees.find(
      (candidate) => candidate.id === input.worktreeId,
    );
    if (!worktree || worktree.lifecycleStatus === 'deleted') {
      throw new Error(`Worktree "${input.worktreeId}" was not found.`);
    }
    finalLockStatus =
      input.finalLockStatus ??
      (worktree.lifecycleStatus === 'prepared-diff'
        ? 'prepared-diff'
        : 'ready');
    const repo = registry.repos.find(
      (candidate) => candidate.id === worktree.repoId,
    );
    if (!repo) {
      throw new Error(`Repository "${worktree.repoId}" is not configured.`);
    }

    if (input.lock ?? true) {
      const locked = await lockWorktree(
        {
          worktreeId: worktree.id,
          scope: 'pr',
          owner: lockOwner,
          ttlSeconds: input.lockTtlSeconds ?? 3_600,
        },
        paths,
      );
      if (!locked.ok) {
        throw new Error(locked.message);
      }
      acquiredLockId = stringField(objectField(locked, 'lock'), 'id');
    }

    const runExecution = dependencies.runExecution ?? runApprovedExecution;
    const results: WorktreeVerificationResult['results'] = [];
    for (const command of input.checks) {
      const defaultRun = () =>
        runExecution(
          {
            command,
            backend: input.backend,
            cwd: worktree.localPath,
            context: input.context ?? 'unattended',
            timeoutMs: input.timeoutMs,
            maxOutputBytes: input.maxOutputBytes,
            requestContext: {
              source: input.requestContext?.source ?? 'worktree',
              workflow:
                input.requestContext?.workflow ?? 'verify_worktree_checks',
              repoId: repo.id,
              repoFullName: repoFullName(repo),
              prNumber: worktree.prNumber,
              worktreeId: worktree.id,
            },
          },
          paths,
        );
      const slot = dependencies.runCheck
        ? await dependencies.runCheck({ command, defaultRun, repo, worktree })
        : await defaultRun();
      if ('blocked' in slot) {
        results.push({
          command,
          ok: false,
          message: slot.message,
          requires: ['localExecutionLimit'],
          approvalId: null,
          exitCode: null,
        });
        break;
      }
      results.push({
        command,
        ok: Boolean(slot.ok),
        message: stringField(slot, 'message') ?? 'Execution completed.',
        requires: arrayField(slot, 'requires'),
        approvalId: stringField(objectField(slot, 'approval'), 'id') ?? null,
        exitCode: numberField(objectField(slot, 'result'), 'exitCode') ?? null,
      });
      if (!slot.ok) break;
    }

    const passed =
      results.length === input.checks.length &&
      results.every((item) => item.ok);
    const blocked = results.some((item) => item.requires.length > 0);
    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    const preparedDiffVerification = await recordPreparedDiffVerification(
      {
        worktreeId: worktree.id,
        status: passed ? 'passed' : 'failed',
        summary: {
          checks: input.checks,
          results,
          blocked,
        },
      },
      paths,
    );

    return {
      ok: passed,
      blocked,
      checks: input.checks,
      results,
      repo,
      repoFullName: repoFullName(repo),
      worktree,
      status,
      preparedDiffVerification,
    };
  } finally {
    if (acquiredLockId) {
      await releaseWorktreeLock(
        {
          lockId: acquiredLockId,
          owner: lockOwner,
          finalStatus: finalLockStatus,
        },
        paths,
      ).catch(() => undefined);
    }
  }
}

export function resolveWorktreeVerificationChecks(
  inputChecks: string[] | undefined,
  repo: RepoConfig,
  policyChecks: string[],
) {
  if (policyChecks.length > 0) {
    return unique([...policyChecks, ...(inputChecks ?? [])]);
  }
  if (inputChecks && inputChecks.length > 0) return unique(inputChecks);

  const scripts = repo.packageScripts ?? {};
  const preferred = ['check', 'test', 'typecheck', 'lint'];
  return preferred
    .filter((script) => scripts[script])
    .map((script) => `npm run ${script}`);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string) {
  const field = objectField(value, key);
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: unknown, key: string) {
  const field = objectField(value, key);
  return typeof field === 'number' ? field : undefined;
}

function arrayField(value: unknown, key: string) {
  const field = objectField(value, key);
  return Array.isArray(field) ? field.map(String) : [];
}
