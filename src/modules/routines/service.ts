import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  dispatch,
  type DispatchReceipt,
  type FlueObservation,
  type JsonValue,
} from '@flue/runtime';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { renderReportHtml } from '../../lib/report-html';
import { openDb } from '../../lib/sqlite';
import {
  addNotification,
  type JobExecutionResult,
  type NotificationLevel,
} from '../app-state';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { writeReport } from '../reports';
import {
  createChatSession,
  createChatSessionCommandEvent,
  readChatSession,
  updateChatSessionCommandEvent,
} from '../sessions';
import { listRuntimeSkills, loadRuntimeSkill } from '../runtime';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';

const minIntervalSeconds = 15 * 60;
const maxPromptLength = 8_000;
const maxCommandEventInputLength = 2_000;
const maxNameLength = 96;
const maxRoutineRunsPerTick = 2;
const maxConsecutiveFailures = 3;
const staleRoutineRunMs = 6 * 60 * 60 * 1000;
const maxRoutineOutputLength = 20_000;
const maxRoutineSummaryLength = 240;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type RoutineScheduleKind = 'interval' | 'once' | 'cron';
export type RoutineDelivery = 'notification' | 'report' | 'session';
export type RoutineRunStatus = 'queued' | 'completed' | 'failed';

type RoutineSession = {
  id: string;
  title: string;
};

type RoutineDispatch = (input: {
  agent: 'display-assistant';
  id: string;
  input: string;
}) => Promise<DispatchReceipt>;

let routineDispatch: RoutineDispatch = (input) =>
  dispatch(input) as Promise<DispatchReceipt>;

export function setRoutineDispatchForTests(dispatchFn: RoutineDispatch) {
  const previous = routineDispatch;
  routineDispatch = dispatchFn;
  return () => {
    routineDispatch = previous;
  };
}

export type RoutineRecord = {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  schedule: string;
  skills: string[];
  scopeRepoId: string | null;
  scopeCwd: string | null;
  delivery: RoutineDelivery;
  sessionId: string | null;
  repeatLimit: number | null;
  runCount: number;
  consecutiveFailures: number;
  runningRunId: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type RoutineRunRecord = {
  id: string;
  routineId: string;
  status: RoutineRunStatus;
  outcome: 'recorded' | 'failed';
  message: string;
  reportId: string | null;
  sessionId: string | null;
  commandEventId: string | null;
  dispatchId: string | null;
  summary: JsonValue | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const routineCreateInputSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(maxNameLength)),
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(maxPromptLength)),
  scheduleKind: v.picklist(['interval', 'once', 'cron']),
  schedule: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  skills: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  scopeRepoId: v.optional(v.nullable(v.string())),
  scopeCwd: v.optional(v.nullable(v.string())),
  delivery: v.optional(v.picklist(['notification', 'report', 'session'])),
  sessionId: v.optional(v.nullable(v.string())),
  repeatLimit: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  ),
  createdBy: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(160))),
});

export const routineUpdateInputSchema = v.partial(
  v.omit(routineCreateInputSchema, ['createdBy']),
);

export async function listRoutines(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return {
      ok: true,
      action: 'routines_list',
      changed: false,
      message: 'Listed routines.',
      routines: database
        .prepare(
          `
          SELECT *
          FROM routines
          ORDER BY enabled DESC, next_run_at ASC, updated_at DESC;
        `,
        )
        .all()
        .map(readRoutineRow),
    };
  } finally {
    database.close();
  }
}

export async function readRoutine(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const routine = readRoutineById(paths, id);
  if (!routine) {
    return failedResult('routine_read', `Routine "${id}" was not found.`);
  }
  return {
    ok: true,
    action: 'routine_read',
    changed: false,
    message: `Read routine "${routine.name}".`,
    routine,
    runs: listRoutineRuns(paths, id, 20),
  };
}

export async function createRoutine(
  rawInput: v.InferInput<typeof routineCreateInputSchema>,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(routineCreateInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult('routine_create', v.summarize(parsed.issues));
  }
  const input = parsed.output;
  const schedule = materializeNextRunAt(
    input.scheduleKind,
    input.schedule,
    new Date(),
  );
  if (!schedule.ok) return failedResult('routine_create', schedule.message);
  const skills = await validateRoutineSkills(input.skills ?? [], paths);
  if (!skills.ok) return failedResult('routine_create', skills.message);
  const scope = await validateRoutineScope(
    input.scopeRepoId ?? null,
    input.scopeCwd ?? null,
    paths,
  );
  if (!scope.ok) return failedResult('routine_create', scope.message);

  const now = new Date().toISOString();
  const id = `routine:${randomUUID()}`;
  const routine: RoutineRecord = {
    id,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    scheduleKind: input.scheduleKind,
    schedule: input.schedule.trim(),
    skills: skills.ids,
    scopeRepoId: scope.repoId,
    scopeCwd: scope.cwd,
    delivery: input.delivery ?? 'notification',
    sessionId: input.sessionId ?? null,
    repeatLimit: input.repeatLimit ?? null,
    runCount: 0,
    consecutiveFailures: 0,
    runningRunId: null,
    enabled: true,
    createdBy: input.createdBy ?? 'user:api',
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: schedule.nextRunAt,
  };
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO routines (
          id,
          name,
          prompt,
          schedule_kind,
          schedule,
          skills_json,
          scope_repo_id,
          scope_cwd,
          delivery,
          session_id,
          repeat_limit,
          run_count,
          consecutive_failures,
          running_run_id,
          enabled,
          created_by,
          created_at,
          updated_at,
          last_run_at,
          next_run_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        routine.id,
        routine.name,
        routine.prompt,
        routine.scheduleKind,
        routine.schedule,
        JSON.stringify(routine.skills),
        routine.scopeRepoId,
        routine.scopeCwd,
        routine.delivery,
        routine.sessionId,
        routine.repeatLimit,
        routine.runCount,
        routine.consecutiveFailures,
        routine.runningRunId,
        routine.enabled ? 1 : 0,
        routine.createdBy,
        routine.createdAt,
        routine.updatedAt,
        routine.lastRunAt,
        routine.nextRunAt,
      );
  } finally {
    database.close();
  }
  recordRoutineEvent(paths, {
    routineId: routine.id,
    eventType: 'routine_created',
    message: `Created routine "${routine.name}".`,
    actor: routine.createdBy,
    after: routine,
  });
  await addNotification(
    {
      level: 'info',
      title: 'Routine created',
      message: `${routine.name} is scheduled for ${routine.nextRunAt ?? 'manual runs only'}.`,
      source: 'routine',
      sourceId: routine.id,
      data: { routineId: routine.id, nextRunAt: routine.nextRunAt },
    },
    paths,
  );
  return {
    ok: true,
    action: 'routine_create',
    changed: true,
    message: `Created routine "${routine.name}".`,
    routine,
  };
}

