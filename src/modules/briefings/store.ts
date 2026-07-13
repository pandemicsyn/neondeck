import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import type {
  BriefingProfile,
  BriefingRun,
  BriefingRunMetadata,
  BriefingSnapshot,
} from './schemas';
import {
  defaultBriefingInstructions,
  defaultBriefingProfileId,
  defaultBriefingSchedule,
  briefingSnapshotSchema,
} from './schemas';
import { readScheduledTask } from '../scheduled-tasks';
import {
  nextOccurrence,
  validateAutomationTrigger,
} from '../scheduled-tasks/triggers';

const nullableString = v.nullable(v.string());
const persistedProfileSchema = v.object({
  id: v.string(),
  name: v.string(),
  enabled: v.number(),
  instructions: v.string(),
  instructions_version: v.number(),
  schedule: v.string(),
  timezone: v.string(),
  session_id: nullableString,
  created_at: v.string(),
  updated_at: v.string(),
});
const persistedRunSchema = v.object({
  id: v.string(),
  profile_id: nullableString,
  trigger: v.picklist(['manual', 'scheduled', 'dashboard']),
  snapshot_json: v.string(),
  instructions: v.string(),
  instructions_version: v.number(),
  session_id: v.string(),
  command_event_id: nullableString,
  dispatch_id: nullableString,
  workflow_run_id: nullableString,
  status: v.picklist(['queued', 'ready', 'failed']),
  error: nullableString,
  queued_at: v.string(),
  completed_at: nullableString,
  created_at: v.string(),
  updated_at: v.string(),
});
const persistedRunMetadataSchema = v.omit(persistedRunSchema, [
  'snapshot_json',
  'instructions',
]);
const persistedBriefingTaskSchema = v.object({
  kind: v.string(),
  trigger_json: v.string(),
  next_run_at: nullableString,
  claim_id: nullableString,
  claim_expires_at: nullableString,
  last_run_at: nullableString,
  created_at: v.string(),
});

export async function readBriefingProfile(
  id = defaultBriefingProfileId,
  paths: RuntimePaths = runtimePaths(),
): Promise<BriefingProfile> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM briefing_profiles WHERE id = ?;')
      .get(id);
    if (row) return readProfileRow(row, false);
  } finally {
    database.close();
  }

  const compatibleTask = await readScheduledTask(`briefing:${id}`, paths);
  const timezone =
    compatibleTask?.trigger.kind === 'cron'
      ? compatibleTask.trigger.timezone
      : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  if (!compatibleTask) {
    const initialized = await writeBriefingProfileAndTask(
      {
        id,
        name: id === defaultBriefingProfileId ? 'Morning Briefing' : id,
        enabled: true,
        instructions: defaultBriefingInstructions,
        instructionsVersion: 1,
        schedule: defaultBriefingSchedule,
        timezone,
        sessionId: null,
      },
      paths,
    );
    return initialized.profile;
  }
  const cron =
    compatibleTask?.trigger.kind === 'cron'
      ? compatibleTask.trigger
      : undefined;
  return {
    id,
    name: id === defaultBriefingProfileId ? 'Morning Briefing' : id,
    enabled: compatibleTask.enabled,
    instructions: defaultBriefingInstructions,
    instructionsVersion: 1,
    schedule: cron?.expression ?? defaultBriefingSchedule,
    timezone,
    sessionId: null,
    compatibility: true,
    createdAt: null,
    updatedAt: compatibleTask?.updatedAt ?? null,
  };
}

