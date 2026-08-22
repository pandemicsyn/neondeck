import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import {
  scheduledTaskSpecSchema,
  scheduledTaskSpecIssue,
  type AutomationTrigger,
  type ScheduledInstructionDispatchPayload,
  type ScheduledTaskRecord,
  type ScheduledTaskRunRecord,
} from './schemas';
import { nextOccurrence, validateAutomationTrigger } from './triggers';
import {
  maxPersistedScheduledRunResultBytes,
  sanitizedBoundedContent,
  sanitizedScheduledRunResult,
  sanitizedScheduledRunText,
} from './content';
import {
  isoDateStringSchema,
  nonEmptyStringSchema as dbNonEmptyStringSchema,
  nullableIsoDateStringColumnSchema,
  nullableStringColumnSchema,
} from '../../lib/valibot';
import { isJsonValue } from '../execution/utils';
import * as v from 'valibot';

const defaultClaimTtlMs = 5 * 60 * 1_000;
export const maxActiveScheduledSubmissions = 10;

const scheduledTaskDbRowSchema = v.strictObject({
  id: dbNonEmptyStringSchema,
  kind: dbNonEmptyStringSchema,
  payload_json: v.string(),
  trigger_json: v.string(),
  enabled: v.picklist([0, 1]),
  next_run_at: nullableIsoDateStringColumnSchema,
  claim_id: nullableStringColumnSchema,
  claim_expires_at: nullableIsoDateStringColumnSchema,
  last_run_at: nullableIsoDateStringColumnSchema,
  created_at: isoDateStringSchema,
  updated_at: isoDateStringSchema,
});

const dispatchPayloadSchema = v.strictObject({
  prompt: v.string(),
  taskId: dbNonEmptyStringSchema,
  runId: v.optional(dbNonEmptyStringSchema),
  workspaceId: v.optional(dbNonEmptyStringSchema),
  cwd: v.optional(v.string()),
  lockOwner: v.optional(dbNonEmptyStringSchema),
  skillSnapshots: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          name: dbNonEmptyStringSchema,
          description: v.string(),
          instructions: v.string(),
          files: v.array(
            v.strictObject({
              path: dbNonEmptyStringSchema,
              encoding: v.picklist(['utf8', 'base64']),
              content: v.string(),
            }),
          ),
        }),
      ),
      v.check(
        (snapshots) =>
          new Set(snapshots.map((snapshot) => snapshot.name)).size ===
          snapshots.length,
        'Scheduled skill snapshot names must be unique.',
      ),
    ),
  ),
});

const scheduledTaskRunDbRowSchema = v.strictObject({
  id: dbNonEmptyStringSchema,
  task_id: dbNonEmptyStringSchema,
  status: v.picklist(['claimed', 'active', 'completed', 'failed']),
  outcome: v.picklist(['recorded', 'silent', 'failed']),
  message: v.string(),
  submission_id: nullableStringColumnSchema,
  session_id: nullableStringColumnSchema,
  dispatch_key: nullableStringColumnSchema,
  dispatch_payload_json: v.nullable(v.string()),
  result_json: v.nullable(v.string()),
  error: nullableStringColumnSchema,
  started_at: isoDateStringSchema,
  completed_at: nullableIsoDateStringColumnSchema,
  created_at: isoDateStringSchema,
  updated_at: isoDateStringSchema,
});

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

export async function readActiveScheduledTaskRun(
  taskId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT * FROM scheduled_task_runs
         WHERE task_id = ? AND status IN ('claimed', 'active')
         ORDER BY created_at DESC LIMIT 1;`,
      )
      .get(taskId);
    return row ? readScheduledTaskRunRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function listScheduledTaskRuns(
  taskId: string,
  paths = runtimePaths(),
  limit = 50,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT * FROM scheduled_task_runs
         WHERE task_id = ? ORDER BY created_at DESC LIMIT ?;`,
      )
      .all(taskId, Math.max(1, Math.min(limit, 200)))
      .map(readScheduledTaskRunRow);
  } finally {
    database.close();
  }
}

