import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  publishNotificationEvent,
  readNotificationRow,
  type AutomationExecutionResult,
  type NotificationRecord,
} from '../app-state';
import type {
  PrWatch,
  PrWatchInitialWatermark,
  PrWatchRemovalFence,
  PrWatchStateFence,
  RefWatch,
} from './schemas';
import {
  autopilotModeSchema,
  autopilotWatchStatusSchema,
  desiredTerminalStateValueSchema,
  prWatchSnapshotSchema,
  prWatchStatusSchema,
  refWatchSnapshotSchema,
  refWatchStatusSchema,
  watchOutcomeSchema,
} from './schemas';
import * as v from 'valibot';

const sqliteExternalValueSchema = v.unknown();
type SqliteExternalValue = v.InferInput<typeof sqliteExternalValueSchema>;
const nullableTextColumnSchema = v.nullable(v.string());
const refWatchRowSchema = v.object({
  id: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  github_owner: v.string(),
  github_name: v.string(),
  ref: v.string(),
  status: refWatchStatusSchema,
  title: nullableTextColumnSchema,
  url: nullableTextColumnSchema,
  last_snapshot_json: nullableTextColumnSchema,
  last_outcome: v.nullable(watchOutcomeSchema),
  last_checked_at: nullableTextColumnSchema,
  created_at: v.string(),
  updated_at: v.string(),
});
const prWatchRowSchema = v.object({
  id: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  github_owner: v.string(),
  github_name: v.string(),
  pr_number: v.number(),
  desired_terminal_state: desiredTerminalStateValueSchema,
  status: prWatchStatusSchema,
  pr_state: nullableTextColumnSchema,
  title: nullableTextColumnSchema,
  url: nullableTextColumnSchema,
  merge_commit_sha: nullableTextColumnSchema,
  last_snapshot_json: nullableTextColumnSchema,
  last_outcome: v.nullable(watchOutcomeSchema),
  last_checked_at: nullableTextColumnSchema,
  created_by: nullableTextColumnSchema,
  process_existing: v.number(),
  initial_event_processed_at: nullableTextColumnSchema,
  event_watermark_version: v.number(),
  autopilot_mode: autopilotModeSchema,
  autopilot_status: autopilotWatchStatusSchema,
  owner_instance_id: nullableTextColumnSchema,
  worktree_id: nullableTextColumnSchema,
  last_event_fingerprint: nullableTextColumnSchema,
  created_at: v.string(),
  updated_at: v.string(),
});
const matchedWatchRowSchema = v.object({ autopilot_status: v.string() });
const pollingTaskRowSchema = v.object({
  enabled: v.number(),
  trigger_json: v.string(),
  next_run_at: nullableTextColumnSchema,
  claim_id: nullableTextColumnSchema,
  claim_expires_at: nullableTextColumnSchema,
  last_run_at: nullableTextColumnSchema,
  created_at: v.string(),
});
const pollingEnabledRowSchema = v.object({ enabled: v.number() });
const intervalTriggerSchema = v.object({
  kind: v.literal('interval'),
  everySeconds: v.number(),
});
const watchStateRowSchema = v.object({
  updated_at: v.string(),
  process_existing: v.number(),
  initial_event_processed_at: nullableTextColumnSchema,
  event_watermark_version: v.number(),
});
type WatchStateRow = v.InferOutput<typeof watchStateRowSchema>;

