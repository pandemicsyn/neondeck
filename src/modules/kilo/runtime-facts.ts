import { type KiloNotificationFact } from './notifications';
import { readKiloResultStateSummary } from './results';
import { readGitDiffSummary } from '../repos';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { type KiloResultPlaceholder } from './schemas';
import { type KiloTaskRecord, type KiloTaskStatus } from './store';
import { splitRepoFullName } from './utils';
import { readWorktreeRecord } from '../worktrees';

export async function taskWithDiff(
  task: KiloTaskRecord,
  paths: RuntimePaths,
  notificationFacts: KiloNotificationFact[] = [],
) {
  const diff = await taskDiffSummary(task, paths);
  const resultState = readKiloResultStateSummary(task.id, paths);
  return taskWithRuntimeFacts(
    {
      ...task,
      changedFiles: diff.files.map((file) => file.path),
      diff,
      ...resultState,
    },
    notificationFacts,
  );
}

export function taskWithRuntimeFacts<T extends KiloTaskRecord>(
  task: T & {
    verificationState?: string;
    reviewClassification?: string | null;
    promotionState?: string;
    pendingApprovals?: unknown[];
  },
  notificationFacts: KiloNotificationFact[],
) {
  const latest = notificationFacts[0]?.state ?? null;
  return {
    ...task,
    notificationFacts,
    latestNotificationState: latest,
    resultPlaceholders: resultPlaceholdersForTask(task),
  };
}

function resultPlaceholdersForTask(task: {
  status: KiloTaskStatus;
  verificationState?: string;
  reviewClassification?: string | null;
  promotionState?: string;
  pendingApprovals?: unknown[];
}): KiloResultPlaceholder[] {
  const terminal = [
    'succeeded',
    'failed',
    'unknown',
    'needs-review',
    'ready-to-verify',
    'ready-to-push',
    'discarded',
  ].includes(task.status);
  const placeholders: KiloResultPlaceholder[] = [];
  if (terminal && !task.reviewClassification) {
    placeholders.push({
      type: 'review',
      status: 'pending',
      workflow: 'review_kilo_result',
      reason: 'Run review_kilo_result to classify the completed Kilo result.',
    });
  }
  if (
    task.reviewClassification === 'ready-to-verify' &&
    task.verificationState !== 'passed'
  ) {
    placeholders.push({
      type: 'verification',
      status:
        task.verificationState === 'blocked' ||
        task.verificationState === 'failed'
          ? 'blocked'
          : 'pending',
      workflow: 'verify_kilo_result',
      reason:
        task.verificationState === 'blocked'
          ? 'Verification is blocked by execution approval or policy.'
          : 'Run verify_kilo_result through execution policy before promotion.',
    });
  }
  if (
    (task.reviewClassification === 'ready-to-push' ||
      task.verificationState === 'passed') &&
    task.promotionState !== 'deferred'
  ) {
    placeholders.push({
      type: 'promotion',
      status: task.promotionState === 'blocked' ? 'blocked' : 'pending',
      workflow: 'promote_kilo_result',
      reason:
        task.promotionState === 'blocked'
          ? 'Promotion admission is blocked; inspect gates and pending approvals.'
          : 'Run promote_kilo_result to evaluate push/comment admission gates.',
    });
  }
  return placeholders;
}

export async function taskDiffSummary(
  task: KiloTaskRecord,
  paths: RuntimePaths = runtimePaths(),
) {
  let baseRef = 'HEAD';
  if (task.worktreeId) {
    try {
      baseRef = readWorktreeRecord(task.worktreeId, paths).baseRef;
    } catch {
      baseRef = 'HEAD';
    }
  }
  return readGitDiffSummary({
    path: task.cwd,
    github: splitRepoFullName(task.repoFullName),
    defaultBranch: baseRef,
  });
}

export function isTimeoutMessage(message: string | null) {
  return Boolean(message && /timed?\s*out|timeout/i.test(message));
}
