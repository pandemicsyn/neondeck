import { asJsonValue } from '../../lib/action-result';
import {
  addNotification,
  findWorkflowSummaryByKiloTaskId,
  updateWorkflowSummary,
} from '../app-state';
import { ensurePreparedDiffForWorktree, mergeSummary } from '../prepared-diffs';
import { releaseWorktreeLock, readWorktreeRecord } from '../worktrees';
import type { KiloTaskRecord, KiloTaskStatus } from './store';
import { gitCurrentSha } from '../../repo-edit/git';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';

type CiFixTaskDiff = {
  ok: boolean;
  fileCount: number;
  error?: string;
};

export async function reconcileCiFixRunForKiloTask(
  input: {
    task: KiloTaskRecord;
    status: KiloTaskStatus;
    diff?: CiFixTaskDiff | null;
    error?: string | null;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const summary = await findWorkflowSummaryByKiloTaskId(
    'ci_fix_run',
    input.task.id,
    paths,
  );
  if (!summary || summary.status !== 'running') return null;
  const summaryData = objectField(summary.summary);
  const summaryJson = asJsonValue(summaryData);
  const reportId = stringField(summaryData.reportId);
  const sourceRef =
    stringField(summaryData.pr) ??
    `${stringField(summaryData.repoFullName) ?? input.task.repoFullName}#${numberField(summaryData.prNumber) ?? 'worktree'}`;
  const ciFixLockId = stringField(summaryData.ciFixLockId);
  const worktreeId =
    input.task.worktreeId ?? stringField(summaryData.worktreeId);
  const completedAt = new Date().toISOString();

  try {
    const currentHeadSha = await gitCurrentSha(input.task.cwd).catch(
      () => null,
    );
    const hasDiff = input.diff?.ok === true && input.diff.fileCount > 0;
    if (isPreparedDiffStatus(input.status) && hasDiff && worktreeId) {
      const worktree = readWorktreeRecord(worktreeId, paths);
      const preparedDiff = await ensurePreparedDiffForWorktree(
        worktree,
        paths,
        {
          title: `CI fix for ${sourceRef}`,
          createdBy: 'ci_fix_run',
          resetDecisionState: true,
          summary: mergeSummary(summaryJson, {
            outcome: 'prepared-diff',
            completedAt,
            completedHeadSha: currentHeadSha,
            changedFiles: input.diff?.fileCount ?? 0,
            kiloStatus: input.status,
          }),
        },
      );
      if (ciFixLockId) {
        await releaseWorktreeLock(
          {
            lockId: ciFixLockId,
            owner: 'ci-fix-run',
            finalStatus: 'prepared-diff',
          },
          paths,
        ).catch(() => undefined);
      }
      const nextSummary = mergeSummary(summaryJson, {
        outcome: 'prepared-diff',
        preparedDiffId: preparedDiff.id,
        completedAt,
        completedHeadSha: currentHeadSha,
        changedFiles: input.diff?.fileCount ?? 0,
        kiloStatus: input.status,
      });
      await updateWorkflowSummary(
        summary.id,
        { status: 'completed', summary: nextSummary },
        paths,
      );
      await addNotification(
        {
          level: 'ready',
          title: 'CI fix prepared',
          message:
            'Kilo finished a CI fix; a prepared diff is waiting for review.',
          source: 'autopilot',
          sourceId: `ci-fix:${input.task.id}:prepared-diff`,
          data: {
            sourceRef,
            reportId,
            reportUrl: reportId ? `/reports/${reportId}` : null,
            kiloTaskId: input.task.id,
            preparedDiffId: preparedDiff.id,
            worktreeId,
          },
        },
        paths,
      );
      return preparedDiff;
    }

    const outcome =
      input.status === 'cancelled'
        ? 'cancelled'
        : input.status === 'succeeded'
          ? 'no-op'
          : 'failed';
    const message =
      input.error ??
      input.task.error ??
      input.diff?.error ??
      (outcome === 'no-op'
        ? 'Kilo completed without a reviewable diff.'
        : `Kilo task ended with status ${input.status}.`);
    if (ciFixLockId) {
      await releaseWorktreeLock(
        {
          lockId: ciFixLockId,
          owner: 'ci-fix-run',
          finalStatus: outcome === 'no-op' ? 'ready' : 'failed',
        },
        paths,
      ).catch(() => undefined);
    }
    await updateWorkflowSummary(
      summary.id,
      {
        status: outcome === 'no-op' ? 'completed' : 'failed',
        summary: mergeSummary(summaryJson, {
          outcome,
          completedAt,
          completedHeadSha: currentHeadSha,
          changedFiles: input.diff?.fileCount ?? 0,
          kiloStatus: input.status,
          error: message,
        }),
      },
      paths,
    );
    await addNotification(
      {
        level: 'attention',
        title: 'CI fix needs attention',
        message,
        source: 'autopilot',
        sourceId: `ci-fix:${input.task.id}:${outcome}`,
        data: {
          sourceRef,
          outcome,
          reportId,
          reportUrl: reportId ? `/reports/${reportId}` : null,
          kiloTaskId: input.task.id,
          worktreeId,
        },
      },
      paths,
    );
  } catch (error) {
    if (ciFixLockId) {
      await releaseWorktreeLock(
        { lockId: ciFixLockId, owner: 'ci-fix-run', finalStatus: 'failed' },
        paths,
      ).catch(() => undefined);
    }
    await updateWorkflowSummary(
      summary.id,
      {
        status: 'failed',
        summary: mergeSummary(summaryJson, {
          outcome: 'reconcile-failed',
          completedAt,
          error: errorMessage(error),
        }),
      },
      paths,
    ).catch(() => undefined);
    await addNotification(
      {
        level: 'attention',
        title: 'CI fix reconciliation failed',
        message: errorMessage(error),
        source: 'autopilot',
        sourceId: `ci-fix:${input.task.id}:reconcile-failed`,
        data: {
          sourceRef,
          reportId,
          reportUrl: reportId ? `/reports/${reportId}` : null,
          kiloTaskId: input.task.id,
          worktreeId,
        },
      },
      paths,
    ).catch(() => undefined);
  }
  return null;
}

function isPreparedDiffStatus(status: KiloTaskStatus) {
  return (
    status === 'succeeded' ||
    status === 'needs-review' ||
    status === 'ready-to-verify' ||
    status === 'ready-to-push' ||
    status === 'unknown'
  );
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
