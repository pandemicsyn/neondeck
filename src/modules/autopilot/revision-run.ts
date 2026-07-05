import * as v from 'valibot';
import { addNotification, addWorkflowSummary } from '../app-state';
import { abortKiloTask, startKiloTask, tryKiloTask } from '../kilo';
import { readWorktreeRecord } from '../worktrees';
import { gitCurrentSha, gitDiff } from '../../repo-edit/git';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { asJsonValue } from '../../lib/action-result';
import {
  abandonPreparedDiff,
  abandonInputSchema,
  assertTransition,
  mergeSummary,
  runRevisionInputSchema,
  type PreparedDiffActionResult,
  readPreparedDiffRecord,
  updatePreparedDiffState,
} from '../prepared-diffs';

type StartKiloTask = typeof startKiloTask;
type AbortKiloTask = typeof abortKiloTask;

export async function runPreparedDiffRevision(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    startKiloTask?: StartKiloTask;
    abortKiloTask?: AbortKiloTask;
  } = {},
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    runRevisionInputSchema,
    rawInput,
    'prepared_diff_run_revision',
  );
  if (!parsed.ok) return parsed.result;

  const loaded = readPreparedDiffRecord(parsed.input.preparedDiffId, paths);
  if (!loaded) {
    return failure(
      'prepared_diff_run_revision',
      `Prepared diff ${parsed.input.preparedDiffId} was not found.`,
      'PREPARED_DIFF_NOT_FOUND',
    );
  }
  const transition = assertTransition(
    loaded,
    'prepared_diff_run_revision',
    'run-revision',
    ['revision-requested'],
  );
  if (!transition.ok) return transition.result;

  const reason =
    nonEmpty(parsed.input.reason) ??
    nonEmpty(objectField(loaded.summary).revisionReason);
  if (!reason) {
    return {
      ok: false,
      action: 'prepared_diff_run_revision',
      changed: false,
      message: 'Running a prepared-diff revision requires a revision note.',
      requires: ['reason'],
      errors: ['reason is required.'],
    };
  }

  try {
    readWorktreeRecord(loaded.worktreeId, paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action: 'prepared_diff_run_revision',
      changed: false,
      message,
      preparedDiff: loaded,
      requires: ['worktreeId'],
      errors: [message],
      error: {
        code: errorCode(error),
        message,
      },
    };
  }

  const startedHeadSha = await gitCurrentSha(loaded.sourceWorktreePath).catch(
    () => null,
  );
  const prompt = await revisionPrompt(loaded, reason);
  const starter = dependencies.startKiloTask ?? startKiloTask;
  const startedAt = new Date().toISOString();
  const taskResult = await starter(
    {
      title: `Revise prepared diff ${loaded.repoFullName}#${loaded.prNumber ?? loaded.id}`,
      prompt,
      worktreeId: loaded.worktreeId,
      mode: 'draft-fix',
      allowAuto: true,
      confirmAuto: true,
      explicitUserRequest: true,
    },
    paths,
  );

  if (!taskResult.ok) {
    const current = readPreparedDiffRecord(loaded.id, paths) ?? loaded;
    if (current.status !== 'revision-requested') {
      return {
        ok: false,
        action: 'prepared_diff_run_revision',
        changed: false,
        message: taskResult.message,
        preparedDiff: current,
        error: { code: 'KILO_START_FAILED', message: taskResult.message },
        errors: [taskResult.message],
      };
    }
    const failed = updatePreparedDiffState(
      current.id,
      {
        status: 'revision-requested',
        summary: mergeSummary(current.summary, {
          revisionRun: {
            kiloTaskId: null,
            reason,
            approverSurface: parsed.input.approverSurface ?? null,
            startedAt,
            startedHeadSha,
            outcome: 'failed',
            error: taskResult.message,
          },
        }),
      },
      paths,
    );
    await addWorkflowSummary(
      {
        workflow: 'prepared_diff_revision_run',
        status: 'failed',
        summary: {
          preparedDiffId: failed.id,
          kiloTaskId: null,
          reason,
          outcome: 'failed',
          error: taskResult.message,
        },
      },
      paths,
    );
    return {
      ok: false,
      action: 'prepared_diff_run_revision',
      changed: true,
      message: taskResult.message,
      preparedDiff: failed,
      error: { code: 'KILO_START_FAILED', message: taskResult.message },
      errors: [taskResult.message],
    };
  }

  const taskData = taskResult as {
    taskId?: unknown;
    task?: Record<string, unknown>;
  };
  const taskId = stringField(taskData.taskId) ?? stringField(taskData.task?.id);
  const current = readPreparedDiffRecord(loaded.id, paths) ?? loaded;
  const latestTransition = assertTransition(
    current,
    'prepared_diff_run_revision',
    'run-revision',
    ['revision-requested'],
  );
  if (!latestTransition.ok) {
    if (taskId) {
      const aborter = dependencies.abortKiloTask ?? abortKiloTask;
      const aborted = await aborter({ taskId }, paths).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (!aborted.ok) {
        await addWorkflowSummary(
          {
            workflow: 'prepared_diff_revision_run',
            runId: taskId,
            status: 'failed',
            summary: {
              preparedDiffId: current.id,
              kiloTaskId: taskId,
              reason,
              outcome: 'abort-failed-after-stale-transition',
              currentStatus: current.status,
              error: aborted.message,
            },
          },
          paths,
        );
        return {
          ok: false,
          action: 'prepared_diff_run_revision',
          changed: true,
          message: `Started Kilo revision task ${taskId}, but the prepared diff no longer accepts a revision run and abort failed: ${aborted.message}`,
          preparedDiff: current,
          requires: ['revisionRunAbort'],
          errors: [aborted.message],
          error: {
            code: 'REVISION_RUN_ABORT_FAILED',
            message: aborted.message,
          },
        };
      }
      await addWorkflowSummary(
        {
          workflow: 'prepared_diff_revision_run',
          runId: taskId,
          status: 'aborted',
          summary: {
            preparedDiffId: current.id,
            kiloTaskId: taskId,
            reason,
            outcome: 'aborted-after-stale-transition',
            currentStatus: current.status,
          },
        },
        paths,
      );
    }
    return latestTransition.result;
  }
  const running = updatePreparedDiffState(
    current.id,
    {
      status: 'revision-in-progress',
      summary: mergeSummary(current.summary, {
        revisionReason: reason,
        revisionRun: {
          kiloTaskId: taskId ?? null,
          reason,
          approverSurface: parsed.input.approverSurface ?? null,
          startedAt,
          startedHeadSha,
          outcome: 'started',
          status: stringField(taskData.task?.status) ?? 'running',
          title: stringField(taskData.task?.title) ?? null,
          cwd: stringField(taskData.task?.cwd) ?? current.sourceWorktreePath,
        },
      }),
    },
    paths,
  );
  await addWorkflowSummary(
    {
      workflow: 'prepared_diff_revision_run',
      runId: taskId,
      status: 'started',
      summary: {
        preparedDiffId: running.id,
        kiloTaskId: taskId ?? null,
        reason,
        outcome: 'started',
      },
    },
    paths,
  );
  await addNotification(
    {
      level: 'info',
      title: 'Revision run started',
      message: 'Started a Kilo revision run for the prepared diff.',
      source: 'autopilot',
      sourceId: `prepared-diff:${running.id}:revision-run:started`,
      data: {
        preparedDiffId: running.id,
        worktreeId: running.worktreeId,
        kiloTaskId: taskId ?? null,
      },
    },
    paths,
  );

  return {
    ok: true,
    action: 'prepared_diff_run_revision',
    changed: true,
    message: 'Started prepared diff revision run.',
    preparedDiff: running,
    data: asJsonValue({ kiloTaskId: taskId ?? null }),
  };
}

