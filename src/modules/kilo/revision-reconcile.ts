import { addNotification, addWorkflowSummary } from '../app-state';
import { readWorktreeRecord } from '../worktrees';
import type { KiloTaskRecord, KiloTaskStatus } from './store';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { gitCurrentSha } from '../../repo-edit/git';
import {
  ensurePreparedDiffForWorktree,
  mergeSummary,
  readPreparedDiffByWorktreeId,
  updatePreparedDiffState,
} from '../prepared-diffs';

type RevisionTaskDiff = {
  ok: boolean;
  fileCount: number;
  error?: string;
};

export async function reconcilePreparedDiffRevisionResult(
  input: {
    task: KiloTaskRecord;
    status: KiloTaskStatus;
    diff?: RevisionTaskDiff | null;
    error?: string | null;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  if (!input.task.worktreeId) return null;
  const current = readPreparedDiffByWorktreeId(input.task.worktreeId, paths);
  if (!current) return null;
  const revisionRun = revisionRunField(current.summary);
  if (revisionRun.kiloTaskId !== input.task.id) return null;
  if (current.status === 'abandoned') return null;

  const completedAt = new Date().toISOString();
  const currentHeadSha = await gitCurrentSha(current.sourceWorktreePath).catch(
    () => null,
  );
  const hasWorkingTreeDiff =
    input.diff?.ok === true && input.diff.fileCount > 0;
  const hasCommittedRevision = Boolean(
    currentHeadSha &&
    revisionRun.startedHeadSha &&
    currentHeadSha !== revisionRun.startedHeadSha,
  );
  if (
    isCompletedRevisionStatus(input.status, hasCommittedRevision) &&
    (hasWorkingTreeDiff || hasCommittedRevision)
  ) {
    const worktree = readWorktreeRecord(current.worktreeId, paths);
    const prepared = await ensurePreparedDiffForWorktree(worktree, paths, {
      resetDecisionState: true,
      summary: mergeSummary(current.summary, {
        revisionRun: {
          ...revisionRun,
          kiloTaskId: input.task.id,
          status: input.status,
          outcome: 'completed',
          completedAt,
          changedFiles: input.diff?.fileCount ?? 0,
          completedHeadSha: currentHeadSha,
        },
      }),
    });
    await addWorkflowSummary(
      {
        workflow: 'prepared_diff_revision_run',
        runId: input.task.id,
        status: 'completed',
        summary: {
          preparedDiffId: prepared.id,
          kiloTaskId: input.task.id,
          reason: revisionRun.reason ?? null,
          outcome: 'completed',
        },
      },
      paths,
    );
    await addNotification(
      {
        level: 'ready',
        title: 'Revision run finished',
        message:
          'Revision run finished; a new prepared diff is awaiting review.',
        source: 'autopilot',
        sourceId: `prepared-diff:${prepared.id}:revision-run:completed`,
        data: {
          preparedDiffId: prepared.id,
          worktreeId: prepared.worktreeId,
          kiloTaskId: input.task.id,
        },
      },
      paths,
    );
    return prepared;
  }

  const error =
    input.error ??
    input.task.error ??
    input.diff?.error ??
    (input.status === 'succeeded'
      ? 'Kilo completed without a reviewable diff.'
      : `Kilo task ended with status ${input.status}.`);
  const updated = updatePreparedDiffState(
    current.id,
    {
      status: 'revision-requested',
      pushApprovalStatus: 'rejected',
      summary: mergeSummary(current.summary, {
        revisionRun: {
          ...revisionRun,
          kiloTaskId: input.task.id,
          status: input.status,
          outcome: input.status === 'cancelled' ? 'aborted' : 'failed',
          completedAt,
          error,
        },
      }),
    },
    paths,
  );
  await addWorkflowSummary(
    {
      workflow: 'prepared_diff_revision_run',
      runId: input.task.id,
      status: input.status === 'cancelled' ? 'aborted' : 'failed',
      summary: {
        preparedDiffId: updated.id,
        kiloTaskId: input.task.id,
        reason: revisionRun.reason ?? null,
        outcome: input.status === 'cancelled' ? 'aborted' : 'failed',
        error,
      },
    },
    paths,
  );
  await addNotification(
    {
      level: 'attention',
      title: 'Revision run needs attention',
      message: error,
      source: 'autopilot',
      sourceId: `prepared-diff:${updated.id}:revision-run:failed`,
      data: {
        preparedDiffId: updated.id,
        worktreeId: updated.worktreeId,
        kiloTaskId: input.task.id,
      },
    },
    paths,
  );
  return updated;
}

function revisionRunField(summary: unknown) {
  const top = objectField(summary);
  const run = objectField(top.revisionRun);
  return {
    kiloTaskId: stringField(run.kiloTaskId),
    reason: stringField(run.reason) ?? stringField(top.revisionReason),
    startedAt: stringField(run.startedAt),
    startedHeadSha: stringField(run.startedHeadSha),
    approverSurface: stringField(run.approverSurface),
  };
}

function isCompletedRevisionStatus(
  status: KiloTaskStatus,
  hasCommittedRevision: boolean,
) {
  return (
    status === 'succeeded' ||
    status === 'needs-review' ||
    (status === 'unknown' && hasCommittedRevision)
  );
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
