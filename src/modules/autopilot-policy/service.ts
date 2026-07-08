import { gitDiff } from '../../repo-edit/git';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { listWorktrees } from '../worktrees';
import {
  globalAutopilotPolicy,
  repoAutopilotPolicy,
  repoAutopilotPolicyForWatch,
} from './config';
import {
  classifyFileRisk,
  emptyPolicyFailure,
  normalizeWorkflowName,
  readActiveAutopilotRuns,
} from './risk';
import {
  mutationWorkflowNames,
  type AutopilotConcurrencyDecision,
  type AutopilotConcurrencyPolicy,
  type AutopilotPolicyDecision,
} from './schemas';

let activeLocalExecutions = 0;

export async function checkAutopilotPolicy(
  input: {
    repoId?: string;
    worktreeId?: string;
    diffBaseRef?: string;
    pushDestination?: string;
    forcePush?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<AutopilotPolicyDecision> {
  await ensureRuntimeHome(paths);
  const [registry, appConfig, worktreeSnapshot] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
    listWorktrees(paths),
  ]);
  const worktree = input.worktreeId
    ? worktreeSnapshot.worktrees.find((item) => item.id === input.worktreeId)
    : undefined;
  const repoId = input.repoId ?? worktree?.repoId;
  const repo = registry.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    return emptyPolicyFailure(
      repoId ?? 'unknown',
      'Repository is not configured.',
    );
  }
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    prNumber: worktree?.prNumber,
  });
  const repoFullName = `${repo.github.owner}/${repo.github.name}`;
  const localPath = worktree?.localPath ?? repo.path;
  const diffBase = input.diffBaseRef ?? worktree?.headSha ?? 'HEAD';
  const diff = await gitDiff(localPath, {
    base: diffBase,
    includePatch: true,
    maxPatchBytes: 128 * 1024,
  });
  const files = await Promise.all(
    diff.files.map((file) => classifyFileRisk(localPath, file, policy.limits)),
  );
  const totalLines = diff.summary.additions + diff.summary.deletions;
  const reasons: string[] = [];
  const requires = new Set<string>();

  if (diff.summary.files > policy.limits.maxFilesChanged) {
    reasons.push(
      `Changed ${diff.summary.files} files, above maxFilesChanged=${policy.limits.maxFilesChanged}.`,
    );
    requires.add('maxFilesChanged');
  }
  if (totalLines > policy.limits.maxLinesChanged) {
    reasons.push(
      `Changed ${totalLines} lines, above maxLinesChanged=${policy.limits.maxLinesChanged}.`,
    );
    requires.add('maxLinesChanged');
  }
  const deniedFiles = files.filter((file) => file.denied);
  for (const file of deniedFiles) {
    reasons.push(`${file.path} matches denied autopilot policy.`);
    requires.add('deniedFileGlobs');
  }
  const riskyFiles = files.filter((file) => file.approvalRequired);
  for (const file of riskyFiles) {
    reasons.push(`${file.path} requires approval: ${file.reasons.join(', ')}.`);
    requires.add('approval');
  }
  if (input.forcePush && !policy.limits.allowForcePush) {
    reasons.push('Force-push is disabled by autopilot policy.');
    requires.add('allowForcePush');
  }
  const forcePushBlocked = Boolean(
    input.forcePush && !policy.limits.allowForcePush,
  );
  let pushDestinationBlocked = false;
  if (
    input.pushDestination &&
    !policy.limits.allowedPushDestinations.includes(input.pushDestination)
  ) {
    pushDestinationBlocked = true;
    reasons.push(
      `Push destination "${input.pushDestination}" is not in allowedPushDestinations.`,
    );
    requires.add('allowedPushDestinations');
  }
  if (policy.limits.requiredChecks.length > 0) {
    reasons.push(
      `Required checks before push: ${policy.limits.requiredChecks.join(', ')}.`,
    );
  }

  const blocked =
    deniedFiles.length > 0 || forcePushBlocked || pushDestinationBlocked;
  const approvalRequired =
    !blocked &&
    (riskyFiles.length > 0 ||
      diff.summary.files > policy.limits.maxFilesChanged ||
      totalLines > policy.limits.maxLinesChanged ||
      Boolean(input.forcePush && !policy.limits.allowForcePush));

  return {
    ok: true,
    action: 'autopilot_policy_check',
    changed: false,
    message: blocked
      ? 'Autopilot policy blocks this worktree diff.'
      : approvalRequired
        ? 'Autopilot policy requires explicit approval for this worktree diff.'
        : 'Autopilot policy allows this worktree diff to proceed to verification.',
    repoId: repo.id,
    repoFullName,
    prNumber: worktree?.prNumber ?? null,
    mode: policy.mode,
    limits: policy.limits,
    concurrency: policy.concurrency,
    diff: {
      base: diff.base,
      filesChanged: diff.summary.files,
      linesChanged: totalLines,
      additions: diff.summary.additions,
      deletions: diff.summary.deletions,
      binaryFiles: diff.summary.binaryFiles,
    },
    files,
    blocked,
    approvalRequired,
    canPush:
      policy.mode === 'autofix-push-when-safe' && !blocked && !approvalRequired,
    reasons,
    requires: [...requires],
    fetchedAt: new Date().toISOString(),
  };
}