export async function updateRoutine(
  id: string,
  rawInput: v.InferInput<typeof routineUpdateInputSchema>,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const existing = readRoutineById(paths, id);
  if (!existing) {
    return failedResult('routine_update', `Routine "${id}" was not found.`);
  }
  const parsed = v.safeParse(routineUpdateInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult('routine_update', v.summarize(parsed.issues));
  }
  const input = parsed.output;
  const nextScheduleKind = input.scheduleKind ?? existing.scheduleKind;
  const nextSchedule = (input.schedule ?? existing.schedule).trim();
  const scheduleChanged =
    nextScheduleKind !== existing.scheduleKind ||
    nextSchedule !== existing.schedule;
  const nextRun = scheduleChanged
    ? materializeNextRunAt(nextScheduleKind, nextSchedule, new Date())
    : { ok: true as const, nextRunAt: existing.nextRunAt };
  if (!nextRun.ok) return failedResult('routine_update', nextRun.message);
  const skills = await validateRoutineSkills(
    input.skills ?? existing.skills,
    paths,
  );
  if (!skills.ok) return failedResult('routine_update', skills.message);
  const scope = await validateRoutineScope(
    input.scopeRepoId === undefined ? existing.scopeRepoId : input.scopeRepoId,
    input.scopeCwd === undefined ? existing.scopeCwd : input.scopeCwd,
    paths,
  );
  if (!scope.ok) return failedResult('routine_update', scope.message);

  const now = new Date().toISOString();
  const before = existing;
  const database = openDb(paths.neondeckDatabase);
  try {
    const routineUpdate = database
      .prepare(
        `
        UPDATE routines
        SET
          name = ?,
          prompt = ?,
          schedule_kind = ?,
          schedule = ?,
          skills_json = ?,
          scope_repo_id = ?,
          scope_cwd = ?,
          delivery = ?,
          session_id = ?,
          repeat_limit = ?,
          updated_at = ?,
          next_run_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        input.name?.trim() ?? existing.name,
        input.prompt?.trim() ?? existing.prompt,
        nextScheduleKind,
        nextSchedule,
        JSON.stringify(skills.ids),
        scope.repoId,
        scope.cwd,
        input.delivery ?? existing.delivery,
        input.sessionId === undefined ? existing.sessionId : input.sessionId,
        input.repeatLimit === undefined
          ? existing.repeatLimit
          : input.repeatLimit,
        now,
        nextRun.nextRunAt,
        id,
      );
  } finally {
    database.close();
  }
  const updated = readRoutineById(paths, id);
  recordRoutineEvent(paths, {
    routineId: id,
    eventType: 'routine_updated',
    message: `Updated routine "${id}".`,
    actor: 'user:api',
    before,
    after: updated,
  });
  return {
    ok: true,
    action: 'routine_update',
    changed: true,
    message: `Updated routine "${id}".`,
    routine: updated,
  };
}

export async function setRoutineEnabled(
  id: string,
  enabled: boolean,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const routine = readRoutineById(paths, id);
  if (!routine) {
    return failedResult(
      'routine_enabled_update',
      `Routine "${id}" was not found.`,
    );
  }
  const now = new Date().toISOString();
  const nextRunAt = enabled
    ? resumeNextRunAt(routine, now)
    : { ok: true as const, nextRunAt: routine.nextRunAt };
  if (!nextRunAt.ok) {
    return failedResult('routine_enabled_update', nextRunAt.message);
  }
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE routines
        SET enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(enabled ? 1 : 0, nextRunAt.nextRunAt, now, id);
  } finally {
    database.close();
  }
  const updated = readRoutineById(paths, id);
  recordRoutineEvent(paths, {
    routineId: id,
    eventType: enabled ? 'routine_resumed' : 'routine_paused',
    message: `${enabled ? 'Enabled' : 'Paused'} routine "${routine.name}".`,
    actor: 'user:api',
    before: routine,
    after: updated,
  });
  return {
    ok: true,
    action: 'routine_enabled_update',
    changed: routine.enabled !== enabled,
    message: `${enabled ? 'Enabled' : 'Paused'} routine "${routine.name}".`,
    routine: updated,
  };
}

export async function deleteRoutine(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  await recoverStaleRoutineClaims(paths, new Date());
  const routine = readRoutineById(paths, id);
  if (!routine) {
    return failedResult('routine_delete', `Routine "${id}" was not found.`);
  }
  if (routine.runningRunId) {
    return failedResult(
      'routine_delete',
      `Routine "${routine.name}" has a run in progress.`,
    );
  }
  const runs = listRoutineRuns(paths, id, 1_000);
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    database.prepare('DELETE FROM routine_runs WHERE routine_id = ?;').run(id);
    database.prepare('DELETE FROM routines WHERE id = ?;').run(id);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
  recordRoutineEvent(paths, {
    routineId: id,
    eventType: 'routine_deleted',
    message: `Deleted routine "${routine.name}".`,
    actor: 'user:api',
    before: { routine, runs },
    after: null,
  });
  return {
    ok: true,
    action: 'routine_delete',
    changed: true,
    message: `Deleted routine "${routine.name}".`,
  };
}

export async function runRoutineNow(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  await recoverStaleRoutineClaims(paths, new Date());
  const routine = readRoutineById(paths, id);
  if (!routine) {
    return failedResult('routine_run_now', `Routine "${id}" was not found.`);
  }
  const result = await admitRoutineRun(routine, paths, new Date(), 'manual');
  for (const notification of result.notifications ?? []) {
    await addNotification(notification, paths);
  }
  return result;
}

export async function recordRoutineFlueObservation(
  event: FlueObservation,
  paths = runtimePaths(),
) {
  if (!event.dispatchId) {
    return {
      ok: true,
      action: 'routine_flue_observation',
      changed: false,
      message: 'Flue observation did not reference a dispatch id.',
    };
  }
  if (event.type === 'agent_end') {
    return settleRoutineDispatch(
      paths,
      event.dispatchId,
      'completed',
      'Routine agent turn completed.',
      null,
      event,
    );
  }
  if (
    event.type === 'operation' &&
    event.operationKind === 'prompt' &&
    event.isError
  ) {
    return settleRoutineDispatch(
      paths,
      event.dispatchId,
      'failed',
      'Routine agent turn failed.',
      event.error ? errorMessage(event.error) : 'Prompt operation failed.',
      event,
    );
  }
  if (event.type === 'submission_settled' && event.outcome !== 'completed') {
    return settleRoutineDispatch(
      paths,
      event.dispatchId,
      event.outcome === 'aborted' ? 'failed' : event.outcome,
      `Routine dispatch ${event.outcome}.`,
      event.error?.message ?? event.outcome,
      event,
    );
  }
  return {
    ok: true,
    action: 'routine_flue_observation',
    changed: false,
    message: 'Flue observation did not settle a routine dispatch.',
  };
}

export async function runDueRoutines(
  paths = runtimePaths(),
  now = new Date(),
  limit = maxRoutineRunsPerTick,
): Promise<JobExecutionResult> {
  await ensureRuntimeHome(paths);
  await recoverStaleRoutineClaims(paths, now);
  const capacity = routineAdmissionCapacity(paths, limit);
  if (capacity.available <= 0) {
    return {
      outcome: 'silent',
      message: 'Routine concurrency cap reached.',
      result: {
        runCount: 0,
        activeCount: capacity.active,
        limit: capacity.limit,
      },
    };
  }
  const due = dueRoutines(paths, now, capacity.available);
  const runs: RoutineRunRecord[] = [];
  const failures: Array<{
    routineId: string;
    message: string;
    run: RoutineRunRecord | null;
  }> = [];
  const notifications: NonNullable<JobExecutionResult['notifications']> = [];
  for (const routine of due) {
    const result = await admitRoutineRun(routine, paths, now, 'scheduled');
    if (result.ok && result.run) {
      runs.push(result.run);
    } else {
      failures.push({
        routineId: routine.id,
        message: result.message,
        run: result.run ?? null,
      });
    }
    for (const notification of result.notifications ?? []) {
      notifications.push(notification);
    }
  }
  if (due.length === 0) {
    return {
      outcome: 'silent',
      message: 'No routines were due.',
      result: { runCount: 0 },
    };
  }
  if (failures.length > 0) {
    const admitted = runs.length;
    const failed = failures.length;
    return {
      outcome: 'failed',
      message:
        admitted > 0
          ? `Admitted ${admitted} routine run${admitted === 1 ? '' : 's'}; ${failed} failed.`
          : `Failed to admit ${failed} routine run${failed === 1 ? '' : 's'}.`,
      result: {
        attemptedCount: due.length,
        runCount: admitted,
        failureCount: failed,
        runs,
        failures,
      },
      notifications,
    };
  }
  return {
    outcome: 'recorded',
    message: `Admitted ${runs.length} routine run${runs.length === 1 ? '' : 's'}.`,
    result: { attemptedCount: due.length, runCount: runs.length, runs },
    notifications,
  };
}

export function materializeNextRunAt(
  kind: RoutineScheduleKind,
  schedule: string,
  now = new Date(),
): { ok: true; nextRunAt: string | null } | { ok: false; message: string } {
  const value = schedule.trim();
  if (kind === 'interval') {
    const seconds = Number(value);
    if (
      !Number.isInteger(seconds) ||
      seconds < minIntervalSeconds ||
      seconds > 366 * 24 * 60 * 60
    ) {
      return {
        ok: false,
        message: `Interval routines require ${minIntervalSeconds} or more seconds.`,
      };
    }
    return {
      ok: true,
      nextRunAt: new Date(now.getTime() + seconds * 1000).toISOString(),
    };
  }
  if (kind === 'once') {
    const nextRunAt = normalizeIsoTimestamp(value);
    if (!nextRunAt) {
      return {
        ok: false,
        message: 'One-shot routines require an ISO timestamp.',
      };
    }
    return { ok: true, nextRunAt };
  }
  const cron = nextCronRun(value, now);
  if (!cron) {
    return {
      ok: false,
      message:
        'Cron routines support five-field numeric/wildcard expressions in this slice.',
    };
  }
  return { ok: true, nextRunAt: cron.toISOString() };
}

async function admitRoutineRun(
  routine: RoutineRecord,
  paths: RuntimePaths,
  now: Date,
  trigger: 'scheduled' | 'manual',
) {
  const runId = `routine-run:${randomUUID()}`;
  const startedAt = now.toISOString();
  if (trigger === 'manual') {
    const capacity = routineAdmissionCapacity(paths, maxRoutineRunsPerTick);
    if (capacity.available <= 0 && !routine.runningRunId) {
      return {
        ok: false,
        action: 'routine_run',
        changed: false,
        message: `Routine concurrency cap reached (${capacity.active}/${capacity.limit}).`,
        run: null,
      };
    }
  }
  const claim = claimRoutineRun(paths, routine, runId, startedAt, trigger);
  if (!claim.ok) {
    return {
      ok: false,
      action: 'routine_run',
      changed: false,
      message:
        claim.reason === 'capacity'
          ? `Routine concurrency cap reached (${claim.activeCount}/${maxRoutineRunsPerTick}).`
          : `Routine "${routine.name}" already has an active run.`,
      run: null,
    };
  }

  let commandEventContext: {
    sessionId: string;
    eventId: string;
    commandInput: string;
  } | null = null;
  try {
    const composed = await composeRoutinePrompt(routine, paths, trigger);
    const commandInput = routineCommandEventInput(composed.prompt);
    const session = await ensureRoutineSession(routine, paths);
    if (!session.ok || !('session' in session) || !session.session) {
      throw new Error(session.message);
    }
    const command = await createChatSessionCommandEvent(
      {
        sessionId: session.session.id,
        input: commandInput,
        reason: `routine:${routine.id}:${trigger}`,
      },
      paths,
    );
    if (!command.ok || !('event' in command) || !command.event) {
      throw new Error(command.message);
    }
    const commandEvent = command.event;
    commandEventContext = {
      sessionId: session.session.id,
      eventId: commandEvent.id,
      commandInput,
    };
    const dispatchReceipt = await routineDispatch({
      agent: 'display-assistant',
      id: session.session.id,
      input: composed.prompt,
    });
    const dispatchId = dispatchReceiptId(dispatchReceipt);
    let run: RoutineRunRecord | null = null;
    try {
      run = recordAdmittedRoutineRun(paths, routine, runId, {
        status: 'queued',
        outcome: 'recorded',
        message: `Dispatched routine "${routine.name}" to session ${session.session.id}.`,
        reportId: null,
        sessionId: session.session.id,
        commandEventId: commandEvent.id,
        dispatchId,
        summary: {
          trigger,
          reportId: null,
          reportError: null,
          sessionId: session.session.id,
          commandEventId: commandEvent.id,
          dispatchReceipt,
          skills: composed.skillIds,
        },
        admittedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = `Routine "${routine.name}" was dispatched to session ${session.session.id}, but local admission bookkeeping failed: ${errorMessage(error)}.`;
      recordRoutineEvent(paths, {
        routineId: routine.id,
        runId,
        eventType: 'routine_run_bookkeeping_failed',
        message,
        actor: trigger === 'scheduled' ? 'scheduler' : 'user:api',
        after: readRoutineRunOrNull(paths, runId),
      });
      return {
        ok: false,
        action: 'routine_run',
        changed: true,
        message,
        run: readRoutineRunOrNull(paths, runId),
        report: null,
        notifications: [
          {
            level: 'attention' as NotificationLevel,
            title: 'Routine bookkeeping failed',
            message,
            source: 'routine',
            sourceId: runId,
            data: {
              routineId: routine.id,
              runId,
              reportId: null,
              sessionId: session.session.id,
              commandEventId: commandEvent.id,
              dispatchReceipt,
              recovery:
                'Routine claim was left active to prevent duplicate dispatch after Flue accepted the input.',
            },
          },
        ],
      };
    }
    recordRoutineEvent(paths, {
      routineId: routine.id,
      runId,
      eventType: 'routine_run_admitted',
      message: run.message,
      actor: trigger === 'scheduled' ? 'scheduler' : 'user:api',
      after: run,
    });
    return {
      ok: true,
      action: 'routine_run',
      changed: true,
      message: run.message,
      run,
      report: null,
      notifications: [],
    };
  } catch (error) {
    const message = `Routine "${routine.name}" failed to queue: ${errorMessage(error)}.`;
    if (commandEventContext) {
      await updateChatSessionCommandEvent(
        {
          sessionId: commandEventContext.sessionId,
          eventId: commandEventContext.eventId,
          status: 'failed',
          completedAt: new Date().toISOString(),
          reason: `routine:${routine.id}:${trigger}:failed`,
          result: {
            ok: false,
            command: 'routine',
            input: commandEventContext.commandInput,
            message,
          },
        },
        paths,
      ).catch(() => undefined);
    }
    const run = completeFailedRoutineRun(paths, routine, runId, {
      status: 'failed',
      outcome: 'failed',
      message,
      error: errorMessage(error),
      completedAt: new Date().toISOString(),
    });
    const failureReport = await writeFailedRoutineAdmissionReport(
      paths,
      routine,
      run,
      message,
      errorMessage(error),
    );
    const reportedRun =
      failureReport.report && !failureReport.error
        ? updateRoutineRunSettlementReport(paths, run.id, {
            reportId: failureReport.report.id,
            summary: {
              status: 'failed',
              message,
              error: errorMessage(error),
              reportId: failureReport.report.id,
            },
            updatedAt: new Date().toISOString(),
          })
        : run;
    recordRoutineEvent(paths, {
      routineId: routine.id,
      runId,
      eventType: 'routine_run_failed',
      message,
      actor: trigger === 'scheduled' ? 'scheduler' : 'user:api',
      after: reportedRun,
    });
    const notification = {
      level: 'attention' as NotificationLevel,
      title: 'Routine failed',
      message: failureReport.error
        ? `${message} Final report writing also failed: ${failureReport.error}.`
        : message,
      source: 'routine',
      sourceId: runId,
      data: {
        routineId: routine.id,
        runId,
        reportId: failureReport.report?.id ?? null,
        reportError: failureReport.error,
      },
    };
    return {
      ok: false,
      action: 'routine_run',
      changed: true,
      message,
      run: reportedRun,
      notifications: [notification],
    };
  }
}

async function composeRoutinePrompt(
  routine: RoutineRecord,
  paths: RuntimePaths,
  trigger: 'scheduled' | 'manual',
) {
  const loadedSkills = [];
  for (const id of routine.skills) {
    const loaded = await loadRuntimeSkill({ id }, paths);
    if (!loaded.ok) throw new Error(loaded.error);
    loadedSkills.push({
      id,
      title: loaded.skill.id,
      body: loaded.skill.content,
    });
  }
  const scopeLines = [];
  if (routine.scopeRepoId) {
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find((item) => item.id === routine.scopeRepoId);
    if (!repo) {
      throw new Error(`Repository "${routine.scopeRepoId}" is not configured.`);
    }
    scopeLines.push(`Repo: ${repoFullName(repo)}`);
    scopeLines.push(`Repo path: ${repo.path}`);
  }
  if (routine.scopeCwd)
    scopeLines.push(`Working directory: ${routine.scopeCwd}`);
  const skillText = loadedSkills
    .map((skill) => `## Skill: ${skill.title} (${skill.id})\n${skill.body}`)
    .join('\n\n');
  const prompt = [
    'You are running a Neondeck routine unattended.',
    `Routine id: ${routine.id}`,
    `Routine name: ${routine.name}`,
    `Trigger: ${trigger}`,
    'Do not wait for user input. If an action requires approval, request/queue it, summarize the pending approval, and continue with the rest of the task.',
    scopeLines.length ? `Scope:\n${scopeLines.join('\n')}` : null,
    skillText ? `Loaded runtime skills:\n\n${skillText}` : null,
    `Task:\n${routine.prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { prompt, skillIds: loadedSkills.map((skill) => skill.id) };
}

async function writeRoutineCompletionReport(
  input: {
    routine: RoutineRecord;
    run: RoutineRunRecord;
    dispatchId: string;
    status: 'completed' | 'failed';
    completedAt: string;
    settlement: RoutineSettlementDetails;
  },
  paths: RuntimePaths,
) {
  const failed = input.status === 'failed';
  return writeReport(
    {
      kind: 'routine',
      title: `Routine ${failed ? 'failed' : 'completed'}: ${input.routine.name}`,
      sourceRef: input.routine.id,
      repoId: input.routine.scopeRepoId,
      createdBy: `routine:${input.routine.id}`,
      createdAt: input.completedAt,
      summary: {
        routineId: input.routine.id,
        runId: input.run.id,
        status: input.status,
        dispatchId: input.dispatchId,
        silent: input.settlement.silent,
        summary: input.settlement.summaryText,
      },
      html: renderReportHtml({
        title: `Routine ${failed ? 'failed' : 'completed'}: ${input.routine.name}`,
        eyebrow: 'ROUTINE',
        summary: input.settlement.summaryText,
        generatedAt: input.completedAt,
        sections: [
          {
            title: 'Run',
            items: [
              { label: 'routine', value: input.routine.id },
              { label: 'run', value: input.run.id },
              { label: 'status', value: input.status },
              { label: 'dispatch', value: input.dispatchId },
              { label: 'delivery', value: input.routine.delivery },
            ],
          },
          {
            title: failed ? 'Failure' : 'Output',
            body:
              input.settlement.outputText ||
              input.settlement.error ||
              input.settlement.message,
          },
        ],
      }),
    },
    paths,
  );
}

async function writeFailedRoutineAdmissionReport(
  paths: RuntimePaths,
  routine: RoutineRecord,
  run: RoutineRunRecord,
  message: string,
  error: string,
) {
  if (routine.delivery !== 'report') {
    return { report: null, error: null };
  }
  const completedAt = run.completedAt ?? new Date().toISOString();
  const settlement: RoutineSettlementDetails = {
    message,
    summaryText: error,
    outputText: null,
    error,
    silent: false,
    summary: {
      status: 'failed',
      message,
      summary: error,
      output: null,
      error,
      silent: false,
      observationType: 'admission_failure',
    },
  };
  try {
    return {
      report: await writeRoutineCompletionReport(
        {
          routine,
          run,
          dispatchId: run.dispatchId ?? 'not-dispatched',
          status: 'failed',
          completedAt,
          settlement,
        },
        paths,
      ),
      error: null,
    };
  } catch (error_) {
    return { report: null, error: errorMessage(error_) };
  }
}

async function ensureRoutineSession(
  routine: RoutineRecord,
  paths: RuntimePaths,
): Promise<
  | { ok: true; session: RoutineSession; message: string }
  | { ok: false; message: string }
> {
  if (routine.sessionId) {
    const existing = await readChatSession(
      {
        id: routine.sessionId,
        reason: `routine:${routine.id}`,
      },
      paths,
    );
    return existing.ok && 'session' in existing && existing.session
      ? {
          ok: true,
          session: { id: existing.session.id, title: existing.session.title },
          message: existing.message,
        }
      : { ok: false, message: existing.message };
  }
  const created = await createChatSession(
    {
      title: `Routine: ${routine.name}`,
      kind: 'general',
      activate: false,
      reason: `routine:${routine.id}`,
      uiMetadata: { routineId: routine.id },
      summary: `Routine session for ${routine.name}.`,
      summarySource: 'metadata',
    },
    paths,
  );
  if (!created.ok || !('session' in created) || !created.session) {
    return { ok: false, message: created.message };
  }
  recordRoutineSession(paths, routine.id, created.session.id);
  return {
    ok: true,
    session: { id: created.session.id, title: created.session.title },
    message: created.message,
  };
}

function recordRoutineSession(
  paths: RuntimePaths,
  routineId: string,
  sessionId: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const routineUpdate = database
      .prepare(
        `
        UPDATE routines
        SET session_id = ?, updated_at = ?
        WHERE id = ? AND session_id IS NULL;
      `,
      )
      .run(sessionId, new Date().toISOString(), routineId);
  } finally {
    database.close();
  }
}

function claimRoutineRun(
  paths: RuntimePaths,
  routine: RoutineRecord,
  runId: string,
  now: string,
  trigger: 'scheduled' | 'manual',
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    const activeRow = database
      .prepare(
        `
        SELECT COUNT(*) AS active
        FROM routines
        WHERE running_run_id IS NOT NULL;
      `,
      )
      .get() as { active?: number } | undefined;
    const activeCount = Number(activeRow?.active ?? 0);
    if (activeCount >= maxRoutineRunsPerTick) {
      database.exec('ROLLBACK;');
      return { ok: false as const, reason: 'capacity' as const, activeCount };
    }
    const update =
      trigger === 'scheduled'
        ? database
            .prepare(
              `
              UPDATE routines
              SET running_run_id = ?, last_run_at = ?, updated_at = ?
              WHERE id = ?
                AND running_run_id IS NULL
                AND enabled = 1
                AND next_run_at IS NOT NULL
                AND next_run_at <= ?
                AND (
                  SELECT COUNT(*)
                  FROM routines
                  WHERE running_run_id IS NOT NULL
                ) < ?;
            `,
            )
            .run(runId, now, now, routine.id, now, maxRoutineRunsPerTick)
        : database
            .prepare(
              `
              UPDATE routines
              SET running_run_id = ?, last_run_at = ?, updated_at = ?
              WHERE id = ?
                AND running_run_id IS NULL
                AND (
                  SELECT COUNT(*)
                  FROM routines
                  WHERE running_run_id IS NOT NULL
                ) < ?;
            `,
            )
            .run(runId, now, now, routine.id, maxRoutineRunsPerTick);
    if (update.changes !== 1) {
      database.exec('ROLLBACK;');
      return { ok: false as const, reason: 'active' as const, activeCount };
    }
    database
      .prepare(
        `
        INSERT INTO routine_runs (
          id,
          routine_id,
          status,
          outcome,
          message,
          started_at,
          created_at,
          updated_at,
          summary_json
        )
        VALUES (?, ?, 'queued', 'recorded', ?, ?, ?, ?, ?);
      `,
      )
      .run(
        runId,
        routine.id,
        `Routine ${trigger} run admission started.`,
        now,
        now,
        now,
        JSON.stringify(asJsonValue({ trigger })),
      );
    database.exec('COMMIT;');
    return { ok: true as const };
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function recordAdmittedRoutineRun(
  paths: RuntimePaths,
  routine: RoutineRecord,
  runId: string,
  input: {
    status: 'queued';
    outcome: 'recorded' | 'failed';
    message: string;
    reportId?: string | null;
    sessionId?: string | null;
    commandEventId?: string | null;
    dispatchId?: string | null;
    summary?: unknown;
    error?: string | null;
    admittedAt: string;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    const currentRoutineRow = database
      .prepare('SELECT * FROM routines WHERE id = ? LIMIT 1;')
      .get(routine.id);
    const currentRoutine = currentRoutineRow
      ? readRoutineRow(currentRoutineRow)
      : routine;
    const admissionState = routineAdmissionState(
      routine,
      currentRoutine,
      input.admittedAt,
    );
    database
      .prepare(
        `
        UPDATE routine_runs
        SET
          status = ?,
          outcome = ?,
          message = ?,
          report_id = ?,
          session_id = ?,
          command_event_id = ?,
          dispatch_id = ?,
          summary_json = ?,
          error = ?,
          completed_at = NULL,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        input.status,
        input.outcome,
        input.message,
        input.reportId ?? null,
        input.sessionId ?? null,
        input.commandEventId ?? null,
        input.dispatchId ?? null,
        input.summary === undefined
          ? null
          : JSON.stringify(asJsonValue(input.summary)),
        input.error ?? null,
        input.admittedAt,
        runId,
      );
    const routineUpdate = database
      .prepare(
        `
        UPDATE routines
        SET
          run_count = run_count + 1,
          enabled = ?,
          next_run_at = ?,
          updated_at = ?
        WHERE id = ? AND running_run_id = ?;
        `,
      )
      .run(
        admissionState.enabled,
        admissionState.nextRunAt,
        input.admittedAt,
        routine.id,
        runId,
      );
    if (routineUpdate.changes !== 1) {
      throw new Error(`Routine "${routine.id}" no longer owns run "${runId}".`);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
  return readRoutineRun(paths, runId);
}

function completeFailedRoutineRun(
  paths: RuntimePaths,
  routine: RoutineRecord,
  runId: string,
  input: {
    status: 'failed';
    outcome: 'failed';
    message: string;
    reportId?: string | null;
    sessionId?: string | null;
    commandEventId?: string | null;
    dispatchId?: string | null;
    summary?: unknown;
    error?: string | null;
    completedAt: string;
  },
) {
  const nextRun = nextRunAfterCompletion(
    routine,
    input.outcome,
    input.completedAt,
  );
  const failureCount = routine.consecutiveFailures + 1;
  const autoPause = failureCount >= maxConsecutiveFailures;
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    database
      .prepare(
        `
        UPDATE routine_runs
        SET
          status = ?,
          outcome = ?,
          message = ?,
          report_id = ?,
          session_id = ?,
          command_event_id = ?,
          dispatch_id = ?,
          summary_json = ?,
          error = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        input.status,
        input.outcome,
        input.message,
        input.reportId ?? null,
        input.sessionId ?? null,
        input.commandEventId ?? null,
        input.dispatchId ?? null,
        input.summary === undefined
          ? null
          : JSON.stringify(asJsonValue(input.summary)),
        input.error ?? null,
        input.completedAt,
        input.completedAt,
        runId,
      );
    const routineUpdate = database
      .prepare(
        `
        UPDATE routines
        SET
          running_run_id = NULL,
          run_count = run_count + 1,
          consecutive_failures = ?,
          enabled = ?,
          next_run_at = ?,
          updated_at = ?
        WHERE id = ? AND running_run_id = ?;
      `,
      )
      .run(
        failureCount,
        autoPause || nextRun.disable ? 0 : routine.enabled ? 1 : 0,
        nextRun.nextRunAt,
        input.completedAt,
        routine.id,
        runId,
      );
    if (routineUpdate.changes !== 1) {
      throw new Error(`Routine "${routine.id}" no longer owns run "${runId}".`);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
  return readRoutineRun(paths, runId);
}

async function settleRoutineDispatch(
  paths: RuntimePaths,
  dispatchId: string,
  status: 'completed' | 'failed',
  message: string,
  error: string | null,
  event: FlueObservation,
) {
  const completedAt = event.timestamp ?? new Date().toISOString();
  const settlement = routineSettlementDetails(status, message, error, event);
  const database = openDb(paths.neondeckDatabase);
  let run: RoutineRunRecord | null = null;
  let routine: RoutineRecord | null = null;
  try {
    database.exec('BEGIN;');
    const runRow = database
      .prepare(
        `
        SELECT *
        FROM routine_runs
        WHERE dispatch_id = ?
        LIMIT 1;
      `,
      )
      .get(dispatchId);
    if (!runRow) {
      database.exec('ROLLBACK;');
      return {
        ok: true,
        action: 'routine_flue_observation',
        changed: false,
        message: `No routine run matched dispatch ${dispatchId}.`,
      };
    }
    run = readRoutineRunRow(runRow);
    if (run.status !== 'queued') {
      database.exec('ROLLBACK;');
      return {
        ok: true,
        action: 'routine_flue_observation',
        changed: false,
        message: `Routine run ${run.id} was already ${run.status}.`,
        run,
      };
    }
    const routineRow = database
      .prepare('SELECT * FROM routines WHERE id = ? LIMIT 1;')
      .get(run.routineId);
    routine = routineRow ? readRoutineRow(routineRow) : null;
    const nextFailureCount =
      status === 'failed' ? (routine?.consecutiveFailures ?? 0) + 1 : 0;
    const autoPause = nextFailureCount >= maxConsecutiveFailures;
    const repeatLimitReached =
      routine !== null &&
      routine.repeatLimit !== null &&
      routine.runCount >= routine.repeatLimit;
    const disable = autoPause || repeatLimitReached;
    database
      .prepare(
        `
        UPDATE routine_runs
        SET
          status = ?,
          outcome = ?,
          message = ?,
          summary_json = ?,
          error = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'queued';
      `,
      )
      .run(
        status,
        status === 'failed' ? 'failed' : 'recorded',
        settlement.message,
        JSON.stringify(asJsonValue(settlement.summary)),
        error,
        completedAt,
        completedAt,
        run.id,
      );
    if (routine) {
      database
        .prepare(
          `
          UPDATE routines
          SET
            running_run_id = NULL,
            consecutive_failures = ?,
            enabled = ?,
            next_run_at = ?,
            updated_at = ?
          WHERE id = ? AND running_run_id = ?;
        `,
        )
        .run(
          nextFailureCount,
          disable ? 0 : routine.enabled ? 1 : 0,
          disable ? null : routine.nextRunAt,
          completedAt,
          routine.id,
          run.id,
        );
    }
    database.exec('COMMIT;');
  } catch (settleError) {
    database.exec('ROLLBACK;');
    throw settleError;
  } finally {
    database.close();
  }
  let settledRun = readRoutineRunOrNull(paths, run.id);
  let report: Awaited<ReturnType<typeof writeReport>> | null = null;
  let reportError: string | null = null;
  if (routine && settledRun && routine.delivery === 'report') {
    try {
      report = await writeRoutineCompletionReport(
        {
          routine,
          run: settledRun,
          dispatchId,
          status,
          completedAt,
          settlement,
        },
        paths,
      );
      settledRun = updateRoutineRunSettlementReport(paths, run.id, {
        reportId: report.id,
        summary: {
          ...settlement.summary,
          reportId: report.id,
          admissionReportId: settledRun.reportId,
        },
        updatedAt: completedAt,
      });
    } catch (error_) {
      reportError = errorMessage(error_);
    }
  }
  if (run.sessionId && run.commandEventId) {
    await updateChatSessionCommandEvent(
      {
        sessionId: run.sessionId,
        eventId: run.commandEventId,
        status: status === 'failed' ? 'failed' : 'completed',
        completedAt,
        reason: `routine:${run.routineId}:dispatch:${status}`,
        result: {
          ok: status !== 'failed',
          command: 'routine',
          dispatchId,
          routineId: run.routineId,
          runId: run.id,
          message: settlement.message,
          error,
          reportId: report?.id ?? settledRun?.reportId ?? null,
        },
      },
      paths,
    );
  }
  const notification = routine
    ? routineSettlementNotification({
        routine,
        runId: run.id,
        status,
        settlement,
        report,
        reportError,
      })
    : null;
  if (notification) {
    await addNotification(notification, paths);
  }
  recordRoutineEvent(paths, {
    routineId: run.routineId,
    runId: run.id,
    eventType:
      status === 'failed' ? 'routine_run_failed' : 'routine_run_completed',
    message: settlement.message,
    actor: 'flue:observation',
    before: run,
    after: settledRun,
  });
  return {
    ok: true,
    action: 'routine_flue_observation',
    changed: true,
    message: settlement.message,
    run: settledRun,
    report,
    notifications: notification ? [notification] : [],
  };
}

function updateRoutineRunSettlementReport(
  paths: RuntimePaths,
  runId: string,
  input: {
    reportId: string | null;
    summary: unknown;
    updatedAt: string;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE routine_runs
        SET
          report_id = ?,
          summary_json = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        input.reportId,
        JSON.stringify(asJsonValue(input.summary)),
        input.updatedAt,
        runId,
      );
  } finally {
    database.close();
  }
  return readRoutineRun(paths, runId);
}

type RoutineSettlementDetails = {
  message: string;
  summaryText: string;
  outputText: string | null;
  error: string | null;
  silent: boolean;
  summary: Record<string, unknown>;
};

function routineSettlementDetails(
  status: 'completed' | 'failed',
  fallbackMessage: string,
  error: string | null,
  event: FlueObservation,
): RoutineSettlementDetails {
  const outputText =
    event.type === 'agent_end'
      ? truncateText(
          latestAssistantText(event.messages),
          maxRoutineOutputLength,
        )
      : null;
  const summaryText =
    truncateText(
      firstUsefulLine(outputText) ?? error ?? fallbackMessage,
      maxRoutineSummaryLength,
    ) ?? fallbackMessage;
  const silent = status === 'completed' && isSilentRoutineOutput(summaryText);
  const message =
    status === 'failed'
      ? `Routine failed: ${summaryText}`
      : `Routine completed: ${summaryText}`;
  return {
    message,
    summaryText,
    outputText,
    error,
    silent,
    summary: {
      status,
      message,
      summary: summaryText,
      output: outputText,
      error,
      silent,
      observationType: event.type,
    },
  };
}

function latestAssistantText(messages: unknown) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (!message || message.role !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') return content.trim() || null;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((block) => {
        const record = block as Record<string, unknown> | undefined;
        return record?.type === 'text' && typeof record.text === 'string'
          ? record.text
          : null;
      })
      .filter((part): part is string => Boolean(part && part.trim()))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}

function firstUsefulLine(text: string | null) {
  return (
    text
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function truncateText(text: string | null, limit: number) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function isSilentRoutineOutput(summary: string) {
  return /^(nothing to do|no action needed|no changes|no updates|nothing needed)\b/i.test(
    summary.trim(),
  );
}

function routineSettlementNotification(input: {
  routine: RoutineRecord;
  runId: string;
  status: 'completed' | 'failed';
  settlement: RoutineSettlementDetails;
  report: Awaited<ReturnType<typeof writeReport>> | null;
  reportError: string | null;
}) {
  const shouldNotify =
    input.status === 'failed' ||
    Boolean(input.reportError) ||
    (!input.settlement.silent &&
      (input.routine.delivery === 'notification' ||
        input.routine.delivery === 'report'));
  if (!shouldNotify) return null;
  const failed = input.status === 'failed';
  return {
    level:
      failed || input.reportError ? ('attention' as const) : ('info' as const),
    title: failed
      ? 'Routine failed'
      : input.reportError
        ? 'Routine report failed'
        : 'Routine completed',
    message: input.reportError
      ? `${input.routine.name} ${failed ? 'failed' : 'completed'}, but final report writing failed: ${input.reportError}.`
      : `${input.routine.name}: ${input.settlement.summaryText}`,
    source: 'routine',
    sourceId: input.runId,
    data: {
      routineId: input.routine.id,
      runId: input.runId,
      status: input.status,
      reportId: input.report?.id ?? null,
      silent: input.settlement.silent,
    },
  };
}

function nextRunAfterCompletion(
  routine: RoutineRecord,
  outcome: 'recorded' | 'failed',
  completedAt: string,
) {
  const runCount = routine.runCount + 1;
  if (routine.scheduleKind === 'once')
    return { nextRunAt: null, disable: true };
  if (routine.repeatLimit !== null && runCount >= routine.repeatLimit) {
    return { nextRunAt: null, disable: true };
  }
  if (
    outcome === 'failed' &&
    routine.consecutiveFailures + 1 >= maxConsecutiveFailures
  ) {
    return { nextRunAt: null, disable: true };
  }
  const next = materializeNextRunAt(
    routine.scheduleKind,
    routine.schedule,
    new Date(completedAt),
  );
  return {
    nextRunAt: next.ok ? next.nextRunAt : null,
    disable: !next.ok,
  };
}

function resumeNextRunAt(routine: RoutineRecord, now: string) {
  if (routine.nextRunAt) {
    return { ok: true as const, nextRunAt: routine.nextRunAt };
  }
  if (routine.repeatLimit !== null && routine.runCount >= routine.repeatLimit) {
    return { ok: true as const, nextRunAt: null };
  }
  const nextRun = materializeNextRunAt(
    routine.scheduleKind,
    routine.schedule,
    new Date(now),
  );
  return nextRun.ok
    ? { ok: true as const, nextRunAt: nextRun.nextRunAt }
    : nextRun;
}

function routineAdmissionState(
  claimedRoutine: RoutineRecord,
  currentRoutine: RoutineRecord,
  admittedAt: string,
) {
  const nextRun = nextRunAfterCompletion(
    currentRoutine,
    'recorded',
    admittedAt,
  );
  const scheduleTimingChanged =
    currentRoutine.scheduleKind !== claimedRoutine.scheduleKind ||
    currentRoutine.schedule !== claimedRoutine.schedule;
  const repeatLimitReached =
    currentRoutine.repeatLimit !== null &&
    currentRoutine.runCount + 1 >= currentRoutine.repeatLimit;
  const disable =
    repeatLimitReached || (!scheduleTimingChanged && nextRun.disable);
  return {
    enabled: disable ? 0 : currentRoutine.enabled ? 1 : 0,
    nextRunAt: disable
      ? null
      : scheduleTimingChanged
        ? currentRoutine.nextRunAt
        : nextRun.nextRunAt,
  };
}

function dueRoutines(paths: RuntimePaths, now: Date, limit: number) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM routines
        WHERE enabled = 1
          AND running_run_id IS NULL
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?;
      `,
      )
      .all(now.toISOString(), Math.max(1, limit))
      .map(readRoutineRow);
  } finally {
    database.close();
  }
}

function routineAdmissionCapacity(paths: RuntimePaths, limit: number) {
  const normalizedLimit = Math.max(1, limit);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT COUNT(*) AS active
        FROM routines
        WHERE running_run_id IS NOT NULL;
      `,
      )
      .get() as { active?: number } | undefined;
    const active = Number(row?.active ?? 0);
    return {
      active,
      limit: normalizedLimit,
      available: Math.max(0, normalizedLimit - active),
    };
  } finally {
    database.close();
  }
}

async function recoverStaleRoutineClaims(paths: RuntimePaths, now: Date) {
  const completedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleRoutineRunMs).toISOString();
  const recovered: Array<{
    run: RoutineRunRecord;
    routine: RoutineRecord;
    message: string;
    error: string;
  }> = [];
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    const runs = database
      .prepare(
        `
        SELECT routine_runs.*
        FROM routine_runs
        INNER JOIN routines ON routines.running_run_id = routine_runs.id
        WHERE routine_runs.status = 'queued'
          AND routine_runs.started_at <= ?;
      `,
      )
      .all(staleBefore)
      .map(readRoutineRunRow);
    for (const run of runs) {
      const routineRow = database
        .prepare('SELECT * FROM routines WHERE id = ? LIMIT 1;')
        .get(run.routineId);
      if (!routineRow) continue;
      const routine = readRoutineRow(routineRow);
      if (routine.runningRunId !== run.id) continue;
      const failureCount = routine.consecutiveFailures + 1;
      const autoPause = failureCount >= maxConsecutiveFailures;
      const message = `Routine run ${run.id} was marked failed after waiting too long for Flue settlement.`;
      const error = `No Flue settlement observation arrived within ${Math.round(staleRoutineRunMs / 60000)} minutes.`;
      database
        .prepare(
          `
          UPDATE routine_runs
          SET
            status = 'failed',
            outcome = 'failed',
            message = ?,
            error = ?,
            completed_at = ?,
            updated_at = ?
          WHERE id = ? AND status = 'queued';
        `,
        )
        .run(message, error, completedAt, completedAt, run.id);
      database
        .prepare(
          `
          UPDATE routines
          SET
            running_run_id = NULL,
            consecutive_failures = ?,
            enabled = ?,
            next_run_at = ?,
            updated_at = ?
          WHERE id = ? AND running_run_id = ?;
        `,
        )
        .run(
          failureCount,
          autoPause ? 0 : routine.enabled ? 1 : 0,
          autoPause ? null : routine.nextRunAt,
          completedAt,
          routine.id,
          run.id,
        );
      recovered.push({ run, routine, message, error });
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
  for (const item of recovered) {
    const settledRun = readRoutineRunOrNull(paths, item.run.id);
    const settlement: RoutineSettlementDetails = {
      message: item.message,
      summaryText: item.error,
      outputText: null,
      error: item.error,
      silent: false,
      summary: {
        status: 'failed',
        message: item.message,
        summary: item.error,
        output: null,
        error: item.error,
        silent: false,
        observationType: 'stale_recovery',
      },
    };
    let report: Awaited<ReturnType<typeof writeReport>> | null = null;
    if (settledRun && item.routine.delivery === 'report') {
      try {
        report = await writeRoutineCompletionReport(
          {
            routine: item.routine,
            run: settledRun,
            dispatchId: settledRun.dispatchId ?? 'unknown',
            status: 'failed',
            completedAt,
            settlement,
          },
          paths,
        );
        updateRoutineRunSettlementReport(paths, item.run.id, {
          reportId: report.id,
          summary: { ...settlement.summary, reportId: report.id },
          updatedAt: completedAt,
        });
      } catch {
        report = null;
      }
    }
    if (item.run.sessionId && item.run.commandEventId) {
      await updateChatSessionCommandEvent(
        {
          sessionId: item.run.sessionId,
          eventId: item.run.commandEventId,
          status: 'failed',
          completedAt,
          reason: `routine:${item.routine.id}:stale`,
          result: {
            ok: false,
            command: 'routine',
            routineId: item.routine.id,
            runId: item.run.id,
            message: item.message,
            error: item.error,
            reportId: report?.id ?? null,
          },
        },
        paths,
      ).catch(() => undefined);
    }
    await addNotification(
      {
        level: 'attention',
        title: 'Routine settlement timed out',
        message: item.message,
        source: 'routine',
        sourceId: item.run.id,
        data: {
          routineId: item.routine.id,
          runId: item.run.id,
          error: item.error,
          reportId: report?.id ?? null,
        },
      },
      paths,
    );
    recordRoutineEvent(paths, {
      routineId: item.routine.id,
      runId: item.run.id,
      eventType: 'routine_run_stale_recovered',
      message: item.message,
      actor: 'scheduler',
      before: item.run,
      after: readRoutineRunOrNull(paths, item.run.id),
    });
  }
  return recovered.map((item) => item.run);
}

function readRoutineById(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM routines WHERE id = ? LIMIT 1;')
      .get(id);
    return row ? readRoutineRow(row) : null;
  } finally {
    database.close();
  }
}

function readRoutineRun(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM routine_runs WHERE id = ? LIMIT 1;')
      .get(id);
    if (!row) throw new Error(`Routine run "${id}" was not found.`);
    return readRoutineRunRow(row);
  } finally {
    database.close();
  }
}

function readRoutineRunOrNull(paths: RuntimePaths, id: string) {
  try {
    return readRoutineRun(paths, id);
  } catch {
    return null;
  }
}

function listRoutineRuns(
  paths: RuntimePaths,
  routineId: string,
  limit: number,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM routine_runs
        WHERE routine_id = ?
        ORDER BY created_at DESC
        LIMIT ?;
      `,
      )
      .all(routineId, limit)
      .map(readRoutineRunRow);
  } finally {
    database.close();
  }
}