export async function writeBriefingProfile(
  profile: Omit<BriefingProfile, 'compatibility' | 'createdAt' | 'updatedAt'>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN;');
    const before = database
      .prepare('SELECT * FROM briefing_profiles WHERE id = ?;')
      .get(profile.id);
    database
      .prepare(
        `INSERT INTO briefing_profiles (
          id, name, enabled, instructions, instructions_version, schedule,
          timezone, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          instructions = excluded.instructions,
          instructions_version = excluded.instructions_version,
          schedule = excluded.schedule,
          timezone = excluded.timezone,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at;`,
      )
      .run(
        profile.id,
        profile.name,
        profile.enabled ? 1 : 0,
        profile.instructions,
        profile.instructionsVersion,
        profile.schedule,
        profile.timezone,
        profile.sessionId,
        now,
        now,
      );
    const after = database
      .prepare('SELECT * FROM briefing_profiles WHERE id = ?;')
      .get(profile.id);
    database
      .prepare(
        `INSERT INTO config_history (
          action, file, target, before_json, after_json, changed_at
        ) VALUES ('briefing_profile_update', 'briefing_profiles', ?, ?, ?, ?);`,
      )
      .run(
        profile.id,
        before ? JSON.stringify(readProfileRow(before, false)) : null,
        JSON.stringify(readProfileRow(after, false)),
        now,
      );
    database.exec('COMMIT;');
    return readProfileRow(after, false);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function writeBriefingProfileAndTask(
  profile: Omit<BriefingProfile, 'compatibility' | 'createdAt' | 'updatedAt'>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const triggerResult = validateAutomationTrigger({
    kind: 'cron',
    expression: profile.schedule,
    timezone: profile.timezone,
  });
  if (!triggerResult.ok) throw new Error(triggerResult.message);
  const trigger = triggerResult.trigger;
  const taskId = `briefing:${profile.id}`;
  const spec = { kind: 'run-briefing' as const, briefingId: profile.id };
  const database = openDb(paths.neondeckDatabase);
  const now = new Date();
  const nowIso = now.toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    const beforeProfile = database
      .prepare('SELECT * FROM briefing_profiles WHERE id = ?;')
      .get(profile.id);
    const beforeTaskRow = database
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?;')
      .get(taskId);
    const beforeTask = beforeTaskRow
      ? parsePersisted(
          persistedBriefingTaskSchema,
          beforeTaskRow,
          'briefing scheduled task',
        )
      : undefined;
    if (beforeTask && beforeTask.kind !== 'run-briefing') {
      throw new Error(
        `Scheduled task "${taskId}" cannot be replaced with a briefing task.`,
      );
    }
    const triggerJson = JSON.stringify(asJsonValue(trigger));
    const nextRunAt =
      beforeTask && beforeTask.trigger_json === triggerJson
        ? (beforeTask.next_run_at as string | null)
        : nextOccurrence(trigger, now);
    database
      .prepare(
        `INSERT INTO scheduled_tasks (
          id, kind, trigger_json, payload_json, enabled, next_run_at,
          claim_id, claim_expires_at, last_run_at, created_at, updated_at
        ) VALUES (?, 'run-briefing', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        triggerJson,
        JSON.stringify(asJsonValue(spec)),
        profile.enabled ? 1 : 0,
        nextRunAt,
        beforeTask?.claim_id ?? null,
        beforeTask?.claim_expires_at ?? null,
        beforeTask?.last_run_at ?? null,
        beforeTask?.created_at ?? nowIso,
        nowIso,
      );
    database
      .prepare(
        `INSERT INTO briefing_profiles (
          id, name, enabled, instructions, instructions_version, schedule,
          timezone, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          instructions = excluded.instructions,
          instructions_version = excluded.instructions_version,
          schedule = excluded.schedule,
          timezone = excluded.timezone,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at;`,
      )
      .run(
        profile.id,
        profile.name,
        profile.enabled ? 1 : 0,
        profile.instructions,
        profile.instructionsVersion,
        profile.schedule,
        profile.timezone,
        profile.sessionId,
        nowIso,
        nowIso,
      );
    const afterProfile = database
      .prepare('SELECT * FROM briefing_profiles WHERE id = ?;')
      .get(profile.id);
    database
      .prepare(
        `INSERT INTO config_history (
          action, file, target, before_json, after_json, changed_at
        ) VALUES ('briefing_profile_update', 'briefing_profiles', ?, ?, ?, ?);`,
      )
      .run(
        profile.id,
        beforeProfile
          ? JSON.stringify(readProfileRow(beforeProfile, false))
          : null,
        JSON.stringify(readProfileRow(afterProfile, false)),
        nowIso,
      );
    database.exec('COMMIT;');
    return {
      profile: readProfileRow(afterProfile, false),
      task: {
        id: taskId,
        spec,
        trigger,
        enabled: profile.enabled,
        nextRunAt,
        claimId: beforeTask?.claim_id ?? null,
        claimExpiresAt: beforeTask?.claim_expires_at ?? null,
        lastRunAt: beforeTask?.last_run_at ?? null,
        createdAt: beforeTask?.created_at ?? nowIso,
        updatedAt: nowIso,
      },
    };
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function setBriefingProfileSession(
  id: string,
  sessionId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        'UPDATE briefing_profiles SET session_id = ?, updated_at = ? WHERE id = ?;',
      )
      .run(sessionId, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export async function createBriefingRun(
  input: {
    profileId: string | null;
    trigger: BriefingRun['trigger'];
    snapshot: BriefingSnapshot;
    instructions: string;
    instructionsVersion: number;
    sessionId: string;
    commandEventId?: string | null;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const id = `briefing:${now.replace(/\D/g, '').slice(0, 14)}:${randomUUID().slice(0, 8)}`;
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO briefing_runs (
          id, profile_id, trigger, snapshot_json, instructions,
          instructions_version, session_id, command_event_id, dispatch_id,
          workflow_run_id, status, error, queued_at, completed_at, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', NULL, ?, NULL, ?, ?);`,
      )
      .run(
        id,
        input.profileId,
        input.trigger,
        JSON.stringify(input.snapshot),
        input.instructions,
        input.instructionsVersion,
        input.sessionId,
        input.commandEventId ?? null,
        now,
        now,
        now,
      );
    return readBriefingRun(id, paths);
  } finally {
    database.close();
  }
}

export async function attachBriefingDispatch(
  id: string,
  dispatchId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        'UPDATE briefing_runs SET dispatch_id = ?, updated_at = ? WHERE id = ?;',
      )
      .run(dispatchId, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export async function attachBriefingWorkflowRun(
  id: string,
  workflowRunId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        'UPDATE briefing_runs SET workflow_run_id = ?, updated_at = ? WHERE id = ?;',
      )
      .run(workflowRunId, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export async function settleBriefingRun(
  dispatchId: string,
  status: 'ready' | 'failed',
  error: string | null,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const update = database
      .prepare(
        `UPDATE briefing_runs
         SET status = ?, error = ?, completed_at = ?, updated_at = ?
         WHERE dispatch_id = ? AND status = 'queued';`,
      )
      .run(status, error, now, now, dispatchId);
    const row = database
      .prepare('SELECT * FROM briefing_runs WHERE dispatch_id = ?;')
      .get(dispatchId);
    return {
      changed: update.changes === 1,
      run: row ? readRunRow(row) : null,
    };
  } finally {
    database.close();
  }
}

export async function failBriefingRunBeforeDispatch(
  id: string,
  error: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `UPDATE briefing_runs SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?;`,
      )
      .run(error, now, now, id);
  } finally {
    database.close();
  }
}