export function insertWatch(
  paths: RuntimePaths,
  watch: PrWatch,
  initialWatermarks?: PrWatchInitialWatermark[],
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    try {
      database
        .prepare(
          `
        INSERT INTO pr_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          pr_number,
          desired_terminal_state,
          status,
          pr_state,
          title,
          url,
          merge_commit_sha,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_by,
          process_existing,
          initial_event_processed_at,
          event_watermark_version,
          autopilot_mode,
          autopilot_status,
          owner_instance_id,
          worktree_id,
          last_event_fingerprint,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
        )
        .run(...watchParams(watch));
      if (initialWatermarks) {
        upsertInitialEventWatermarks(
          database,
          watch.id,
          initialWatermarks,
          watch.initialEventProcessedAt ?? watch.updatedAt,
        );
      }
      database.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function updateWatch(
  paths: RuntimePaths,
  watch: PrWatch,
  expectedWatchState: PrWatchStateFence,
  initialWatermarks?: PrWatchInitialWatermark[],
  resetEventWatermarks = false,
  pollingRepairMarker = false,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec(
      initialWatermarks || resetEventWatermarks ? 'BEGIN IMMEDIATE;' : 'BEGIN;',
    );
    try {
      const updated = database
        .prepare(
          `
        UPDATE pr_watches
        SET
          repo_id = ?,
          repo_full_name = ?,
          github_owner = ?,
          github_name = ?,
          pr_number = ?,
          desired_terminal_state = ?,
          status = ?,
          pr_state = ?,
          title = ?,
          url = ?,
          merge_commit_sha = ?,
          last_snapshot_json = ?,
          last_outcome = ?,
          last_checked_at = ?,
          process_existing = ?,
          initial_event_processed_at = ?,
          event_watermark_version = ?,
          autopilot_mode = ?,
          autopilot_status = ?,
          owner_instance_id = ?,
          worktree_id = ?,
          last_event_fingerprint = ?,
          updated_at = ?
        WHERE id = ?
          AND updated_at = ?
          AND process_existing = ?
          AND initial_event_processed_at IS ?
          AND event_watermark_version = ?
          AND autopilot_mode = ?
          AND autopilot_status = ?;
      `,
        )
        .run(
          watch.repoId,
          watch.repoFullName,
          watch.githubOwner,
          watch.githubName,
          watch.prNumber,
          watch.desiredTerminalState,
          watch.status,
          watch.prState,
          watch.title,
          watch.url,
          watch.mergeCommitSha,
          watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
          watch.lastOutcome,
          watch.lastCheckedAt,
          watch.processExisting ? 1 : 0,
          watch.initialEventProcessedAt,
          watch.eventWatermarkVersion,
          watch.autopilotMode,
          watch.autopilotStatus,
          watch.ownerInstanceId,
          watch.worktreeId,
          watch.lastEventFingerprint,
          watch.updatedAt,
          watch.id,
          expectedWatchState.updatedAt,
          expectedWatchState.processExisting ? 1 : 0,
          expectedWatchState.initialEventProcessedAt,
          expectedWatchState.eventWatermarkVersion,
          expectedWatchState.autopilotMode,
          expectedWatchState.autopilotStatus,
        ).changes;
      if (updated !== 1) {
        rollbackQuietly(database);
        return false;
      }
      if (initialWatermarks || resetEventWatermarks) {
        database
          .prepare('DELETE FROM pr_watch_event_watermarks WHERE watch_id = ?;')
          .run(watch.id);
      }
      if (initialWatermarks) {
        upsertInitialEventWatermarks(
          database,
          watch.id,
          initialWatermarks,
          watch.initialEventProcessedAt ?? watch.updatedAt,
        );
      }
      if (pollingRepairMarker) {
        const now = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO app_metadata (key, value, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at;`,
          )
          .run(watchPollingRepairKey(watch.id), watch.updatedAt, now);
      }
      database.exec('COMMIT;');
      return true;
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

function upsertInitialEventWatermarks(
  database: ReturnType<typeof openDb>,
  watchId: string,
  watermarks: PrWatchInitialWatermark[],
  now: string,
) {
  for (const watermark of watermarks) {
    database
      .prepare(
        `
        INSERT INTO pr_watch_event_watermarks (
          watch_id,
          category,
          watermark_json,
          source_updated_at,
          checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(watch_id, category) DO UPDATE SET
          watermark_json = excluded.watermark_json,
          source_updated_at = excluded.source_updated_at,
          checked_at = excluded.checked_at,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        watchId,
        watermark.category,
        JSON.stringify(watermark.value),
        watermark.sourceUpdatedAt,
        now,
        now,
        now,
      );
  }
}

export function insertRefWatch(paths: RuntimePaths, watch: RefWatch) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO ref_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          ref,
          status,
          title,
          url,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(...refWatchParams(watch));
  } finally {
    database.close();
  }
}

export function updateRefWatch(paths: RuntimePaths, watch: RefWatch) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE ref_watches
        SET
          repo_id = ?,
          repo_full_name = ?,
          github_owner = ?,
          github_name = ?,
          ref = ?,
          status = ?,
          title = ?,
          url = ?,
          last_snapshot_json = ?,
          last_outcome = ?,
          last_checked_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        watch.repoId,
        watch.repoFullName,
        watch.githubOwner,
        watch.githubName,
        watch.ref,
        watch.status,
        watch.title,
        watch.url,
        watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
        watch.lastOutcome,
        watch.lastCheckedAt,
        watch.updatedAt,
        watch.id,
      );
  } finally {
    database.close();
  }
}

export async function upsertWatchPollingTask(
  watch: PrWatch,
  paths: RuntimePaths,
  intervalSeconds = 300,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const matchedWatch = v.parse(
      v.optional(matchedWatchRowSchema),
      database
        .prepare(
          `SELECT autopilot_status
         FROM pr_watches
         WHERE id = ?
           AND updated_at = ?
           AND process_existing = ?
           AND initial_event_processed_at IS ?
           AND event_watermark_version = ?
           AND autopilot_mode = ?
           AND autopilot_status = ?;`,
        )
        .get(
          watch.id,
          watch.updatedAt,
          watch.processExisting ? 1 : 0,
          watch.initialEventProcessedAt,
          watch.eventWatermarkVersion,
          watch.autopilotMode,
          watch.autopilotStatus,
        ),
    );
    if (
      !matchedWatch ||
      matchedWatch.autopilot_status === 'stopping' ||
      matchedWatch.autopilot_status === 'complete'
    ) {
      rollbackQuietly(database);
      return { matched: false, enabled: false };
    }

    const taskId = watchPollingTaskId(watch.id);
    const current = v.parse(
      v.optional(pollingTaskRowSchema),
      database
        .prepare(
          `SELECT enabled, trigger_json, next_run_at, claim_id,
                claim_expires_at, last_run_at, created_at
         FROM scheduled_tasks
         WHERE id = ?;`,
        )
        .get(taskId),
    );
    const repairPending = Boolean(
      database
        .prepare('SELECT 1 FROM app_metadata WHERE key = ?;')
        .get(watchPollingRepairKey(watch.id)),
    );
    const now = new Date();
    const nowIso = now.toISOString();
    const trigger = { kind: 'interval', everySeconds: intervalSeconds };
    let sameTrigger = false;
    if (current) {
      try {
        const parsed = v.safeParse(
          intervalTriggerSchema,
          JSON.parse(current.trigger_json),
        );
        sameTrigger =
          parsed.success && parsed.output.everySeconds === trigger.everySeconds;
      } catch {
        sameTrigger = false;
      }
    }
    const enabled = current ? repairPending || current.enabled === 1 : true;
    const shouldAdvanceNextRun =
      !current ||
      !sameTrigger ||
      (enabled &&
        current.enabled !== 1 &&
        (!current.next_run_at ||
          Date.parse(current.next_run_at) <= now.getTime()));
    const nextRunAt = shouldAdvanceNextRun
      ? new Date(now.getTime() + intervalSeconds * 1_000).toISOString()
      : current.next_run_at;
    database
      .prepare(
        `INSERT INTO scheduled_tasks (
           id, kind, trigger_json, payload_json, enabled, next_run_at,
           claim_id, claim_expires_at, last_run_at, created_at, updated_at
         )
         VALUES (?, 'poll-pr-watch', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           trigger_json = excluded.trigger_json,
           payload_json = excluded.payload_json,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at;`,
      )
      .run(
        taskId,
        JSON.stringify(trigger),
        JSON.stringify({ kind: 'poll-pr-watch', watchId: watch.id }),
        enabled ? 1 : 0,
        nextRunAt,
        current?.claim_id ?? null,
        current?.claim_expires_at ?? null,
        current?.last_run_at ?? null,
        current?.created_at ?? nowIso,
        nowIso,
      );
    database
      .prepare('DELETE FROM app_metadata WHERE key = ?;')
      .run(watchPollingRepairKey(watch.id));
    database.exec('COMMIT;');
    return { matched: true, enabled };
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export function watchPollingTaskId(id: string) {
  return `watch:${id}`;
}

export function watchPollingRepairKey(id: string) {
  return `watch-polling-repair:${id}`;
}

export function watchPollingRepairNeeded(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare('SELECT 1 FROM app_metadata WHERE key = ?;')
        .get(watchPollingRepairKey(id)),
    );
  } finally {
    database.close();
  }
}

export function clearWatchPollingRepair(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM app_metadata WHERE key = ?;')
      .run(watchPollingRepairKey(id));
  } finally {
    database.close();
  }
}

export function beginWatchAutopilotCompletion(
  paths: RuntimePaths,
  id: string,
  expected: PrWatchStateFence,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const row = database
      .prepare('SELECT * FROM pr_watches WHERE id = ?;')
      .get(id);
    if (!row) {
      rollbackQuietly(database);
      return undefined;
    }
    const current = readWatchRow(row);
    const alreadyStopping = current.autopilotStatus === 'stopping';
    if (
      (!alreadyStopping &&
        (current.updatedAt !== expected.updatedAt ||
          current.processExisting !== expected.processExisting ||
          current.initialEventProcessedAt !==
            expected.initialEventProcessedAt ||
          current.eventWatermarkVersion !== expected.eventWatermarkVersion ||
          current.autopilotMode !== expected.autopilotMode ||
          current.autopilotStatus !== expected.autopilotStatus)) ||
      !['watching', 'waiting', 'blocked', 'complete', 'stopping'].includes(
        current.autopilotStatus,
      )
    ) {
      rollbackQuietly(database);
      return undefined;
    }

    const now = new Date().toISOString();
    database
      .prepare(
        `UPDATE scheduled_tasks
         SET enabled = 0, updated_at = ?
         WHERE id = ?;`,
      )
      .run(now, watchPollingTaskId(id));
    const pollingTask = v.parse(
      v.optional(pollingEnabledRowSchema),
      database
        .prepare('SELECT enabled FROM scheduled_tasks WHERE id = ?;')
        .get(watchPollingTaskId(id)),
    );
    if (pollingTask?.enabled === 1) {
      throw new Error('The persisted polling task remained enabled.');
    }

    if (!alreadyStopping) {
      const changed = database
        .prepare(
          `UPDATE pr_watches
           SET autopilot_status = 'stopping', updated_at = ?
           WHERE id = ?
             AND updated_at = ?
             AND autopilot_mode = ?
             AND autopilot_status = ?;`,
        )
        .run(
          now,
          id,
          current.updatedAt,
          current.autopilotMode,
          current.autopilotStatus,
        ).changes;
      if (changed !== 1) {
        rollbackQuietly(database);
        return undefined;
      }
    }
    database.exec('COMMIT;');
    return readWatch(paths, id);
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export function readWatches(paths: RuntimePaths): PrWatch[] {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM pr_watches
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .flatMap(safeWatchRow);
  } finally {
    database.close();
  }
}

export function readWatch(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM pr_watches
        WHERE id = ?;
      `,
      )
      .get(id);

    return row ? readWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function readWatchByOwnerInstanceId(
  paths: RuntimePaths,
  ownerInstanceId: string,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT * FROM pr_watches WHERE owner_instance_id = ? LIMIT 1;`)
      .get(ownerInstanceId);
    return row ? readWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function configureWatchAutopilot(
  paths: RuntimePaths,
  id: string,
  mode: PrWatch['autopilotMode'],
  options: {
    expected?: Pick<PrWatch, 'autopilotMode' | 'autopilotStatus' | 'updatedAt'>;
  } = {},
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const now = new Date().toISOString();
    const expected = options.expected;
    const statement = expected
      ? database.prepare(
          `UPDATE pr_watches
           SET autopilot_mode = ?,
               autopilot_status = CASE
                 WHEN autopilot_status = 'complete' THEN 'watching'
                 ELSE autopilot_status
               END,
               updated_at = CASE
                 WHEN autopilot_mode <> ? OR autopilot_status = 'complete' THEN ?
                 ELSE updated_at
               END
           WHERE id = ?
             AND updated_at = ?
             AND autopilot_mode = ?
             AND autopilot_status = ?;`,
        )
      : database.prepare(
          `UPDATE pr_watches
           SET autopilot_mode = ?,
               autopilot_status = CASE
                 WHEN autopilot_status = 'complete' THEN 'watching'
                 ELSE autopilot_status
               END,
               updated_at = ?
           WHERE id = ? AND autopilot_mode <> ?;`,
        );
    const matched = expected
      ? statement.run(
          mode,
          mode,
          now,
          id,
          expected.updatedAt,
          expected.autopilotMode,
          expected.autopilotStatus,
        ).changes === 1
      : statement.run(mode, now, id, mode).changes === 1;
    return {
      matched: expected ? matched : true,
      changed:
        matched &&
        (expected
          ? expected.autopilotMode !== mode ||
            expected.autopilotStatus === 'complete'
          : true),
      watch: readWatch(paths, id),
    };
  } finally {
    database.close();
  }
}

export function bindWatchAutopilotOwner(
  paths: RuntimePaths,
  id: string,
  input: { ownerInstanceId: string; worktreeId: string },
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const row = database
        .prepare('SELECT * FROM pr_watches WHERE id = ?;')
        .get(id);
      if (!row) {
        rollbackQuietly(database);
        return undefined;
      }
      const watch = readWatchRow(row);
      if (
        (watch.ownerInstanceId &&
          watch.ownerInstanceId !== input.ownerInstanceId) ||
        (watch.worktreeId && watch.worktreeId !== input.worktreeId)
      ) {
        rollbackQuietly(database);
        throw new Error(
          `Autopilot watch "${id}" is already bound to a different owner or worktree.`,
        );
      }
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE pr_watches
           SET owner_instance_id = COALESCE(owner_instance_id, ?),
               worktree_id = COALESCE(worktree_id, ?),
               updated_at = ?
           WHERE id = ?;`,
        )
        .run(input.ownerInstanceId, input.worktreeId, now, id);
      const updated = database
        .prepare('SELECT * FROM pr_watches WHERE id = ?;')
        .get(id);
      database.exec('COMMIT;');
      return updated ? readWatchRow(updated) : undefined;
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function claimWatchAutopilotTurn(
  paths: RuntimePaths,
  id: string,
  eventFingerprint: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const now = new Date().toISOString();
    const changed = database
      .prepare(
        `UPDATE pr_watches
         SET autopilot_status = 'working', updated_at = ?
         WHERE id = ?
           AND autopilot_status = 'watching'
           AND (last_event_fingerprint IS NULL OR last_event_fingerprint <> ?);`,
      )
      .run(now, id, eventFingerprint).changes;
    return changed === 1 ? readWatch(paths, id) : undefined;
  } finally {
    database.close();
  }
}

export function transitionWatchAutopilot(
  paths: RuntimePaths,
  id: string,
  input: {
    from: PrWatch['autopilotStatus'] | PrWatch['autopilotStatus'][];
    to: PrWatch['autopilotStatus'];
    eventFingerprint?: string;
    /**
     * Facts captured when the owner was admitted. These are deliberately not
     * refetched here: a later GitHub snapshot can contain human feedback that
     * arrived while an approval was pending.
     */
    eventWatermarks?: PrWatchInitialWatermark[];
    /** Mark an admitted first-poll event handled with its captured facts. */
    markInitialEventProcessed?: boolean;
  },
) {
  const from = Array.isArray(input.from) ? input.from : [input.from];
  if (from.length === 0) return undefined;
  const database = openDb(paths.neondeckDatabase);
  try {
    const placeholders = from.map(() => '?').join(', ');
    const now = new Date().toISOString();
    database.exec(input.eventWatermarks ? 'BEGIN IMMEDIATE;' : 'BEGIN;');
    try {
      const changed = database
        .prepare(
          `UPDATE pr_watches
           SET autopilot_status = ?,
               last_event_fingerprint = COALESCE(?, last_event_fingerprint),
               updated_at = ?
           WHERE id = ? AND autopilot_status IN (${placeholders});`,
        )
        .run(
          input.to,
          input.eventFingerprint ?? null,
          now,
          id,
          ...from,
        ).changes;
      if (changed !== 1) {
        rollbackQuietly(database);
        return undefined;
      }
      if (input.eventWatermarks) {
        upsertInitialEventWatermarks(database, id, input.eventWatermarks, now);
      }
      if (input.markInitialEventProcessed) {
        database
          .prepare(
            `UPDATE pr_watches
             SET initial_event_processed_at = ?, updated_at = ?
             WHERE id = ? AND initial_event_processed_at IS NULL;`,
          )
          .run(now, now, id);
      }
      database.exec('COMMIT;');
      return readWatch(paths, id);
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function recoverInterruptedAutopilotWatches(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const now = new Date().toISOString();
    return database
      .prepare(
        `UPDATE pr_watches
         SET autopilot_status = 'blocked', updated_at = ?
         WHERE autopilot_status = 'working';`,
      )
      .run(now).changes;
  } finally {
    database.close();
  }
}

export function readRefWatches(paths: RuntimePaths): RefWatch[] {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM ref_watches
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .flatMap(safeRefWatchRow);
  } finally {
    database.close();
  }
}

export function readRefWatch(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM ref_watches
        WHERE id = ?;
      `,
      )
      .get(id);

    return row ? readRefWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function deleteWatch(
  paths: RuntimePaths,
  id: string,
  expected: PrWatchRemovalFence,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const deleted = database
        .prepare(
          `DELETE FROM pr_watches
           WHERE id = ?
             AND updated_at = ?
             AND autopilot_mode = ?
             AND autopilot_status = ?
             AND owner_instance_id IS ?
             AND worktree_id IS ?
             AND last_event_fingerprint IS ?;`,
        )
        .run(
          id,
          expected.updatedAt,
          expected.autopilotMode,
          expected.autopilotStatus,
          expected.ownerInstanceId,
          expected.worktreeId,
          expected.lastEventFingerprint,
        ).changes;
      if (deleted !== 1) {
        rollbackQuietly(database);
        return false;
      }
      const pollingTaskId = watchPollingTaskId(id);
      database
        .prepare('DELETE FROM scheduled_task_runs WHERE task_id = ?;')
        .run(pollingTaskId);
      database
        .prepare('DELETE FROM scheduled_tasks WHERE id = ?;')
        .run(pollingTaskId);
      database
        .prepare('DELETE FROM pr_watch_event_watermarks WHERE watch_id = ?;')
        .run(id);
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(watchPollingRepairKey(id));
      database.exec('COMMIT;');
      return true;
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function refWatchParams(watch: RefWatch) {
  return [
    watch.id,
    watch.repoId,
    watch.repoFullName,
    watch.githubOwner,
    watch.githubName,
    watch.ref,
    watch.status,
    watch.title,
    watch.url,
    watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
    watch.lastOutcome,
    watch.lastCheckedAt,
    watch.createdAt,
    watch.updatedAt,
  ];
}

export function watchParams(watch: PrWatch) {
  return [
    watch.id,
    watch.repoId,
    watch.repoFullName,
    watch.githubOwner,
    watch.githubName,
    watch.prNumber,
    watch.desiredTerminalState,
    watch.status,
    watch.prState,
    watch.title,
    watch.url,
    watch.mergeCommitSha,
    watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
    watch.lastOutcome,
    watch.lastCheckedAt,
    watch.createdBy,
    watch.processExisting ? 1 : 0,
    watch.initialEventProcessedAt,
    watch.eventWatermarkVersion,
    watch.autopilotMode,
    watch.autopilotStatus,
    watch.ownerInstanceId,
    watch.worktreeId,
    watch.lastEventFingerprint,
    watch.createdAt,
    watch.updatedAt,
  ];
}

export function readRefWatchRow(row: SqliteExternalValue): RefWatch {
  const record = v.parse(refWatchRowSchema, row);
  const snapshot =
    record.last_snapshot_json !== null
      ? v.parse(refWatchSnapshotSchema, JSON.parse(record.last_snapshot_json))
      : null;

  return {
    id: record.id,
    repoId: record.repo_id,
    repoFullName: record.repo_full_name,
    githubOwner: record.github_owner,
    githubName: record.github_name,
    ref: record.ref,
    status: record.status,
    title: record.title,
    url: record.url,
    lastSnapshot: snapshot,
    lastOutcome: record.last_outcome,
    lastCheckedAt: record.last_checked_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function readWatchRow(row: SqliteExternalValue): PrWatch {
  const record = v.parse(prWatchRowSchema, row);
  const snapshot =
    record.last_snapshot_json !== null
      ? v.parse(prWatchSnapshotSchema, JSON.parse(record.last_snapshot_json))
      : null;

  return {
    id: record.id,
    repoId: record.repo_id,
    repoFullName: record.repo_full_name,
    githubOwner: record.github_owner,
    githubName: record.github_name,
    prNumber: record.pr_number,
    desiredTerminalState: record.desired_terminal_state,
    status: record.status,
    prState: record.pr_state,
    title: record.title,
    url: record.url,
    mergeCommitSha: record.merge_commit_sha,
    lastSnapshot: snapshot,
    lastOutcome: record.last_outcome,
    lastCheckedAt: record.last_checked_at,
    createdBy: record.created_by,
    processExisting: record.process_existing === 1,
    initialEventProcessedAt: record.initial_event_processed_at,
    eventWatermarkVersion: record.event_watermark_version,
    autopilotMode: record.autopilot_mode,
    autopilotStatus: record.autopilot_status,
    ownerInstanceId: record.owner_instance_id,
    worktreeId: record.worktree_id,
    lastEventFingerprint: record.last_event_fingerprint,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function safeWatchRow(row: SqliteExternalValue) {
  try {
    return [readWatchRow(row)];
  } catch {
    return [];
  }
}

function safeRefWatchRow(row: SqliteExternalValue) {
  try {
    return [readRefWatchRow(row)];
  } catch {
    return [];
  }
}

export function markWatchInitialEventProcessed(
  paths: RuntimePaths,
  watchId: string,
  processedAt = new Date().toISOString(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return (
      database
        .prepare(
          `UPDATE pr_watches
           SET initial_event_processed_at = ?, updated_at = ?
           WHERE id = ? AND initial_event_processed_at IS NULL;`,
        )
        .run(processedAt, processedAt, watchId).changes === 1
    );
  } finally {
    database.close();
  }
}

export function persistWatchEventRefresh(
  paths: RuntimePaths,
  watchId: string,
  watermarks: PrWatchInitialWatermark[],
  options: {
    expectedWatchState: PrWatchStateFence;
    notification?: NonNullable<
      AutomationExecutionResult['notifications']
    >[number];
    handledEventFingerprint?: string;
    markInitialProcessed?: boolean;
  },
  processedAt = new Date().toISOString(),
) {
  const database = openDb(paths.neondeckDatabase);
  let persistedNotification: NotificationRecord | null = null;
  let notificationAction: 'created' | 'reconciled' | null = null;
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const watch = v.parse(
        v.optional(watchStateRowSchema),
        database
          .prepare(
            `SELECT
             updated_at,
             process_existing,
             initial_event_processed_at,
             event_watermark_version
           FROM pr_watches
           WHERE id = ?;`,
          )
          .get(watchId),
      );
      if (!watch) {
        rollbackQuietly(database);
        return {
          persisted: false as const,
          reason: 'missing' as const,
          notification: null,
        };
      }
      if (!watchStateMatchesFence(watch, options.expectedWatchState)) {
        rollbackQuietly(database);
        return {
          persisted: false as const,
          reason: 'stale' as const,
          notification: null,
        };
      }

      for (const watermark of watermarks) {
        database
          .prepare(
            `INSERT INTO pr_watch_event_watermarks (
               watch_id, category, watermark_json, source_updated_at,
               checked_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(watch_id, category) DO UPDATE SET
               watermark_json = excluded.watermark_json,
               source_updated_at = excluded.source_updated_at,
               checked_at = excluded.checked_at,
               updated_at = excluded.updated_at;`,
          )
          .run(
            watchId,
            watermark.category,
            JSON.stringify(watermark.value),
            watermark.sourceUpdatedAt,
            processedAt,
            processedAt,
            processedAt,
          );
      }

      const notification = options.notification;
      if (notification) {
        const source = notification.source ?? 'watch-pr-events';
        const sourceId = notification.sourceId ?? watchId;
        const data =
          notification.data === undefined
            ? null
            : asJsonValue(notification.data);
        const existing = database
          .prepare(
            `SELECT * FROM notifications
             WHERE source = ? AND source_id = ? AND resolved_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1;`,
          )
          .get(source, sourceId);
        if (existing) {
          const previous = readNotificationRow(existing);
          database
            .prepare(
              `UPDATE notifications
               SET level = ?, title = ?, message = ?, data_json = ?,
                   read_at = NULL,
                   occurrence_count = occurrence_count + 1,
                   updated_at = ?
               WHERE id = ?;`,
            )
            .run(
              notification.level,
              notification.title,
              notification.message,
              data === null ? null : JSON.stringify(data),
              processedAt,
              previous.id,
            );
          persistedNotification = {
            ...previous,
            level: notification.level,
            title: notification.title,
            message: notification.message,
            data,
            readAt: null,
            occurrenceCount: previous.occurrenceCount + 1,
            updatedAt: processedAt,
          };
          notificationAction = 'reconciled';
        } else {
          const id = randomUUID();
          database
            .prepare(
              `INSERT INTO notifications (
                 id, level, title, message, source, source_id, data_json,
                 read_at, resolved_at, occurrence_count, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?);`,
            )
            .run(
              id,
              notification.level,
              notification.title,
              notification.message,
              source,
              sourceId,
              data === null ? null : JSON.stringify(data),
              processedAt,
              processedAt,
            );
          persistedNotification = {
            id,
            level: notification.level,
            title: notification.title,
            message: notification.message,
            source,
            sourceId,
            data,
            readAt: null,
            resolvedAt: null,
            occurrenceCount: 1,
            createdAt: processedAt,
            updatedAt: processedAt,
          };
          notificationAction = 'created';
        }
      }
      if (options.markInitialProcessed) {
        database
          .prepare(
            `UPDATE pr_watches
             SET initial_event_processed_at = ?, updated_at = ?
             WHERE id = ? AND initial_event_processed_at IS NULL;`,
          )
          .run(processedAt, processedAt, watchId);
      }
      if (options.handledEventFingerprint) {
        database
          .prepare(
            `UPDATE pr_watches
             SET last_event_fingerprint = ?, updated_at = ?
             WHERE id = ?;`,
          )
          .run(options.handledEventFingerprint, processedAt, watchId);
      }
      database.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
  if (persistedNotification && notificationAction) {
    publishNotificationEvent({
      id: persistedNotification.id,
      action: notificationAction,
      notification: persistedNotification,
      changedAt: processedAt,
    });
  }
  return {
    persisted: true as const,
    notification: persistedNotification,
  };
}

function watchStateMatchesFence(
  row: WatchStateRow,
  expected: PrWatchStateFence,
) {
  return (
    row.updated_at === expected.updatedAt &&
    row.process_existing === (expected.processExisting ? 1 : 0) &&
    row.initial_event_processed_at === expected.initialEventProcessedAt &&
    row.event_watermark_version === expected.eventWatermarkVersion
  );
}