export async function checkAutopilotConcurrency(
  input: {
    repoId: string;
    prNumber?: number | null;
    workflow: string;
    mutation?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<AutopilotConcurrencyDecision> {
  await ensureRuntimeHome(paths);
  const appConfig = await readRuntimeJson(paths.config, parseAppConfig);
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const worktreeSnapshot = await listWorktrees(paths);
  const repo = registry.repos.find(
    (candidate) => candidate.id === input.repoId,
  );
  const limits = repo
    ? repoAutopilotPolicy(repo, appConfig).concurrency
    : globalAutopilotPolicy(appConfig).concurrency;
  const activeRuns = readActiveAutopilotRuns(paths);
  const activeRunIds = new Set(activeRuns.map((run) => run.run_id));
  const activeWorkflowRuns = activeRuns.length;
  const activeWorktrees = worktreeSnapshot.worktrees.filter((worktree) => {
    if (worktree.owningWorkflowRunId) {
      return activeRunIds.has(worktree.owningWorkflowRunId);
    }
    if (worktree.lifecycleStatus !== 'busy') return false;
    return input.workflow !== 'verify_pr_worktree';
  });
  const perRepoAutonomousJobs = activeWorktrees.filter(
    (worktree) => worktree.repoId === input.repoId,
  ).length;
  const samePrMutationWorkflows = activeWorktrees.filter(
    (worktree) =>
      input.prNumber !== null &&
      input.prNumber !== undefined &&
      worktree.repoId === input.repoId &&
      worktree.prNumber === input.prNumber &&
      (worktree.owningWorkflowRunId
        ? mutationWorkflowNames.has(
            normalizeWorkflowName(
              activeRuns.find(
                (run) => run.run_id === worktree.owningWorkflowRunId,
              )?.workflow ?? '',
            ),
          )
        : true),
  ).length;
  const reasons: string[] = [];
  if (activeWorkflowRuns >= limits.maxActiveWorkflowRuns) {
    reasons.push(
      `Active autopilot workflow limit reached (${activeWorkflowRuns}/${limits.maxActiveWorkflowRuns}).`,
    );
  }
  if (activeWorkflowRuns >= limits.maxAutonomousJobs) {
    reasons.push(
      `Global autonomous job limit reached (${activeWorkflowRuns}/${limits.maxAutonomousJobs}).`,
    );
  }
  if (perRepoAutonomousJobs >= limits.maxPerRepoAutonomousJobs) {
    reasons.push(
      `Per-repo autonomous job limit reached for ${input.repoId} (${perRepoAutonomousJobs}/${limits.maxPerRepoAutonomousJobs}).`,
    );
  }
  if (
    limits.singleMutationPerPr &&
    input.mutation !== false &&
    samePrMutationWorkflows > 0
  ) {
    reasons.push(
      `A mutation workflow is already active for ${input.repoId}#${input.prNumber}.`,
    );
  }

  return {
    ok: reasons.length === 0,
    action: 'autopilot_concurrency_check',
    changed: false,
    message:
      reasons.length === 0
        ? 'Autopilot concurrency allows admission.'
        : 'Autopilot concurrency blocks admission.',
    allowed: reasons.length === 0,
    repoId: input.repoId,
    prNumber: input.prNumber ?? null,
    workflow: input.workflow,
    mutation: input.mutation !== false,
    limits,
    usage: {
      autonomousJobs: activeWorkflowRuns,
      activeWorkflowRuns,
      perRepoAutonomousJobs,
      samePrMutationWorkflows,
      localExecutions: activeLocalExecutions,
    },
    reasons,
  };
}

export async function withAutopilotLocalExecutionSlot<T>(
  limits: AutopilotConcurrencyPolicy,
  run: () => Promise<T>,
): Promise<T | { blocked: true; message: string }> {
  if (activeLocalExecutions >= limits.localExecutionLimit) {
    return {
      blocked: true,
      message: `Local execution concurrency limit reached (${activeLocalExecutions}/${limits.localExecutionLimit}).`,
    };
  }
  activeLocalExecutions += 1;
  try {
    return await run();
  } finally {
    activeLocalExecutions -= 1;
  }
}