export async function abandonPreparedDiffWithRevisionAbort(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: { abortKiloTask?: AbortKiloTask } = {},
): Promise<PreparedDiffActionResult> {
  const parsed = parseInput(
    abandonInputSchema,
    rawInput,
    'prepared_diff_abandon',
  );
  if (!parsed.ok) return parsed.result;
  const loaded = readPreparedDiffRecord(parsed.input.preparedDiffId, paths);
  if (loaded?.status !== 'revision-in-progress') {
    return abandonPreparedDiff(rawInput, paths);
  }
  if (parsed.input.confirm !== true) {
    return abandonPreparedDiff(rawInput, paths);
  }

  const kiloTaskId = stringField(
    objectField(objectField(loaded.summary).revisionRun).kiloTaskId,
  );
  const task = kiloTaskId ? tryKiloTask(kiloTaskId, paths) : undefined;
  if (task?.status === 'running') {
    const aborter = dependencies.abortKiloTask ?? abortKiloTask;
    const aborted = await aborter({ taskId: task.id }, paths);
    if (!aborted.ok) {
      return {
        ok: false,
        action: 'prepared_diff_abandon',
        changed: false,
        message: `Revision run must be stopped before abandoning: ${aborted.message}`,
        preparedDiff: loaded,
        requires: ['revisionRunAbort'],
        errors: [aborted.message],
        error: { code: 'REVISION_RUN_ABORT_FAILED', message: aborted.message },
      };
    }
  }
  if (task?.status === 'needs-reconcile') {
    return {
      ok: false,
      action: 'prepared_diff_abandon',
      changed: false,
      message:
        'Revision run needs reconciliation before this prepared diff can be abandoned.',
      preparedDiff: loaded,
      requires: ['revisionRunReconcile'],
      errors: ['revision run must be reconciled before abandon.'],
      error: {
        code: 'REVISION_RUN_NEEDS_RECONCILE',
        message:
          'Revision run needs reconciliation before this prepared diff can be abandoned.',
      },
    };
  }

  return abandonPreparedDiff(rawInput, paths, { revisionRunAborted: true });
}

