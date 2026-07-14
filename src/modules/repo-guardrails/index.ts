import { createHash } from 'node:crypto';
import { gitDiff } from '../../repo-edit/git';
import {
  assertRepoRelativePathAllowed,
  RepoPathPolicyError,
} from '../../repo-edit/path-safety';
import {
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { listWorktrees } from '../worktrees';
import type { RepoGuardrails } from '../autopilot-policy/schemas';
import { classifyFileRisk, type FileRiskClassification } from './risk';

export type { FileRiskClassification } from './risk';
export type { RepoGuardrails } from '../autopilot-policy/schemas';
export * from './config';

export type RepoGuardrailViolation = {
  kind:
    | 'denied-path'
    | 'high-risk-file'
    | 'max-files'
    | 'max-lines'
    | 'force-push'
    | 'push-destination';
  path?: string;
  detail: string;
};

export type RepoGuardrailResult = {
  files: FileRiskClassification[];
  diffSummary: {
    files: number;
    lines: number;
    additions: number;
    deletions: number;
  };
  denied: RepoGuardrailViolation[];
  expansions: RepoGuardrailViolation[];
  policyHash: string;
};

export async function evaluateRepoGuardrails(
  input: {
    repoId?: string;
    worktreeId?: string;
    diffBaseRef?: string;
    pushDestination?: string;
    forcePush?: boolean;
    guardrails: RepoGuardrails;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<RepoGuardrailResult> {
  await ensureRuntimeHome(paths);
  const [registry, snapshot] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    listWorktrees(paths),
  ]);
  const worktree = input.worktreeId
    ? snapshot.worktrees.find((item) => item.id === input.worktreeId)
    : undefined;
  const repoId = input.repoId ?? worktree?.repoId;
  const repo = registry.repos.find((candidate) => candidate.id === repoId);
  if (!repo) throw new Error('Repository is not configured.');
  if (input.worktreeId && !worktree) {
    throw new Error(`Managed worktree "${input.worktreeId}" was not found.`);
  }

  const localPath = worktree?.localPath ?? repo.path;
  const diff = await gitDiff(localPath, {
    base: input.diffBaseRef ?? worktree?.headSha ?? 'HEAD',
    includePatch: true,
    maxPatchBytes: 128 * 1024,
  });
  const files = await Promise.all(
    diff.files.map((file) =>
      classifyFileRisk(localPath, file, input.guardrails),
    ),
  );
  const lines = diff.summary.additions + diff.summary.deletions;
  const denied: RepoGuardrailViolation[] = [];
  const expansions: RepoGuardrailViolation[] = [];

  for (const [index, file] of files.entries()) {
    try {
      assertRepoRelativePathAllowed(file.path);
      const previousPath = diff.files[index]?.previousPath;
      if (previousPath) assertRepoRelativePathAllowed(previousPath);
    } catch (error) {
      if (!(error instanceof RepoPathPolicyError)) throw error;
      denied.push({
        kind: 'denied-path',
        path: file.path,
        detail: error.message,
      });
      continue;
    }
    if (file.denied) {
      denied.push({
        kind: 'denied-path',
        path: file.path,
        detail: `${file.path} matches a denied file guardrail.`,
      });
    } else if (file.approvalRequired) {
      expansions.push({
        kind: 'high-risk-file',
        path: file.path,
        detail: `${file.path} is high risk: ${file.reasons.join(', ')}.`,
      });
    }
  }
  if (diff.summary.files > input.guardrails.maxFilesChanged) {
    expansions.push({
      kind: 'max-files',
      detail: `The diff changes ${diff.summary.files} files, above the ${input.guardrails.maxFilesChanged}-file limit.`,
    });
  }
  if (lines > input.guardrails.maxLinesChanged) {
    expansions.push({
      kind: 'max-lines',
      detail: `The diff changes ${lines} lines, above the ${input.guardrails.maxLinesChanged}-line limit.`,
    });
  }
  if (input.forcePush && !input.guardrails.allowForcePush) {
    expansions.push({
      kind: 'force-push',
      detail: 'This would force-push rewritten history.',
    });
  }
  if (
    input.pushDestination &&
    !input.guardrails.allowedPushDestinations.includes(input.pushDestination)
  ) {
    denied.push({
      kind: 'push-destination',
      detail: `Push destination "${input.pushDestination}" is outside the allowed destinations.`,
    });
  }

  return {
    files,
    diffSummary: {
      files: diff.summary.files,
      lines,
      additions: diff.summary.additions,
      deletions: diff.summary.deletions,
    },
    denied,
    expansions,
    policyHash: createHash('sha256')
      .update(JSON.stringify(input.guardrails))
      .digest('hex'),
  };
}

export function humanEffectSummary(violations: RepoGuardrailViolation[]) {
  return violations.map((violation) => violation.detail).join(' ');
}