function recordRoutineEvent(
  paths: RuntimePaths,
  input: {
    routineId?: string | null;
    runId?: string | null;
    eventType: string;
    message: string;
    actor: string;
    before?: unknown;
    after?: unknown;
    createdAt?: string;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO routine_events (
          id,
          routine_id,
          run_id,
          event_type,
          message,
          actor,
          before_json,
          after_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        `routine-event:${randomUUID()}`,
        input.routineId ?? null,
        input.runId ?? null,
        input.eventType,
        input.message,
        input.actor,
        input.before === undefined
          ? null
          : JSON.stringify(asJsonValue(input.before)),
        input.after === undefined
          ? null
          : JSON.stringify(asJsonValue(input.after)),
        input.createdAt ?? new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

async function validateRoutineSkills(ids: string[], paths: RuntimePaths) {
  const trimmed = ids.map((id) => id.trim()).filter(Boolean);
  const duplicateIds = trimmed.filter(
    (id, index) => trimmed.indexOf(id) !== index,
  );
  if (duplicateIds.length > 0) {
    return {
      ok: false as const,
      message: `Runtime skill ids must be unique: ${[...new Set(duplicateIds)].join(', ')}.`,
    };
  }
  const inventory = await listRuntimeSkills(paths);
  const available = new Set(inventory.skills.map((skill) => skill.id));
  const active = new Set(
    inventory.skills
      .filter((skill) => skill.status === 'active')
      .map((skill) => skill.id),
  );
  const missing = trimmed.filter((id) => !available.has(id));
  const inactive = trimmed.filter((id) => available.has(id) && !active.has(id));
  if (missing.length > 0) {
    return {
      ok: false as const,
      message: `Runtime skill${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}.`,
    };
  }
  if (inactive.length > 0) {
    return {
      ok: false as const,
      message: `Runtime skill${inactive.length === 1 ? '' : 's'} unavailable until duplicates or inactive entries are resolved: ${inactive.join(', ')}.`,
    };
  }
  return { ok: true as const, ids: trimmed };
}

function routineCommandEventInput(prompt: string) {
  if (prompt.length <= maxCommandEventInputLength) return prompt;
  const suffix =
    '\n\n[Routine prompt truncated for command log; full prompt was dispatched to Flue.]';
  return `${prompt.slice(0, maxCommandEventInputLength - suffix.length)}${suffix}`;
}

function dispatchReceiptId(receipt: DispatchReceipt) {
  return typeof receipt.dispatchId === 'string'
    ? receipt.dispatchId.trim() || null
    : null;
}

function normalizeIsoTimestamp(value: string) {
  if (!isoTimestampPattern.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  const comparable = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, millis: string) => {
        return `.${millis.padEnd(3, '0')}Z`;
      })
    : value.replace(/Z$/, '.000Z');
  return normalized === comparable ? normalized : null;
}

async function validateRoutineScope(
  repoId: string | null | undefined,
  cwd: string | null | undefined,
  paths: RuntimePaths,
) {
  const normalizedRepoId = repoId?.trim() || null;
  let repoPath: string | null = null;
  if (normalizedRepoId) {
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find((item) => item.id === normalizedRepoId);
    if (!repo) {
      return {
        ok: false as const,
        message: `Repository "${normalizedRepoId}" is not configured.`,
      };
    }
    if (!existsSync(repo.path)) {
      return {
        ok: false as const,
        message: `Repository "${normalizedRepoId}" path "${repo.path}" does not exist.`,
      };
    }
    repoPath = realpathSync(repo.path);
  }
  const normalizedCwd = cwd?.trim() || null;
  if (!normalizedCwd) {
    return { ok: true as const, repoId: normalizedRepoId, cwd: null };
  }
  const resolved = resolve(normalizedCwd);
  if (!existsSync(resolved)) {
    return {
      ok: false as const,
      message: `Scope cwd "${resolved}" does not exist.`,
    };
  }
  if (!statSync(resolved).isDirectory()) {
    return {
      ok: false as const,
      message: `Scope cwd "${resolved}" is not a directory.`,
    };
  }
  const realCwd = realpathSync(resolved);
  if (repoPath) {
    const repoRelativePath = relative(repoPath, realCwd);
    if (
      repoRelativePath === '..' ||
      repoRelativePath.startsWith('../') ||
      repoRelativePath.startsWith('..\\') ||
      isAbsolute(repoRelativePath)
    ) {
      return {
        ok: false as const,
        message: `Scope cwd "${realCwd}" must be inside repository "${normalizedRepoId}".`,
      };
    }
  }
  return {
    ok: true as const,
    repoId: normalizedRepoId,
    cwd: realCwd,
  };
}

function readRoutineRow(row: unknown): RoutineRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    name: String(record.name),
    prompt: String(record.prompt),
    scheduleKind: String(record.schedule_kind) as RoutineScheduleKind,
    schedule: String(record.schedule),
    skills: parseStringArray(record.skills_json),
    scopeRepoId: stringOrNull(record.scope_repo_id),
    scopeCwd: stringOrNull(record.scope_cwd),
    delivery: String(record.delivery) as RoutineDelivery,
    sessionId: stringOrNull(record.session_id),
    repeatLimit: numberOrNull(record.repeat_limit),
    runCount: Number(record.run_count ?? 0),
    consecutiveFailures: Number(record.consecutive_failures ?? 0),
    runningRunId: stringOrNull(record.running_run_id),
    enabled: Number(record.enabled ?? 0) === 1,
    createdBy: String(record.created_by),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
    lastRunAt: stringOrNull(record.last_run_at),
    nextRunAt: stringOrNull(record.next_run_at),
  };
}