async function revisionPrompt(
  record: {
    id: string;
    repoFullName: string;
    prNumber: number | null;
    title: string;
    sourceWorktreePath: string;
    baseRef: string;
    summary: unknown;
  },
  reason: string,
) {
  const diff = await gitDiff(record.sourceWorktreePath, {
    base: record.baseRef,
    includePatch: false,
  }).catch(() => null);
  const files = diff?.files.map((file) => file.path) ?? [];
  const summary = objectField(record.summary);
  const verification = objectField(summary.verification);
  return [
    'Revise this Neondeck prepared diff in the retained managed worktree.',
    '',
    'Revision note, verbatim:',
    reason,
    '',
    `Prepared diff: ${record.id}`,
    `PR: ${record.repoFullName}#${record.prNumber ?? 'worktree'}`,
    `Title: ${record.title}`,
    `Worktree: ${record.sourceWorktreePath}`,
    `Base ref: ${record.baseRef}`,
    `Changed files: ${files.length > 0 ? files.join(', ') : 'none read'}`,
    `Verification status: ${stringField(verification.status) ?? 'not recorded'}`,
    `Verification detail: ${stringField(verification.error) ?? stringField(verification.message) ?? 'not recorded'}`,
    '',
    'Bounds:',
    '- Modify only this managed worktree.',
    '- Commit the revision locally.',
    '- Never push branches or open PRs.',
    '- Keep changes scoped to the revision note.',
    '- Leave final review, verification, and push approval to Neondeck.',
  ].join('\n');
}

function parseInput<T>(
  schema: v.GenericSchema<T>,
  input: unknown,
  action: string,
):
  | { ok: true; input: T }
  | {
      ok: false;
      result: PreparedDiffActionResult;
    } {
  const parsed = v.safeParse(schema, input);
  if (parsed.success) return { ok: true, input: parsed.output };
  const message = parsed.issues.map((issue) => issue.message).join('; ');
  return {
    ok: false,
    result: failure(
      action,
      `Invalid prepared-diff input: ${message}`,
      'INVALID_INPUT',
    ),
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nonEmpty(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'WORKTREE_ERROR';
}

function failure(action: string, message: string, code: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code, message },
  };
}
