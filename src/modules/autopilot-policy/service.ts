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
  repoGuardrails,
  repoAutopilotPolicy,
  repoAutopilotPolicyForWatch,
} from './config';
import {
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
import { evaluateRepoGuardrails } from '../repo-guardrails';

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
  const watchId =
    worktree?.prNumber !== undefined && worktree.prNumber !== null
      ? `${repo.github.owner}/${repo.github.name}#${worktree.prNumber}`
      : undefined;
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: watchId,
    prNumber: worktree?.prNumber,
  });
  const guardrails = repoGuardrails(repo, appConfig);
  const repoFullName = `${repo.github.owner}/${repo.github.name}`;
  const diffBase = input.diffBaseRef ?? worktree?.headSha ?? 'HEAD';
  const evaluated = await evaluateRepoGuardrails(
    { ...input, diffBaseRef: diffBase, guardrails },
    paths,
  );
  const reasons = [...evaluated.denied, ...evaluated.expansions].map(
    (violation) => violation.detail,
  );
  const requires = new Set(
    [...evaluated.denied, ...evaluated.expansions].map((violation) =>
      requirementForViolation(violation.kind),
    ),
  );
  if (guardrails.requiredChecks.length > 0) {
    reasons.push(
      `Required checks before push: ${guardrails.requiredChecks.join(', ')}.`,
    );
  }

  const blocked = evaluated.denied.length > 0;
  const approvalRequired = !blocked && evaluated.expansions.length > 0;
  const decision = blocked
    ? ('deny' as const)
    : approvalRequired
      ? ('require-approval' as const)
      : ('allow' as const);
  return {
    ok: true,
    action: 'autopilot_policy_check',
    changed: false,
    message:
      decision === 'deny'
        ? 'Autopilot policy blocks this worktree diff.'
        : decision === 'require-approval'
          ? 'Autopilot policy requires explicit approval for this worktree diff.'
          : 'Autopilot policy allows this worktree diff to proceed to verification.',
    repoId: repo.id,
    repoFullName,
    prNumber: worktree?.prNumber ?? null,
    mode: policy.mode,
    limits: guardrails,
    concurrency: policy.concurrency,
    diff: {
      base: diffBase,
      filesChanged: evaluated.diffSummary.files,
      linesChanged: evaluated.diffSummary.lines,
      additions: evaluated.diffSummary.additions,
      deletions: evaluated.diffSummary.deletions,
      binaryFiles: evaluated.files.filter((file) => file.binary).length,
    },
    files: evaluated.files,
    decision,
    approvalClass: approvalRequired ? 'high-risk-diff' : null,
    policyHash: evaluated.policyHash,
    blocked,
    approvalRequired,
    canPush:
      policy.mode === 'autofix-push-when-safe' && !blocked && !approvalRequired,
    reasons,
    requires: [...requires],
    fetchedAt: new Date().toISOString(),
  };
}

function requirementForViolation(
  kind:
    | 'denied-path'
    | 'high-risk-file'
    | 'max-files'
    | 'max-lines'
    | 'force-push'
    | 'push-destination',
) {
  switch (kind) {
    case 'denied-path':
      return 'deniedFileGlobs';
    case 'high-risk-file':
      return 'approval';
    case 'max-files':
      return 'maxFilesChanged';
    case 'max-lines':
      return 'maxLinesChanged';
    case 'force-push':
      return 'allowForcePush';
    case 'push-destination':
      return 'allowedPushDestinations';
  }
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
    return worktree.lifecycleStatus === 'busy';
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