function readRoutineRunRow(row: unknown): RoutineRunRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    routineId: String(record.routine_id),
    status: String(record.status) as RoutineRunStatus,
    outcome: String(record.outcome ?? 'recorded') as 'recorded' | 'failed',
    message: String(record.message),
    reportId: stringOrNull(record.report_id),
    sessionId: stringOrNull(record.session_id),
    commandEventId: stringOrNull(record.command_event_id),
    dispatchId: stringOrNull(record.dispatch_id),
    summary: parseJson(record.summary_json),
    error: stringOrNull(record.error),
    startedAt: String(record.started_at),
    completedAt: stringOrNull(record.completed_at),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function parseStringArray(value: unknown) {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseJson(value: unknown): JsonValue | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function failedResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextCronRun(expression: string, now: Date) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = parts;
  const start = new Date(now.getTime() + 60_000);
  start.setUTCSeconds(0, 0);
  for (let offset = 0; offset < 366 * 24 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (
      cronFieldMatches(minutePart, candidate.getUTCMinutes(), 0, 59) &&
      cronFieldMatches(hourPart, candidate.getUTCHours(), 0, 23) &&
      cronFieldMatches(dayPart, candidate.getUTCDate(), 1, 31) &&
      cronFieldMatches(monthPart, candidate.getUTCMonth() + 1, 1, 12) &&
      cronFieldMatches(weekdayPart, candidate.getUTCDay(), 0, 6)
    ) {
      return candidate;
    }
  }
  return null;
}

function cronFieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
) {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const number = Number(part);
    return (
      Number.isInteger(number) &&
      number >= min &&
      number <= max &&
      number === value
    );
  });
}
