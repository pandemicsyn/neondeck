import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import {
  scheduledTaskSpecSchema,
  type AutomationTrigger,
  type ScheduledTaskRecord,
  type ScheduledTaskRunRecord,
} from './schemas';
import { nextOccurrence, validateAutomationTrigger } from './triggers';
import * as v from 'valibot';

const defaultClaimTtlMs = 5 * 60 * 1_000;

export async function listScheduledTasks(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM scheduled_tasks
        ORDER BY next_run_at ASC, updated_at DESC;
      `,
      )
      .all()
      .map(readScheduledTaskRow);
  } finally {
    database.close();
  }
}

export async function readScheduledTask(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?;')
      .get(id);
    return row ? readScheduledTaskRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function readLatestScheduledTaskRun(
  taskId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM scheduled_task_runs
        WHERE task_id = ? AND status IN ('completed', 'failed')
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      )
      .get(taskId);
    return row ? readScheduledTaskRunRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function upsertScheduledTask(
  input: {
    id: string;
    spec: unknown;
    trigger: unknown;
    enabled?: boolean;
    nextRunAt?: string | null;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const spec = v.parse(scheduledTaskSpecSchema, input.spec);
  const triggerResult = validateAutomationTrigger(input.trigger);
  if (!triggerResult.ok) throw new Error(triggerResult.message);
  const trigger = triggerResult.trigger;
  const now = new Date();
  const existing = await readScheduledTask(input.id, paths);
  const record: ScheduledTaskRecord = {
    id: input.id,
    spec,
    trigger,
    enabled: input.enabled ?? existing?.enabled ?? true,
    nextRunAt:
      input.nextRunAt ??
      (existing && sameTrigger(existing.trigger, trigger)
        ? existing.nextRunAt
        : nextOccurrence(trigger, now)),
    claimId: existing?.claimId ?? null,
    claimExpiresAt: existing?.claimExpiresAt ?? null,
    lastRunAt: existing?.lastRunAt ?? null,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO scheduled_tasks (
          id, kind, trigger_json, payload_json, enabled, next_run_at,
          claim_id, claim_expires_at, last_run_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          trigger_json = excluded.trigger_json,
          payload_json = excluded.payload_json,
          enabled = excluded.enabled,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        record.id,
        record.spec.kind,
        JSON.stringify(asJsonValue(record.trigger)),
        JSON.stringify(asJsonValue(record.spec)),
        record.enabled ? 1 : 0,
        record.nextRunAt,
        record.claimId,
        record.claimExpiresAt,
        record.lastRunAt,
        record.createdAt,
        record.updatedAt,
      );
  } finally {
    database.close();
  }
  return record;
}

export async function deleteScheduledTask(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?;')
      .run(id);
    database.prepare('DELETE FROM scheduled_tasks WHERE id = ?;').run(id);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function setScheduledTaskEnabled(
  id: string,
  enabled: boolean,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const result = database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET enabled = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    if (result.changes !== 1) return undefined;
  } finally {
    database.close();
  }
  return readScheduledTask(id, paths);
}

export async function claimDueScheduledTasks(
  paths = runtimePaths(),
  now = new Date(),
  limit = 10,
  claimTtlMs = defaultClaimTtlMs,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const claimed: Array<{
    task: ScheduledTaskRecord;
    previous: ScheduledTaskRecord;
    run: ScheduledTaskRunRecord;
  }> = [];
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + claimTtlMs).toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    const due = database
      .prepare(
        `
        SELECT *
        FROM scheduled_tasks
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
          AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
        ORDER BY next_run_at ASC, id ASC
        LIMIT ?;
      `,
      )
      .all(nowIso, nowIso, limit)
      .map(readScheduledTaskRow);

    for (const task of due) {
      const claimId = `scheduled-task-claim:${randomUUID()}`;
      const runId = `scheduled-task-run:${randomUUID()}`;
      const nextRunAt = nextOccurrence(task.trigger, now);
      const enabled = task.trigger.kind === 'once' ? false : task.enabled;
      const updated = database
        .prepare(
          `
          UPDATE scheduled_tasks
          SET claim_id = ?, claim_expires_at = ?, next_run_at = ?,
              enabled = ?, last_run_at = ?, updated_at = ?
          WHERE id = ?
            AND enabled = 1
            AND (claim_expires_at IS NULL OR claim_expires_at <= ?);
        `,
        )
        .run(
          claimId,
          expiresAt,
          nextRunAt,
          enabled ? 1 : 0,
          nowIso,
          nowIso,
          task.id,
          nowIso,
        );
      if (updated.changes !== 1) continue;
      const run: ScheduledTaskRunRecord = {
        id: runId,
        taskId: task.id,
        status: 'claimed',
        outcome: 'recorded',
        message: 'Scheduled task claimed.',
        workflowRunId: null,
        sessionId: null,
        result: null,
        error: null,
        startedAt: nowIso,
        completedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      database
        .prepare(
          `
          INSERT INTO scheduled_task_runs (
            id, task_id, status, outcome, message, workflow_run_id, session_id,
            result_json, error, started_at, completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `,
        )
        .run(
          run.id,
          run.taskId,
          run.status,
          run.outcome,
          run.message,
          null,
          null,
          null,
          null,
          run.startedAt,
          null,
          run.createdAt,
          run.updatedAt,
        );
      claimed.push({
        task: {
          ...task,
          enabled,
          nextRunAt,
          claimId,
          claimExpiresAt: expiresAt,
          lastRunAt: nowIso,
          updatedAt: nowIso,
        },
        previous: task,
        run,
      });
    }
    database.exec('COMMIT;');
    return claimed;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function releaseUnstartedScheduledTaskClaim(
  input: {
    task: ScheduledTaskRecord;
    previous: ScheduledTaskRecord;
    run: ScheduledTaskRunRecord;
    message: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = 'failed', outcome = 'failed', message = ?, error = ?,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND status = 'claimed';
      `,
      )
      .run(input.message, input.message, now, now, input.run.id, input.task.id);
    database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET enabled = ?, next_run_at = ?, claim_id = NULL, claim_expires_at = NULL,
            last_run_at = ?, updated_at = ?
        WHERE id = ? AND claim_id = ?;
      `,
      )
      .run(
        input.previous.enabled ? 1 : 0,
        input.previous.nextRunAt,
        input.previous.lastRunAt,
        now,
        input.task.id,
        input.task.claimId,
      );
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function settleScheduledTaskRun(
  input: {
    taskId: string;
    runId: string;
    claimId: string;
    status: 'completed' | 'failed';
    outcome: 'recorded' | 'silent' | 'failed';
    message: string;
    workflowRunId?: string | null;
    sessionId?: string | null;
    result?: unknown;
    error?: string | null;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = ?, outcome = ?, message = ?, workflow_run_id = ?, session_id = ?,
            result_json = ?, error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND task_id = ?;
      `,
      )
      .run(
        input.status,
        input.outcome,
        input.message,
        input.workflowRunId ?? null,
        input.sessionId ?? null,
        input.result === undefined
          ? null
          : JSON.stringify(asJsonValue(input.result)),
        input.error ?? null,
        now,
        now,
        input.runId,
        input.taskId,
      );
    database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET claim_id = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE id = ? AND claim_id = ?;
      `,
      )
      .run(now, input.taskId, input.claimId);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function readScheduledTaskRow(row: unknown): ScheduledTaskRecord {
  const record = row as Record<string, unknown>;
  const spec = v.parse(
    scheduledTaskSpecSchema,
    JSON.parse(String(record.payload_json)),
  );
  const triggerResult = validateAutomationTrigger(
    JSON.parse(String(record.trigger_json)),
  );
  if (!triggerResult.ok) throw new Error(triggerResult.message);
  return {
    id: String(record.id),
    spec,
    trigger: triggerResult.trigger,
    enabled: Boolean(record.enabled),
    nextRunAt:
      typeof record.next_run_at === 'string' ? record.next_run_at : null,
    claimId: typeof record.claim_id === 'string' ? record.claim_id : null,
    claimExpiresAt:
      typeof record.claim_expires_at === 'string'
        ? record.claim_expires_at
        : null,
    lastRunAt:
      typeof record.last_run_at === 'string' ? record.last_run_at : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function readScheduledTaskRunRow(row: unknown): ScheduledTaskRunRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    taskId: String(record.task_id),
    status: v.parse(
      v.picklist(['claimed', 'completed', 'failed']),
      record.status,
    ),
    outcome: v.parse(
      v.picklist(['recorded', 'silent', 'failed']),
      record.outcome,
    ),
    message: String(record.message),
    workflowRunId:
      typeof record.workflow_run_id === 'string'
        ? record.workflow_run_id
        : null,
    sessionId: typeof record.session_id === 'string' ? record.session_id : null,
    result:
      typeof record.result_json === 'string'
        ? (JSON.parse(record.result_json) as ScheduledTaskRunRecord['result'])
        : null,
    error: typeof record.error === 'string' ? record.error : null,
    startedAt: String(record.started_at),
    completedAt:
      typeof record.completed_at === 'string' ? record.completed_at : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function sameTrigger(left: AutomationTrigger, right: AutomationTrigger) {
  return JSON.stringify(left) === JSON.stringify(right);
}
