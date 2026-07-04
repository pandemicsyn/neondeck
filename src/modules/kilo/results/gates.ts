import { createHash } from 'node:crypto';
import { checkAutopilotPolicy } from '../../autopilot-policy';
import { gitDiff } from '../../../repo-edit/git';
import { type RepoDiffSummary } from '../../repos';
import { type RuntimePaths } from '../../../runtime-home';
import { listWorktrees, type WorktreeRecord } from '../../worktrees';
import {
  type KiloResultActionResult,
  type KiloResultClassification,
  type KiloResultState,
  type KiloTaskLike,
} from './schemas';
import { errorMessage } from './state';

export function classifyReview(
  task: KiloTaskLike,
  diff: RepoDiffSummary,
  worktree: WorktreeRecord | null,
  policy: Awaited<ReturnType<typeof checkAutopilotPolicy>> | null,
): KiloResultClassification {
  if (!diff.ok) {
    return 'needs-review';
  }
  if (task.status === 'failed' || task.status === 'unknown') {
    return diff.fileCount > 0 ? 'needs-review' : 'discard';
  }
  if (diff.fileCount === 0) return 'discard';
  if (!worktree || !policy?.ok || policy.blocked || policy.approvalRequired) {
    return 'needs-review';
  }
  if (policy.limits.requiredChecks.length > 0) return 'ready-to-verify';
  return policy.mode === 'autofix-push-when-safe'
    ? 'ready-to-push'
    : 'needs-review';
}

export function reviewReasons(
  task: KiloTaskLike,
  diff: RepoDiffSummary,
  worktree: WorktreeRecord | null,
  policy: Awaited<ReturnType<typeof checkAutopilotPolicy>> | null,
) {
  const reasons: string[] = [];
  if (!diff.ok) reasons.push(diff.error ?? 'Diff could not be read.');
  if (diff.fileCount === 0) reasons.push('No changed files were observed.');
  if (task.status === 'failed') reasons.push('Kilo task failed.');
  if (task.status === 'unknown') reasons.push('Kilo task outcome is unknown.');
  if (!worktree) reasons.push('No managed worktree is linked to this task.');
  if (policy?.reasons.length) reasons.push(...policy.reasons);
  return reasons;
}

export function taskStatusForClassification(
  classification: KiloResultClassification,
) {
  if (classification === 'discard') return 'discarded';
  return classification;
}

export function assertReviewableTask(
  task: KiloTaskLike,
  action: string,
):
  | { ok: true }
  | {
      ok: false;
      result: KiloResultActionResult;
    } {
  const allowed = new Set([
    'succeeded',
    'failed',
    'unknown',
    'needs-review',
    'ready-to-verify',
    'ready-to-push',
  ]);
  if (allowed.has(task.status)) return { ok: true };
  return {
    ok: false,
    result: {
      ok: false,
      action,
      changed: false,
      message: `Kilo task ${task.id} is ${task.status}; review and verification require a completed result.`,
      task,
      requires: ['completed-kilo-task'],
    },
  };
}

export async function assertVerificationGate(
  task: KiloTaskLike,
  state: KiloResultState | null,
  paths: RuntimePaths,
): Promise<
  | { ok: true; fingerprint: string }
  | { ok: false; message: string; requires: string[] }
> {
  if (!state) {
    return {
      ok: false,
      message: 'Kilo result must be reviewed before verification.',
      requires: ['review_kilo_result'],
    };
  }
  if (state.classification !== 'ready-to-verify') {
    return {
      ok: false,
      message: `Kilo result is ${state.classification}, not ready-to-verify.`,
      requires: ['ready-to-verify'],
    };
  }
  const diff = await readTaskDiff(task);
  if (!diff.ok || diff.fileCount === 0) {
    return {
      ok: false,
      message: 'Kilo result has no reviewable diff to verify.',
      requires: ['reviewable-diff'],
    };
  }
  const fingerprint = await diffFingerprintForTask(task, diff);
  if (state.diffFingerprint !== fingerprint) {
    return {
      ok: false,
      message:
        'Kilo result diff changed after review; run review_kilo_result again before verification.',
      requires: ['review_kilo_result'],
    };
  }
  if (!task.worktreeId || !(await findTaskWorktree(task, paths))) {
    return {
      ok: false,
      message: 'Kilo verification requires a managed worktree.',
      requires: ['worktreeId'],
    };
  }
  return { ok: true, fingerprint };
}

export async function diffFingerprintForTask(
  task: KiloTaskLike,
  diff: RepoDiffSummary,
) {
  const patch = await gitDiff(task.cwd, {
    base: 'HEAD',
    includePatch: true,
    maxPatchBytes: 1024 * 1024,
  }).catch(() => null);
  return createHash('sha256')
    .update(
      JSON.stringify({
        ok: diff.ok,
        baseRef: diff.baseRef,
        fileCount: diff.fileCount,
        additions: diff.additions,
        deletions: diff.deletions,
        binaryFiles: diff.binaryFiles,
        files: diff.files
          .map((file) => ({
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        patches:
          patch?.files
            .map((file) => ({
              path: file.path,
              status: file.status,
              patch: file.patch ?? null,
              truncated: file.truncated ?? false,
            }))
            .sort((a, b) => a.path.localeCompare(b.path)) ?? null,
      }),
    )
    .digest('hex');
}

export async function readTaskDiff(
  task: KiloTaskLike,
): Promise<RepoDiffSummary> {
  try {
    const diff = await gitDiff(task.cwd, { base: 'HEAD', includePatch: false });
    return {
      ok: true,
      repo: task.repoFullName,
      path: task.cwd,
      baseRef: 'HEAD',
      files: diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
      fileCount: diff.files.length,
      additions: diff.summary.additions,
      deletions: diff.summary.deletions,
      binaryFiles: diff.summary.binaryFiles,
    } satisfies RepoDiffSummary;
  } catch (error) {
    return {
      ok: false,
      repo: task.repoFullName,
      path: task.cwd,
      baseRef: 'HEAD',
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      error: errorMessage(error),
    } satisfies RepoDiffSummary;
  }
}

export async function findTaskWorktree(
  task: KiloTaskLike,
  paths: RuntimePaths,
) {
  if (!task.worktreeId) return null;
  const snapshot = await listWorktrees(paths);
  return (
    snapshot.worktrees.find((worktree) => worktree.id === task.worktreeId) ??
    null
  );
}
