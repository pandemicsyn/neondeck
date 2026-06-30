import { defineAction } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';
import { suggestUtilitySessionTitle } from './utility-model';

export type NeonSessionRecord = {
  id: string;
  label: string;
  agentName: string;
  status: 'active' | 'archived';
  reason: string | null;
  createdAt: string;
  activatedAt: string;
  endedAt: string | null;
  updatedAt: string;
};

export type NeonSessionStaleReason = {
  type: 'config' | 'memory';
  message: string;
  changedAt: string;
  target: string | null;
};

export type NeonSessionState = {
  ok: boolean;
  action: 'session_status';
  activeSession: NeonSessionRecord;
  stale: boolean;
  staleReasons: NeonSessionStaleReason[];
  history: NeonSessionRecord[];
  fetchedAt: string;
};

const sessionStartInputSchema = v.object({
  label: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(160))),
});
const sessionActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  titleSuggestion: v.optional(
    v.object({
      title: v.string(),
      model: v.string(),
      thinkingLevel: v.string(),
      fallback: v.boolean(),
      invokedModel: v.boolean(),
    }),
  ),
});

export const sessionStatusAction = defineAction({
  name: 'neondeck_session_status',
  description:
    'Read the active Neon display-assistant session id and whether config or memory changes make its context stale.',
  input: v.object({}),
  output: sessionActionOutputSchema,
  async run() {
    const state = await readNeonSessionState();
    return {
      ok: true,
      action: 'session_status',
      changed: false,
      message: state.stale
        ? 'Active Neon session context is stale. Start a new session to reload config, skills, and memory context.'
        : 'Active Neon session context is current.',
      state,
    };
  },
});

export const sessionStartAction = defineAction({
  name: 'neondeck_session_start',
  description:
    'Start a new Neon display-assistant session id. This does not mutate old Flue history; it switches future dashboard chat to a fresh session.',
  input: sessionStartInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return startNeonSession(input);
  },
});

export const neondeckSessionActions = [sessionStatusAction, sessionStartAction];

export async function readNeonSessionState(
  paths: RuntimePaths = runtimePaths(),
): Promise<NeonSessionState> {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const active = readActiveSession(database);
    const staleReasons = readStaleReasons(database, active.activatedAt);
    const history = database
      .prepare(
        `
        SELECT *
        FROM neon_sessions
        WHERE agent_name = 'display-assistant'
        ORDER BY activated_at DESC
        LIMIT 10;
      `,
      )
      .all()
      .map(readSessionRow);

    return {
      ok: true,
      action: 'session_status',
      activeSession: active,
      stale: staleReasons.length > 0,
      staleReasons,
      history,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function startNeonSession(
  input: v.InferInput<typeof sessionStartInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionStartInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'session_start',
      changed: false,
      message: 'Invalid session start input.',
      errors: [v.summarize(parsed.issues)],
    };
  }

  const now = new Date().toISOString();
  const id = `neondeck-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const reason = parsed.output.reason ?? 'manual-new-session';
  const title = suggestUtilitySessionTitle(parsed.output, paths);
  const label = parsed.output.label ?? title.title;
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.exec('BEGIN;');
    database
      .prepare(
        `
        UPDATE neon_sessions
        SET status = 'archived', ended_at = ?, updated_at = ?
        WHERE agent_name = 'display-assistant'
          AND status = 'active';
      `,
      )
      .run(now, now);
    database
      .prepare(
        `
        INSERT INTO neon_sessions (
          id,
          label,
          agent_name,
          status,
          reason,
          created_at,
          activated_at,
          updated_at
        )
        VALUES (?, ?, 'display-assistant', 'active', ?, ?, ?, ?);
      `,
      )
      .run(id, label, reason, now, now, now);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  return {
    ok: true,
    action: 'session_start',
    changed: true,
    message: title.fallback
      ? `Started a new Neon session. New chat messages will load current SOUL, skills, model config, and memory context. Session title was compacted deterministically with display assistant fallback metadata because no utility model is configured.`
      : `Started a new Neon session. New chat messages will load current SOUL, skills, model config, and memory context. Session title was compacted deterministically with utility role metadata for ${title.model}.`,
    state: await readNeonSessionState(paths),
    titleSuggestion: title,
  };
}

function readActiveSession(database: DatabaseSync) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM neon_sessions
      WHERE agent_name = 'display-assistant'
        AND status = 'active'
      ORDER BY activated_at DESC
      LIMIT 1;
    `,
    )
    .get();

  if (!row) {
    throw new Error('No active Neon session is configured.');
  }

  return readSessionRow(row);
}

function readStaleReasons(
  database: DatabaseSync,
  activatedAt: string,
): NeonSessionStaleReason[] {
  const reasons: NeonSessionStaleReason[] = [];
  const config = database
    .prepare(
      `
      SELECT action, target, changed_at
      FROM config_history
      ORDER BY changed_at DESC
      LIMIT 1;
    `,
    )
    .get() as
    { action?: unknown; target?: unknown; changed_at?: unknown } | undefined;

  if (
    typeof config?.changed_at === 'string' &&
    Date.parse(config.changed_at) > Date.parse(activatedAt)
  ) {
    reasons.push({
      type: 'config',
      message: `${String(config.action ?? 'config')} changed after this session started.`,
      changedAt: config.changed_at,
      target: typeof config.target === 'string' ? config.target : null,
    });
  }

  const memory = database
    .prepare(
      `
      SELECT action, scope, key, changed_at
      FROM memory_events
      ORDER BY changed_at DESC
      LIMIT 1;
    `,
    )
    .get() as
    | {
        action?: unknown;
        scope?: unknown;
        key?: unknown;
        changed_at?: unknown;
      }
    | undefined;

  if (
    typeof memory?.changed_at === 'string' &&
    Date.parse(memory.changed_at) > Date.parse(activatedAt)
  ) {
    reasons.push({
      type: 'memory',
      message: `Memory ${String(memory.scope ?? 'unknown')}:${String(memory.key ?? 'unknown')} ${String(memory.action ?? 'changed')} after this session started.`,
      changedAt: memory.changed_at,
      target:
        typeof memory.scope === 'string' && typeof memory.key === 'string'
          ? `${memory.scope}:${memory.key}`
          : null,
    });
  }

  return reasons.sort(
    (a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt),
  );
}

function readSessionRow(row: unknown): NeonSessionRecord {
  const record = row as Record<string, unknown>;
  const status = record.status === 'archived' ? 'archived' : 'active';
  return {
    id: String(record.id),
    label: String(record.label),
    agentName: String(record.agent_name),
    status,
    reason: typeof record.reason === 'string' ? record.reason : null,
    createdAt: String(record.created_at),
    activatedAt: String(record.activated_at),
    endedAt: typeof record.ended_at === 'string' ? record.ended_at : null,
    updatedAt: String(record.updated_at),
  };
}

function compactTimestamp(value: string) {
  return value.replace(/\D/g, '').slice(0, 14);
}
