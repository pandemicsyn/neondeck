import { execFile, spawn } from 'node:child_process';
import { type WriteStream } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { asJsonValue } from '../../lib/action-result';
import { notifyKiloState, resolveKiloNotifications } from './notifications';
import { taskDiffSummary, isTimeoutMessage } from './runtime-facts';
import { type RunningProcess } from './schemas';
import { searchKiloSessions } from './sessions';
import { searchKiloSessionsWithDisk } from './sessions-adapters';
import {
  addKiloTaskEvent,
  listReconcileableKiloTasks,
  markKiloTaskFinished,
  tryKiloTask,
  updateKiloTaskSessions,
  updateKiloTaskStatus,
  type KiloTaskRecord,
  type KiloTaskStatus,
} from './store';
import {
  errorMessage,
  eventType,
  extractSessionIds,
  parseJsonLine,
  summarizeEvent,
  topLevelSessionId,
  truncate,
  writeRawLog,
} from './utils';
import { type RuntimePaths } from '../../runtime-home';
import { releaseWorktreeLock } from '../worktrees';
import { reconcilePreparedDiffRevisionResult } from './revision-reconcile';

const execFileAsync = promisify(execFile);
export const runningProcesses = new Map<string, RunningProcess>();
export const terminalTaskIds = new Set<string>();