export async function readScheduledTaskRun(
  runId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM scheduled_task_runs WHERE id = ?;')
      .get(runId);
    return row ? readScheduledTaskRunRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function readScheduledTaskRunSync(id: string, paths = runtimePaths()) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM scheduled_task_runs WHERE id = ?;')
      .get(id);
    return row ? readScheduledTaskRunRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function makeScheduledTaskDue(
  taskId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const task = database
      .prepare(
        `SELECT 1 FROM scheduled_tasks WHERE id = ? AND claim_id IS NULL;`,
      )
      .get(taskId);
    if (!task) {
      database.exec('COMMIT;');
      return false;
    }
    const result = database
      .prepare(
        `INSERT OR IGNORE INTO app_metadata (key, value, updated_at)
         VALUES (?, ?, ?);`,
      )
      .run(
        `scheduled-task-manual-occurrence:${taskId}`,
        JSON.stringify({ requestedAt: now, notBefore: now }),
        now,
      );
    database.exec('COMMIT;');
    return result.changes === 1;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function listRecoverableScheduledBriefingRuns(
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `SELECT scheduled_task_runs.*,
                app_metadata.value AS briefing_run_id
         FROM scheduled_task_runs
         JOIN scheduled_tasks
           ON scheduled_tasks.id = scheduled_task_runs.task_id
          AND scheduled_tasks.kind = 'run-briefing'
         LEFT JOIN app_metadata
           ON app_metadata.key = 'scheduled-briefing-run:' || scheduled_task_runs.id
         WHERE scheduled_task_runs.status IN ('claimed', 'active')
         ORDER BY scheduled_task_runs.created_at ASC;`,
      )
      .all()
      .map((row) => {
        const record = v.parse(
          v.object({
            ...scheduledTaskRunDbRowSchema.entries,
            briefing_run_id: nullableStringColumnSchema,
          }),
          row,
        );
        const { briefing_run_id: briefingRunId, ...run } = record;
        return {
          run: readScheduledTaskRunRow(run),
          briefingRunId,
        };
      });
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
  const workspaceIssue = scheduledTaskSpecIssue(spec);
  if (workspaceIssue) throw new Error(workspaceIssue);
  const triggerResult = validateAutomationTrigger(input.trigger);
  if (!triggerResult.ok) throw new Error(triggerResult.message);
  const trigger = triggerResult.trigger;
  const now = new Date();
  const existing = await readScheduledTask(input.id, paths);
  if (existing && existing.spec.kind !== spec.kind) {
    throw new Error(
      `Scheduled task "${input.id}" is a ${existing.spec.kind} task and cannot be replaced with ${spec.kind}.`,
    );
  }
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
    const blocked = database
      .prepare(
        `SELECT 1
         FROM scheduled_tasks
         WHERE id = ?
           AND (
             claim_id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM scheduled_task_runs
               WHERE task_id = scheduled_tasks.id
                 AND status IN ('claimed', 'active')
             )
             OR EXISTS (
               SELECT 1 FROM task_workspaces
               WHERE task_id = scheduled_tasks.id
                 AND status <> 'deleted'
             )
           )
         LIMIT 1;`,
      )
      .get(id);
    if (blocked) {
      database.exec('COMMIT;');
      return false;
    }
    database
      .prepare(
        `DELETE FROM scheduled_run_artifacts
         WHERE run_id IN (SELECT id FROM scheduled_task_runs WHERE task_id = ?);`,
      )
      .run(id);
    database
      .prepare(
        `DELETE FROM scheduled_run_workspace_snapshots
         WHERE run_id IN (SELECT id FROM scheduled_task_runs WHERE task_id = ?);`,
      )
      .run(id);
    database
      .prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?;')
      .run(id);
    database
      .prepare('DELETE FROM app_metadata WHERE key = ?;')
      .run(`scheduled-task-manual-occurrence:${id}`);
    const deleted = database
      .prepare('DELETE FROM scheduled_tasks WHERE id = ?;')
      .run(id);
    database.exec('COMMIT;');
    return deleted.changes === 1;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function setScheduledTaskEnabled(
  id: string,
  enabled: boolean,
  paths = runtimePaths(),
  options: {
    clearMetadataKeys?: string[];
    watchGuard?: { id: string; disallowAutopilotStatuses: string[] };
  } = {},
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    if (options.watchGuard) {
      const watch = database
        .prepare('SELECT autopilot_status FROM pr_watches WHERE id = ?;')
        .get(options.watchGuard.id) as
        { autopilot_status?: string } | undefined;
      if (
        !watch ||
        options.watchGuard.disallowAutopilotStatuses.includes(
          String(watch.autopilot_status),
        )
      ) {
        database.exec('COMMIT;');
        return undefined;
      }
    }
    const current = database
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?;')
      .get(id);
    if (!current) {
      database.exec('COMMIT;');
      return undefined;
    }
    const task = readScheduledTaskRow(current);
    const now = new Date();
    const resumeAt =
      enabled &&
      !task.enabled &&
      (!task.nextRunAt || Date.parse(task.nextRunAt) <= now.getTime())
        ? nextOccurrence(task.trigger, now)
        : task.nextRunAt;
    const nextEnabled = enabled && (task.trigger.kind !== 'once' || resumeAt);
    const result = database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(nextEnabled ? 1 : 0, resumeAt, now.toISOString(), id);
    for (const key of options.clearMetadataKeys ?? []) {
      database.prepare('DELETE FROM app_metadata WHERE key = ?;').run(key);
    }
    database.exec('COMMIT;');
    if (result.changes !== 1) return undefined;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
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
    database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET enabled = 1, next_run_at = ?, updated_at = ?
        WHERE json_extract(trigger_json, '$.kind') = 'once'
          AND claim_id IS NOT NULL
          AND claim_expires_at <= ?;
      `,
      )
      .run(nowIso, nowIso, nowIso);
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = 'failed', outcome = 'failed',
            message = 'Scheduled task claim expired before execution completed.',
            error = 'Scheduled task claim expired before execution completed.',
            completed_at = ?, updated_at = ?
        WHERE status = 'claimed'
          AND EXISTS (
            SELECT 1
            FROM scheduled_tasks
            WHERE scheduled_tasks.id = scheduled_task_runs.task_id
              AND scheduled_tasks.claim_id IS NOT NULL
              AND scheduled_tasks.claim_expires_at <= ?
          );
      `,
      )
      .run(nowIso, nowIso, nowIso);
    database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET claim_id = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE claim_id IS NOT NULL AND claim_expires_at <= ?;
      `,
      )
      .run(nowIso, nowIso);
    const skipped = database
      .prepare(
        `SELECT *
         FROM scheduled_tasks
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
           AND COALESCE(json_extract(payload_json, '$.workspace.overlap'), 'skip') = 'skip'
           AND EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE scheduled_task_runs.task_id = scheduled_tasks.id
               AND scheduled_task_runs.status = 'active'
           );`,
      )
      .all(nowIso)
      .map(readScheduledTaskRow);
    for (const task of skipped) {
      const scheduledFor = task.nextRunAt;
      if (!scheduledFor) continue;
      const nextRunAt = nextOccurrence(task.trigger, now);
      const enabled = task.trigger.kind === 'once' ? false : task.enabled;
      const updated = database
        .prepare(
          `UPDATE scheduled_tasks
           SET next_run_at = ?, enabled = ?, last_run_at = ?, updated_at = ?
           WHERE id = ? AND next_run_at <= ?;`,
        )
        .run(nextRunAt, enabled ? 1 : 0, scheduledFor, nowIso, task.id, nowIso);
      if (updated.changes !== 1) continue;
      database
        .prepare(
          `INSERT INTO scheduled_task_runs (
             id, task_id, status, outcome, message, submission_id, session_id,
             dispatch_key, dispatch_payload_json, result_json, error, started_at,
             completed_at, created_at, updated_at
           ) VALUES (?, ?, 'completed', 'silent', ?, NULL, NULL, NULL, NULL, ?,
                     NULL, ?, ?, ?, ?);`,
        )
        .run(
          `scheduled-task-run:${randomUUID()}`,
          task.id,
          `Skipped the occurrence scheduled for ${scheduledFor} because another run was active and overlap policy is skip.`,
          JSON.stringify({ reason: 'overlap-skip', scheduledFor }),
          scheduledFor,
          nowIso,
          nowIso,
          nowIso,
        );
    }
    const due = database
      .prepare(
        `
        SELECT *
        FROM scheduled_tasks
        WHERE (
            (enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?)
            OR EXISTS (
              SELECT 1 FROM app_metadata
              WHERE app_metadata.key = 'scheduled-task-manual-occurrence:' || scheduled_tasks.id
                AND COALESCE(json_extract(app_metadata.value, '$.notBefore'), app_metadata.updated_at) <= ?
            )
          )
          AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
          AND (
            json_extract(payload_json, '$.workspace.overlap') = 'allow-parallel'
            OR NOT EXISTS (
              SELECT 1
              FROM scheduled_task_runs
              WHERE scheduled_task_runs.task_id = scheduled_tasks.id
                AND scheduled_task_runs.status = 'active'
            )
          )
        ORDER BY next_run_at ASC, id ASC
        LIMIT ?;
      `,
      )
      .all(nowIso, nowIso, nowIso, limit)
      .map(readScheduledTaskRow);

    for (const task of due) {
      const manual = Boolean(
        database
          .prepare('SELECT 1 FROM app_metadata WHERE key = ?;')
          .get(`scheduled-task-manual-occurrence:${task.id}`),
      );
      const claimId = `scheduled-task-claim:${randomUUID()}`;
      const runId = `scheduled-task-run:${randomUUID()}`;
      const nextRunAt = manual
        ? task.nextRunAt
        : nextOccurrence(task.trigger, now);
      const enabled = manual
        ? task.enabled
        : task.trigger.kind === 'once'
          ? false
          : task.enabled;
      const updated = database
        .prepare(
          `
          UPDATE scheduled_tasks
          SET claim_id = ?, claim_expires_at = ?, next_run_at = ?,
              enabled = ?, last_run_at = ?, updated_at = ?
          WHERE id = ?
            AND (
              enabled = 1 OR EXISTS (
                SELECT 1 FROM app_metadata
                WHERE app_metadata.key = 'scheduled-task-manual-occurrence:' || scheduled_tasks.id
                  AND COALESCE(json_extract(app_metadata.value, '$.notBefore'), app_metadata.updated_at) <= ?
              )
            )
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
          nowIso,
        );
      if (updated.changes !== 1) continue;
      if (manual) {
        database
          .prepare('DELETE FROM app_metadata WHERE key = ?;')
          .run(`scheduled-task-manual-occurrence:${task.id}`);
      }
      const run: ScheduledTaskRunRecord = {
        id: runId,
        taskId: task.id,
        status: 'claimed',
        outcome: 'recorded',
        message: manual
          ? 'Manual scheduled task occurrence claimed.'
          : 'Scheduled task claimed.',
        submissionId: null,
        sessionId: null,
        dispatchKey: null,
        dispatchPayload: null,
        result: manual ? { reason: 'manual-occurrence' } : null,
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
            id, task_id, status, outcome, message, submission_id, session_id,
            dispatch_key, dispatch_payload_json, result_json, error, started_at,
            completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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
          manual ? JSON.stringify({ reason: 'manual-occurrence' }) : null,
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
    rollbackQuietly(database);
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
        WHERE id = ? AND task_id = ? AND status IN ('claimed', 'active');
      `,
      )
      .run(
        sanitizedScheduledRunText(input.message),
        sanitizedScheduledRunText(input.message),
        now,
        now,
        input.run.id,
        input.task.id,
      );
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
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function deferUnstartedScheduledTaskClaim(
  input: {
    task: ScheduledTaskRecord;
    previous: ScheduledTaskRecord;
    run: ScheduledTaskRunRecord;
    message: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const nowIso = now.toISOString();
  const retryAt = new Date(now.getTime() + 60_000).toISOString();
  const manual =
    input.run.result !== null &&
    typeof input.run.result === 'object' &&
    !Array.isArray(input.run.result) &&
    input.run.result.reason === 'manual-occurrence';
  const nextRunAt = manual
    ? input.previous.nextRunAt
    : input.task.trigger.kind === 'once'
      ? retryAt
      : nextOccurrence(input.task.trigger, now);
  const enabled = manual
    ? input.previous.enabled
    : input.task.trigger.kind === 'once'
      ? input.previous.enabled
      : input.task.enabled;
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = 'completed', outcome = 'silent', message = ?, error = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND status IN ('claimed', 'active');
      `,
      )
      .run(
        sanitizedScheduledRunText(input.message),
        nowIso,
        nowIso,
        input.run.id,
        input.task.id,
      );
    database
      .prepare(
        `
        UPDATE scheduled_tasks
        SET enabled = ?, next_run_at = ?, claim_id = NULL, claim_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND claim_id = ?;
      `,
      )
      .run(
        enabled ? 1 : 0,
        nextRunAt,
        nowIso,
        input.task.id,
        input.task.claimId,
      );
    if (manual) {
      database
        .prepare(
          `INSERT INTO app_metadata (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
        )
        .run(
          `scheduled-task-manual-occurrence:${input.task.id}`,
          JSON.stringify({ requestedAt: nowIso, notBefore: retryAt }),
          nowIso,
        );
    }
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function canAdmitScheduledSubmission(
  taskId: string,
  paths = runtimePaths(),
  maximumActiveRuns = maxActiveScheduledSubmissions,
  allowParallelForTask = false,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const activeForTask = database
      .prepare(
        `
        SELECT 1
        FROM scheduled_task_runs
        WHERE task_id = ? AND status = 'active'
        LIMIT 1;
      `,
      )
      .get(taskId);
    if (activeForTask && !allowParallelForTask) return false;
    const row = v.parse(
      v.strictObject({ count: v.number() }),
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM scheduled_task_runs
           WHERE status = 'active';`,
        )
        .get(),
    );
    return row.count < maximumActiveRuns;
  } finally {
    database.close();
  }
}