export async function readBriefingRun(
  id: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM briefing_runs WHERE id = ?;')
      .get(id);
    return row ? readRunRow(row) : null;
  } finally {
    database.close();
  }
}

export async function readBriefingRunByDispatch(
  dispatchId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM briefing_runs WHERE dispatch_id = ?;')
      .get(dispatchId);
    return row ? readRunRow(row) : null;
  } finally {
    database.close();
  }
}

export async function listBriefingRuns(
  paths: RuntimePaths = runtimePaths(),
  limit = 20,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare('SELECT * FROM briefing_runs ORDER BY created_at DESC LIMIT ?;')
      .all(limit)
      .map(readRunRow);
  } finally {
    database.close();
  }
}

export async function listBriefingRunMetadata(
  paths: RuntimePaths = runtimePaths(),
  limit = 20,
): Promise<BriefingRunMetadata[]> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `SELECT
          id, profile_id, trigger, instructions_version, session_id,
          command_event_id, dispatch_id, workflow_run_id, status, error,
          queued_at, completed_at, created_at, updated_at,
          json_extract(snapshot_json, '$.version') AS snapshot_version,
          json_extract(snapshot_json, '$.collectedAt') AS snapshot_collected_at,
          json_extract(snapshot_json, '$.byteSize') AS snapshot_byte_size,
          json_extract(snapshot_json, '$.truncated') AS snapshot_truncated
        FROM briefing_runs
        ORDER BY created_at DESC
        LIMIT ?;`,
      )
      .all(limit)
      .map(readRunMetadataRow);
  } finally {
    database.close();
  }
}

function readProfileRow(row: unknown, compatibility: boolean): BriefingProfile {
  const value = parsePersisted(persistedProfileSchema, row, 'briefing profile');
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled === 1,
    instructions: value.instructions,
    instructionsVersion: value.instructions_version,
    schedule: value.schedule,
    timezone: value.timezone,
    sessionId: value.session_id,
    compatibility,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function readRunRow(row: unknown): BriefingRun {
  const value = parsePersisted(persistedRunSchema, row, 'briefing run');
  let snapshot: BriefingSnapshot;
  try {
    snapshot = v.parse(
      briefingSnapshotSchema,
      JSON.parse(value.snapshot_json),
    ) as BriefingSnapshot;
  } catch (error) {
    throw new Error(`Invalid persisted briefing snapshot for ${value.id}.`, {
      cause: error,
    });
  }
  return {
    id: value.id,
    profileId: value.profile_id,
    trigger: value.trigger,
    snapshot,
    instructions: value.instructions,
    instructionsVersion: value.instructions_version,
    sessionId: value.session_id,
    commandEventId: value.command_event_id,
    dispatchId: value.dispatch_id,
    workflowRunId: value.workflow_run_id,
    status: value.status,
    error: value.error,
    queuedAt: value.queued_at,
    completedAt: value.completed_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function readRunMetadataRow(row: unknown): BriefingRunMetadata {
  const value = parsePersisted(
    v.object({
      ...persistedRunMetadataSchema.entries,
      snapshot_version: v.literal(1),
      snapshot_collected_at: v.string(),
      snapshot_byte_size: v.number(),
      snapshot_truncated: v.number(),
    }),
    row,
    'briefing run metadata',
  );
  return {
    id: value.id,
    profileId: value.profile_id,
    trigger: value.trigger,
    instructionsVersion: value.instructions_version,
    sessionId: value.session_id,
    commandEventId: value.command_event_id,
    dispatchId: value.dispatch_id,
    workflowRunId: value.workflow_run_id,
    status: value.status,
    error: value.error,
    queuedAt: value.queued_at,
    completedAt: value.completed_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    snapshot: {
      version: 1,
      collectedAt: value.snapshot_collected_at,
      byteSize: value.snapshot_byte_size,
      truncated: value.snapshot_truncated === 1,
    },
  };
}

function parsePersisted<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: unknown, label: string): v.InferOutput<TSchema> {
  try {
    return v.parse(schema, value);
  } catch (error) {
    throw new Error(`Invalid persisted ${label}.`, { cause: error });
  }
}