export function attachProcessHandlers(
  taskId: string,
  child: ReturnType<typeof spawn>,
  rawLog: WriteStream | undefined,
  paths: RuntimePaths,
) {
  let stderr = '';
  if (!child.stdout || !child.stderr) {
    throw new Error('Kilo process was spawned without stdout/stderr pipes.');
  }
  let settled = false;
  let settle: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  const cleanup = () => {
    runningProcesses.delete(taskId);
    terminalTaskIds.delete(taskId);
    rawLog?.end();
    settle();
  };
  const stdoutLines = createInterface({ input: child.stdout });
  const stderrLines = createInterface({ input: child.stderr });

  stdoutLines.on('line', (line) => {
    writeRawLog(rawLog, 'stdout', line);
    handleKiloLine(taskId, 'stdout', line, paths);
  });
  stderrLines.on('line', (line) => {
    stderr += `${line}\n`;
    writeRawLog(rawLog, 'stderr', line);
    addKiloTaskEvent(
      taskId,
      {
        eventType: 'stderr',
        stream: 'stderr',
        summary: truncate(line, 1_000),
        data: { line },
      },
      paths,
    );
  });
  child.on('error', (error) => {
    void (async () => {
      const task = tryKiloTask(taskId, paths);
      if (!task) return;
      markKiloTaskFinished(taskId, 'failed', null, errorMessage(error), paths);
      await releaseTaskLock(task, 'failed', paths);
      await reconcilePreparedDiffRevisionResult(
        {
          task,
          status: 'failed',
          error: errorMessage(error),
        },
        paths,
      );
      addKiloTaskEvent(
        taskId,
        {
          eventType: 'process.error',
          stream: 'system',
          summary: errorMessage(error),
          data: { error: errorMessage(error) },
        },
        paths,
      );
      await notifyKiloState(
        {
          taskId,
          state: 'failed',
          message: `Kilo task ${taskId} failed to start or continue: ${errorMessage(error)}`,
          repoId: task.repoId,
          repoFullName: task.repoFullName,
          worktreeId: task.worktreeId,
          sessionId: task.rootSessionId,
          data: { error: errorMessage(error) },
        },
        paths,
      );
    })().finally(cleanup);
  });
  child.on('exit', (code, signal) => {
    void (async () => {
      const task = tryKiloTask(taskId, paths);
      if (!task) return;
      const cancelled = task?.status === 'cancelled';
      const status = cancelled
        ? 'cancelled'
        : code === 0
          ? 'succeeded'
          : 'failed';
      const error =
        status === 'failed'
          ? truncate(
              stderr.trim() || `Kilo exited with code ${code ?? 'unknown'}.`,
              2_000,
            )
          : null;
      terminalTaskIds.add(taskId);
      if (!tryKiloTask(taskId, paths)?.rootSessionId) {
        await recoverMissingSessionId(taskId, paths);
      }
      const current = tryKiloTask(taskId, paths);
      markKiloTaskFinished(taskId, status, code, error, paths);
      let observedDiff:
        | Awaited<ReturnType<typeof taskDiffSummary>>
        | undefined;
      addKiloTaskEvent(
        taskId,
        {
          eventType: 'process.exit',
          stream: 'system',
          summary: signal
            ? `Kilo exited from signal ${signal}.`
            : `Kilo exited with code ${code ?? 'unknown'}.`,
          data: { code, signal },
        },
        paths,
      );
      if (status === 'cancelled') {
        await resolveKiloNotifications(taskId, ['started', 'progress'], paths);
      } else if (status === 'succeeded') {
        const diff = await taskDiffSummary(current ?? task);
        observedDiff = diff;
        if (diff.ok && diff.fileCount > 0) {
          await notifyKiloState(
            {
              taskId,
              state: 'completed',
              message: `Kilo task ${taskId} completed with ${diff.fileCount} changed file(s) and is ready for result review.`,
              repoId: current?.repoId ?? task.repoId,
              repoFullName: current?.repoFullName ?? task.repoFullName,
              worktreeId: current?.worktreeId ?? task.worktreeId,
              sessionId: current?.rootSessionId ?? task.rootSessionId,
              data: { status, code, signal, diff },
            },
            paths,
          );
        } else if (!diff.ok) {
          await notifyKiloState(
            {
              taskId,
              state: 'needs-review',
              title: 'Kilo result needs review',
              message: `Kilo task ${taskId} completed, but Neondeck could not read the workspace diff.`,
              repoId: current?.repoId ?? task.repoId,
              repoFullName: current?.repoFullName ?? task.repoFullName,
              worktreeId: current?.worktreeId ?? task.worktreeId,
              sessionId: current?.rootSessionId ?? task.rootSessionId,
              data: { status, code, signal, diff },
            },
            paths,
          );
        } else {
          await resolveKiloNotifications(
            taskId,
            ['started', 'progress', 'completed'],
            paths,
          );
        }
      } else {
        await notifyKiloState(
          {
            taskId,
            state: isTimeoutMessage(error) ? 'timed-out' : 'failed',
            message:
              error ?? `Kilo task ${taskId} ended with status ${status}.`,
            repoId: current?.repoId ?? task.repoId,
            repoFullName: current?.repoFullName ?? task.repoFullName,
            worktreeId: current?.worktreeId ?? task.worktreeId,
            sessionId: current?.rootSessionId ?? task.rootSessionId,
            data: { status, code, signal },
          },
          paths,
        );
      }
      await releaseTaskLock(task, status, paths);
      await reconcilePreparedDiffRevisionResult(
        {
          task: tryKiloTask(taskId, paths) ?? current ?? task,
          status,
          diff: observedDiff,
          error,
        },
        paths,
      );
    })().finally(cleanup);
  });
  return completed;
}

function handleKiloLine(
  taskId: string,
  stream: string,
  line: string,
  paths: RuntimePaths,
) {
  const parsed = parseJsonLine(line);
  if (!parsed.ok) {
    addKiloTaskEvent(
      taskId,
      {
        eventType: 'stdout',
        stream,
        summary: truncate(line, 1_000),
        data: { line },
      },
      paths,
    );
    return;
  }

  const sessionIds = extractSessionIds(parsed.value);
  const rootSessionId = topLevelSessionId(parsed.value);
  if (rootSessionId) updateKiloTaskSessions(taskId, rootSessionId, [], paths);
  updateKiloTaskSessions(
    taskId,
    rootSessionId ?? undefined,
    sessionIds.filter((id) => id !== rootSessionId),
    paths,
  );
  addKiloTaskEvent(
    taskId,
    {
      eventType: eventType(parsed.value),
      stream,
      sessionId: rootSessionId ?? null,
      childSessionId: sessionIds.find((id) => id !== rootSessionId) ?? null,
      summary: summarizeEvent(parsed.value),
      data: asJsonValue(parsed.value),
    },
    paths,
  );
  const task = tryKiloTask(taskId, paths);
  if (terminalTaskIds.has(taskId)) return;
  if (!task || !['running', 'needs-reconcile'].includes(task.status)) return;
  void notifyKiloState(
    {
      taskId,
      state: 'progress',
      message: summarizeEvent(parsed.value),
      repoId: task?.repoId,
      repoFullName: task?.repoFullName,
      worktreeId: task?.worktreeId,
      sessionId: rootSessionId ?? task?.rootSessionId,
      data: {
        eventType: eventType(parsed.value),
        childSessionId: sessionIds.find((id) => id !== rootSessionId) ?? null,
      },
    },
    paths,
  ).catch((error) => {
    console.error('[neondeck] failed to persist Kilo progress notification', {
      taskId,
      error: errorMessage(error),
    });
  });
}