export async function activateScheduledTaskSubmission(
  input: {
    taskId: string;
    runId: string;
    claimId: string;
    sessionId: string;
    dispatchKey: string;
    dispatchPayload: ScheduledInstructionDispatchPayload;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const run = database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = 'active', message = ?, session_id = ?, dispatch_key = ?,
            dispatch_payload_json = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND status = 'claimed';
      `,
      )
      .run(
        'Scheduled instruction admission is pending.',
        input.sessionId,
        input.dispatchKey,
        JSON.stringify(asJsonValue(input.dispatchPayload)),
        now,
        input.runId,
        input.taskId,
      );
    if (run.changes !== 1)
      throw new Error('Scheduled task run is not claimable.');
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
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function listActiveScheduledInstructionRuns(
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT scheduled_task_runs.*
        FROM scheduled_task_runs
        INNER JOIN scheduled_tasks
          ON scheduled_tasks.id = scheduled_task_runs.task_id
        WHERE scheduled_task_runs.status = 'active'
          AND scheduled_tasks.kind = 'run-agent-instruction'
        ORDER BY scheduled_task_runs.created_at ASC;
      `,
      )
      .all()
      .map(readScheduledTaskRunRow);
  } finally {
    database.close();
  }
}

export async function attachScheduledTaskSubmissionId(
  input: {
    runId: string;
    submissionId: string;
    sessionId?: string | null;
    result?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET submission_id = ?, session_id = COALESCE(?, session_id),
            result_json = COALESCE(?, result_json), message = ?, error = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'active';
      `,
      )
      .run(
        input.submissionId,
        input.sessionId ?? null,
        input.result === undefined
          ? null
          : JSON.stringify(sanitizedScheduledRunResult(input.result)),
        'Scheduled instruction dispatched and awaiting submission settlement.',
        new Date().toISOString(),
        input.runId,
      );
  } finally {
    database.close();
  }
}

export async function activateScheduledTaskResultSubmission(
  input: {
    taskId: string;
    runId: string;
    claimId: string;
    submissionId: string;
    sessionId?: string | null;
    result?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const activated = database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = 'active', submission_id = ?, session_id = ?,
            result_json = ?, message = ?, error = NULL, updated_at = ?
        WHERE id = ? AND task_id = ? AND status = 'claimed';
      `,
      )
      .run(
        input.submissionId,
        input.sessionId ?? null,
        input.result === undefined
          ? null
          : JSON.stringify(sanitizedScheduledRunResult(input.result)),
        'Scheduled task dispatched and awaiting submission settlement.',
        now,
        input.runId,
        input.taskId,
      );
    if (activated.changes !== 1)
      throw new Error('Scheduled task run is not claimable.');
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
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function recordScheduledTaskAdmissionRetry(
  input: { runId: string; message: string },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET message = 'Scheduled instruction admission will be retried.',
            error = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND submission_id IS NULL;
      `,
      )
      .run(
        sanitizedScheduledRunText(input.message),
        new Date().toISOString(),
        input.runId,
      );
  } finally {
    database.close();
  }
}

export async function settleScheduledTaskSubmission(
  input: { submissionId: string; failed: boolean; response?: string },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const response =
    input.response === undefined
      ? undefined
      : sanitizedBoundedContent(
          input.response,
          maxPersistedScheduledRunResultBytes / 2,
        );
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const row = v.parse(
      v.optional(v.strictObject({ result_json: v.nullable(v.string()) })),
      database
        .prepare(
          `SELECT result_json FROM scheduled_task_runs
           WHERE submission_id = ? AND status = 'active';`,
        )
        .get(input.submissionId),
    );
    if (!row) {
      database.exec('COMMIT;');
      return;
    }
    const current =
      row.result_json === null
        ? null
        : v.parse(
            v.custom<JsonValue>(isJsonValue, 'Expected persisted JSON data.'),
            JSON.parse(row.result_json),
          );
    const currentObject =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? current
        : {};
    const result = sanitizedScheduledRunResult(
      response
        ? {
            ...currentObject,
            response: response.content,
            responseTruncated: response.truncated,
            responseRedacted: response.redacted,
          }
        : current,
    );
    database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = ?, outcome = ?, message = ?, error = ?,
            result_json = ?,
            completed_at = ?, updated_at = ?
        WHERE submission_id = ? AND status = 'active';
      `,
      )
      .run(
        input.failed ? 'failed' : 'completed',
        input.failed ? 'failed' : 'recorded',
        input.failed
          ? 'Scheduled instruction submission failed.'
          : 'Scheduled instruction completed.',
        input.failed ? 'See sanitized submission activity.' : null,
        JSON.stringify(result),
        now,
        now,
        input.submissionId,
      );
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Modern scheduled instruction outbox rows carry a dispatch payload, so their
 * settlement watcher remains the sole terminalizer and can persist the final
 * response (plus repository evidence when present). Observation settlement is
 * retained only for legacy rows that predate the durable dispatch payload.
 */
export async function settleScheduledTaskObservation(
  input: { submissionId: string; failed: boolean },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT dispatch_payload_json FROM scheduled_task_runs
         WHERE submission_id = ? AND status = 'active' LIMIT 1;`,
      )
      .get(input.submissionId) as
      { dispatch_payload_json?: string | null } | undefined;
    if (row?.dispatch_payload_json) return false;
  } finally {
    database.close();
  }
  await settleScheduledTaskSubmission(input, paths);
  return true;
}

export async function settleScheduledTaskRun(
  input: {
    taskId: string;
    runId: string;
    claimId: string;
    status: 'completed' | 'failed';
    outcome: 'recorded' | 'silent' | 'failed';
    message: string;
    submissionId?: string | null;
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
    const settled = database
      .prepare(
        `
        UPDATE scheduled_task_runs
        SET status = ?, outcome = ?, message = ?, submission_id = ?, session_id = ?,
            result_json = ?, error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND status IN ('claimed', 'active');
      `,
      )
      .run(
        input.status,
        input.outcome,
        sanitizedScheduledRunText(input.message),
        input.submissionId ?? null,
        input.sessionId ?? null,
        input.result === undefined
          ? null
          : JSON.stringify(sanitizedScheduledRunResult(input.result)),
        input.error === undefined || input.error === null
          ? null
          : sanitizedScheduledRunText(input.error),
        now,
        now,
        input.runId,
        input.taskId,
      );
    if (settled.changes !== 1) {
      database.exec('COMMIT;');
      return false;
    }
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
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

function readScheduledTaskRow(row: unknown): ScheduledTaskRecord {
  const record = v.parse(scheduledTaskDbRowSchema, row);
  const spec = v.parse(
    scheduledTaskSpecSchema,
    JSON.parse(record.payload_json),
  );
  const specIssue = scheduledTaskSpecIssue(spec);
  if (specIssue) throw new Error(specIssue);
  const triggerResult = validateAutomationTrigger(
    JSON.parse(record.trigger_json),
  );
  if (!triggerResult.ok) throw new Error(triggerResult.message);
  return {
    id: record.id,
    spec,
    trigger: triggerResult.trigger,
    enabled: record.enabled === 1,
    nextRunAt: record.next_run_at,
    claimId: record.claim_id,
    claimExpiresAt: record.claim_expires_at,
    lastRunAt: record.last_run_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function readScheduledTaskRunRow(row: unknown): ScheduledTaskRunRecord {
  const record = v.parse(scheduledTaskRunDbRowSchema, row);
  return {
    id: record.id,
    taskId: record.task_id,
    status: record.status,
    outcome: record.outcome,
    message: sanitizedScheduledRunText(record.message),
    submissionId: record.submission_id,
    sessionId: record.session_id,
    dispatchKey: record.dispatch_key,
    dispatchPayload:
      record.dispatch_payload_json !== null
        ? v.parse(
            dispatchPayloadSchema,
            JSON.parse(record.dispatch_payload_json),
          )
        : null,
    result:
      record.result_json !== null
        ? sanitizedScheduledRunResult(
            v.parse(
              v.custom<ScheduledTaskRunRecord['result']>(
                isJsonValue,
                'Expected persisted JSON data.',
              ),
              JSON.parse(record.result_json),
            ),
          )
        : null,
    error:
      record.error === null ? null : sanitizedScheduledRunText(record.error),
    startedAt: record.started_at,
    completedAt: record.completed_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function sameTrigger(left: AutomationTrigger, right: AutomationTrigger) {
  return JSON.stringify(left) === JSON.stringify(right);
}