async function recoverMissingSessionId(taskId: string, paths: RuntimePaths) {
  const task = tryKiloTask(taskId, paths);
  if (!task || task.rootSessionId) return false;
  const result = await searchKiloSessions(
    { query: task.title, limit: 5 },
    paths,
  );
  const sessions = 'sessions' in result ? result.sessions : [];
  let id = Array.isArray(sessions) ? sessions[0]?.id : undefined;
  if (!id) {
    const disk = await searchKiloSessionsWithDisk({
      query: task.title,
      limit: 5,
    }).catch(() => ({ ok: false as const, sessions: [] }));
    id = disk.sessions[0]?.id;
  }
  if (!id || typeof id !== 'string') return false;
  updateKiloTaskSessions(taskId, id, [], paths);
  addKiloTaskEvent(
    taskId,
    {
      eventType: 'session.recovered',
      stream: 'system',
      sessionId: id,
      summary: `Recovered root Kilo session id ${id} from session search.`,
      data: { sessionId: id },
    },
    paths,
  );
  return true;
}

export async function reconcilePersistedRunningTasks(
  paths: RuntimePaths,
  taskId?: string,
) {
  const tasks = listReconcileableKiloTasks(paths, taskId).filter(
    (task) => !runningProcesses.has(task.id),
  );

  for (const task of tasks) {
    const processInspection = await inspectPersistedKiloProcess(task);
    const processAlive = processInspection.matched;
    const recovered = await recoverMissingSessionId(task.id, paths);
    const diff = await taskDiffSummary(task);
    const status: KiloTaskStatus = processAlive
      ? 'needs-reconcile'
      : diff.ok && diff.fileCount > 0
        ? 'needs-review'
        : 'unknown';
    const message = processAlive
      ? 'Neondeck restarted while this Kilo task process may still be running. The process cannot be safely reattached; review the raw log/session before acting.'
      : status === 'needs-review'
        ? 'Neondeck restarted and the Kilo process is no longer attached. Session/diff state was recovered and needs review.'
        : 'Neondeck restarted and the Kilo process is no longer attached. No changed files were observed; task outcome is unknown.';
    updateKiloTaskStatus(task.id, status, message, !processAlive, paths);
    addKiloTaskEvent(
      task.id,
      {
        eventType: `task.reconciled_${status}`,
        stream: 'system',
        summary: message,
        data: {
          pid: task.pid,
          processStartedAt: task.processStartedAt,
          cwd: task.cwd,
          title: task.title,
          rootSessionId: tryKiloTask(task.id, paths)?.rootSessionId,
          childSessionIds: tryKiloTask(task.id, paths)?.childSessionIds ?? [],
          rawLogPath: task.rawLogPath,
          processAlive: processInspection.alive,
          processMatched: processInspection.matched,
          processMatchReason: processInspection.reason,
          processCommand: processInspection.command,
          observedProcessStartedAt: processInspection.startedAt,
          recoveredSession: recovered,
          diff,
        },
      },
      paths,
    );
    await notifyKiloState(
      {
        taskId: task.id,
        state: processAlive
          ? 'progress'
          : status === 'needs-review'
            ? 'needs-review'
            : 'failed',
        title: processAlive ? 'Kilo handoff needs reconciliation' : undefined,
        message,
        repoId: task.repoId,
        repoFullName: task.repoFullName,
        worktreeId: task.worktreeId,
        sessionId: tryKiloTask(task.id, paths)?.rootSessionId,
        data: {
          status,
          processAlive: processInspection.alive,
          processMatched: processInspection.matched,
          recoveredSession: recovered,
          diff,
        },
      },
      paths,
    );
    if (!processAlive) {
      await releaseTaskLock(task, status, paths);
      await reconcilePreparedDiffRevisionResult(
        {
          task: tryKiloTask(task.id, paths) ?? task,
          status,
          diff,
        },
        paths,
      );
    }
  }
}

export async function releaseTaskLock(
  task: KiloTaskRecord | undefined,
  status: KiloTaskStatus,
  paths: RuntimePaths,
) {
  if (!task?.lockId) return;
  await releaseKiloTaskLock(task.lockId, kiloLockOwner(task.id), status, paths);
}

export async function releaseKiloTaskLock(
  lockId: string,
  owner: string | null,
  status: KiloTaskStatus,
  paths: RuntimePaths,
) {
  await releaseWorktreeLock(
    {
      lockId,
      ...(owner ? { owner } : {}),
      finalStatus: worktreeStatusForKiloStatus(status),
    },
    paths,
  );
}

function worktreeStatusForKiloStatus(status: KiloTaskStatus) {
  if (
    status === 'succeeded' ||
    status === 'needs-review' ||
    status === 'needs-reconcile' ||
    status === 'ready-to-verify' ||
    status === 'ready-to-push'
  ) {
    return 'prepared-diff';
  }
  if (status === 'failed') return 'failed';
  return 'ready';
}

export function kiloLockOwner(taskId: string) {
  return `kilo:${taskId}`;
}

async function inspectPersistedKiloProcess(task: KiloTaskRecord) {
  if (!task.pid || !isProcessAlive(task.pid)) {
    return {
      alive: false,
      matched: false,
      reason: 'pid-not-running',
      command: null,
      startedAt: null,
    };
  }
  const observed = await readProcessSnapshot(task.pid);
  if (!observed.command) {
    return {
      alive: true,
      matched: false,
      reason: 'process-command-unavailable',
      command: null,
      startedAt: observed.startedAt,
    };
  }
  const command = observed.command.toLowerCase();
  const expectedCli = basename(task.cliPath).toLowerCase();
  const hasKiloCommand =
    command.includes(expectedCli) || command.includes('kilo');
  const hasWorkspace = command.includes(task.cwd.toLowerCase());
  const hasTitle = command.includes(task.title.toLowerCase());
  const hasTaskId = command.includes(task.id.toLowerCase());
  const hasKnownSession =
    Boolean(task.rootSessionId && command.includes(task.rootSessionId)) ||
    task.childSessionIds.some((id) => command.includes(id));
  const hasStartMatch = processStartMatches(
    task.processStartedAt,
    observed.startedAt,
  );
  const matched =
    hasKiloCommand &&
    hasStartMatch &&
    (hasWorkspace || hasTitle || hasTaskId || hasKnownSession);
  return {
    alive: true,
    matched,
    reason: matched
      ? 'command-line-matched-persisted-context'
      : 'command-line-did-not-match-persisted-context',
    command: observed.command,
    startedAt: observed.startedAt,
  };
}

function processStartMatches(expected: string | null, observed: string | null) {
  if (!expected || !observed) return true;
  const delta = Math.abs(Date.parse(expected) - Date.parse(observed));
  return Number.isFinite(delta) && delta < 5 * 60_000;
}

async function readProcessSnapshot(pid: number) {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    const line = stdout.trim();
    if (!line) return { command: null, startedAt: null };
    const parts = line.split(/\s+/);
    const startText = parts.slice(0, 5).join(' ');
    const startedAtMs = Date.parse(startText);
    return {
      command: parts.slice(5).join(' ') || line,
      startedAt: Number.isFinite(startedAtMs)
        ? new Date(startedAtMs).toISOString()
        : null,
    };
  } catch {
    return { command: null, startedAt: null };
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
