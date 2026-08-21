import { type JsonValue } from '@flue/runtime';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { type RuntimePaths, ensureRuntimeHome } from '../../runtime-home';
import {
  chatSessionKindSchema,
  persistedJsonValueSchema,
  persistedStaleReasonsSchema,
  summarySourceSchema,
  type ChatSessionCommandEvent,
  type ChatSessionKind,
  type ChatSessionRecord,
  type ChatSessionSummarySource,
  type ChatSessionSummaryStatus,
  type NeonSessionStaleReason,
  type SessionExternalValue,
} from './schemas';
import { readStaleReasonChanges } from './stale-reasons';

const nullableStringSchema = v.nullable(v.string());
const activeSessionRowSchema = v.object({ session_id: v.string() });
const chatSessionRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  agent_name: v.string(),
  kind: v.string(),
  pinned: v.number(),
  archived_at: nullableStringSchema,
  linked_repo_id: nullableStringSchema,
  linked_watch_id: nullableStringSchema,
  linked_task_id: nullableStringSchema,
  stale_reasons_json: nullableStringSchema,
  ui_metadata_json: nullableStringSchema,
  summary: nullableStringSchema,
  summary_generated_at: nullableStringSchema,
  summary_source: nullableStringSchema,
  summary_refresh_note: nullableStringSchema,
  context_loaded_at: nullableStringSchema,
  context_memory_ids_json: nullableStringSchema,
  created_at: v.string(),
  updated_at: v.string(),
  last_active_at: v.string(),
});
const commandEventRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  input: v.string(),
  status: v.string(),
  result_json: nullableStringSchema,
  flue_run_id: nullableStringSchema,
  workflow_summary_id: nullableStringSchema,
  created_at: v.string(),
  completed_at: nullableStringSchema,
  updated_at: v.string(),
});
const stringArraySchema = v.array(v.unknown());

export async function readChatSessionInternal(
  id: string,
  paths: RuntimePaths,
): Promise<ChatSessionRecord | undefined> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    return findChatSession(database, id);
  } finally {
    database.close();
  }
}

export function readActiveChatSession(database: DatabaseSync, surface: string) {
  const activeId = readActiveSessionId(database, surface);
  const active = activeId ? findChatSession(database, activeId) : undefined;
  if (active && !active.archivedAt) return active;

  const fallback = database
    .prepare(
      `
      SELECT *
      FROM chat_sessions
      WHERE agent_name = 'display-assistant'
        AND archived_at IS NULL
      ORDER BY pinned DESC, last_active_at DESC, created_at DESC
      LIMIT 1;
    `,
    )
    .get();
  if (!fallback) {
    throw new Error('No active Neon session is configured.');
  }

  const session = readChatSessionRow(fallback, database);
  setActiveSession(database, surface, session.id, new Date().toISOString());
  return session;
}

export function readActiveSessionId(database: DatabaseSync, surface: string) {
  const row = database
    .prepare(
      `
      SELECT session_id
      FROM chat_session_surfaces
      WHERE surface = ?;
    `,
    )
    .get(surface);
  const parsed = v.safeParse(activeSessionRowSchema, row);
  return parsed.success ? parsed.output.session_id : null;
}

export function setActiveSession(
  database: DatabaseSync,
  surface: string,
  sessionId: string,
  changedAt: string,
) {
  database
    .prepare(
      `
      INSERT INTO chat_session_surfaces (surface, session_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(surface) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at;
    `,
    )
    .run(surface, sessionId, changedAt);
  database
    .prepare(
      `
      UPDATE chat_sessions
      SET last_active_at = ?, updated_at = ?
      WHERE id = ?;
    `,
    )
    .run(changedAt, changedAt, sessionId);
}

export function findChatSession(database: DatabaseSync, id: string) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM chat_sessions
      WHERE id = ?;
    `,
    )
    .get(id);
  return row ? readChatSessionRow(row, database) : undefined;
}

export function findChatSessionCommandEvent(
  database: DatabaseSync,
  id: string,
) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM chat_session_command_events
      WHERE id = ?;
    `,
    )
    .get(id);
  return row ? readChatSessionCommandEventRow(row) : undefined;
}

export function listChatSessionCommandEventRows(
  database: DatabaseSync,
  sessionId: string,
  limit = 30,
) {
  return database
    .prepare(
      `
      SELECT *
      FROM chat_session_command_events
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?;
    `,
    )
    .all(sessionId, limit)
    .map(readChatSessionCommandEventRow)
    .reverse();
}

export function findLinkedChatSession(
  database: DatabaseSync,
  input: {
    kind: ChatSessionKind;
    linkedRepoId: string | null;
    linkedWatchId: string | null;
    linkedTaskId: string | null;
  },
) {
  if (input.linkedTaskId) {
    const row = database
      .prepare(
        `
        SELECT *
        FROM chat_sessions
        WHERE agent_name = 'display-assistant'
          AND kind = ?
          AND linked_task_id = ?
        ORDER BY archived_at IS NULL DESC, last_active_at DESC, created_at DESC
        LIMIT 1;
      `,
      )
      .get(input.kind, input.linkedTaskId);
    return row ? readChatSessionRow(row, database) : undefined;
  }

  if (input.linkedWatchId) {
    const row = database
      .prepare(
        `
        SELECT *
        FROM chat_sessions
        WHERE agent_name = 'display-assistant'
          AND kind = ?
          AND linked_watch_id = ?
        ORDER BY archived_at IS NULL DESC, last_active_at DESC, created_at DESC
        LIMIT 1;
      `,
      )
      .get(input.kind, input.linkedWatchId);
    return row ? readChatSessionRow(row, database) : undefined;
  }

  if (input.linkedRepoId) {
    const row = database
      .prepare(
        `
        SELECT *
        FROM chat_sessions
        WHERE agent_name = 'display-assistant'
          AND kind = ?
          AND linked_repo_id = ?
          AND linked_watch_id IS NULL
          AND linked_task_id IS NULL
        ORDER BY archived_at IS NULL DESC, last_active_at DESC, created_at DESC
        LIMIT 1;
      `,
      )
      .get(input.kind, input.linkedRepoId);
    return row ? readChatSessionRow(row, database) : undefined;
  }

  return undefined;
}

export function readChatSessionRow(
  row: SessionExternalValue,
  database: DatabaseSync,
): ChatSessionRecord {
  const record = v.parse(chatSessionRowSchema, row);
  const persistedReasons = parsePersistedStaleReasons(
    record.stale_reasons_json,
  );
  const lastActiveAt = record.last_active_at;
  const contextLoadedAt = record.context_loaded_at ?? record.created_at;
  const contextMemoryIds = parsePersistedStringArray(
    record.context_memory_ids_json,
  );
  const dynamicReasons = readStaleReasons(
    database,
    contextLoadedAt,
    contextMemoryIds,
  );
  const summaryGeneratedAt = record.summary_generated_at;
  const summary = record.summary;

  return {
    id: record.id,
    title: record.title,
    agentName: record.agent_name,
    kind: chatSessionKind(record.kind),
    pinned: Boolean(record.pinned),
    archivedAt: record.archived_at,
    linkedRepoId: record.linked_repo_id,
    linkedWatchId: record.linked_watch_id,
    linkedTaskId: record.linked_task_id,
    staleReasons: [...dynamicReasons, ...persistedReasons].sort(
      (a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt),
    ),
    uiMetadata: parsePersistedJsonValue(record.ui_metadata_json),
    summary,
    summaryGeneratedAt,
    summarySource: chatSessionSummarySource(record.summary_source),
    summaryRefreshNote: record.summary_refresh_note,
    summaryStatus: summaryStatus(summary, summaryGeneratedAt),
    contextLoadedAt,
    contextMemoryIds,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    lastActiveAt,
  };
}

export function readChatSessionCommandEventRow(
  row: SessionExternalValue,
): ChatSessionCommandEvent {
  const record = v.parse(commandEventRowSchema, row);
  return {
    id: record.id,
    sessionId: record.session_id,
    input: record.input,
    status:
      record.status === 'completed' || record.status === 'failed'
        ? record.status
        : 'running',
    result: parsePersistedJsonValue(record.result_json),
    flueRunId: record.flue_run_id,
    workflowSummaryId: record.workflow_summary_id,
    createdAt: record.created_at,
    completedAt: record.completed_at,
    updatedAt: record.updated_at,
  };
}

function parsePersistedStaleReasons(
  value: SessionExternalValue,
): NeonSessionStaleReason[] {
  const text = v.safeParse(v.string(), value);
  if (!text.success) return [];
  try {
    const parsed = v.safeParse(
      persistedStaleReasonsSchema,
      JSON.parse(text.output),
    );
    return parsed.success ? parsed.output : [];
  } catch {
    return [];
  }
}

function parsePersistedJsonValue(
  value: SessionExternalValue,
): JsonValue | null {
  const text = v.safeParse(v.string(), value);
  if (!text.success) return null;
  try {
    const parsed = v.safeParse(
      persistedJsonValueSchema,
      JSON.parse(text.output),
    );
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function readStaleReasons(
  database: DatabaseSync,
  activatedAt: string,
  contextMemoryIds: string[] = [],
): NeonSessionStaleReason[] {
  return readStaleReasonChanges(database, {
    activatedAt,
    contextMemoryIds,
    ignoredConfigActions: [
      'briefing_profile_update',
      'config_apply_dashboard_preset',
      'config_update_dashboard_layout',
    ],
  }).reasons;
}

function parsePersistedStringArray(value: SessionExternalValue) {
  const text = v.safeParse(v.string(), value);
  if (!text.success) return [];
  try {
    const parsed = v.safeParse(stringArraySchema, JSON.parse(text.output));
    if (!parsed.success) return [];
    return parsed.output.flatMap((item) => {
      const parsedItem = v.safeParse(v.string(), item);
      return parsedItem.success ? [parsedItem.output] : [];
    });
  } catch {
    return [];
  }
}

export function markLoadedMemoriesUsed(
  database: DatabaseSync,
  memoryIds: string[],
  usedAt: string,
) {
  for (const id of new Set(memoryIds)) {
    database
      .prepare(
        `
        UPDATE memories
        SET use_count = use_count + 1,
          last_used_at = ?
        WHERE id = ?
          AND status != 'archived';
      `,
      )
      .run(usedAt, id);
  }
}

export function recordSessionAudit(
  database: DatabaseSync,
  input: {
    action: string;
    sessionId?: string | null;
    surface?: string | null;
    reason?: string | null;
    metadata?: SessionExternalValue;
  },
) {
  database
    .prepare(
      `
      INSERT INTO chat_session_audit (
        action,
        session_id,
        surface,
        reason,
        metadata_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      input.action,
      input.sessionId ?? null,
      input.surface ?? null,
      input.reason ?? null,
      input.metadata === undefined
        ? null
        : JSON.stringify(asJsonValue(input.metadata)),
      new Date().toISOString(),
    );
}

function chatSessionKind(value: SessionExternalValue): ChatSessionKind {
  const parsed = v.safeParse(chatSessionKindSchema, value);
  return parsed.success ? parsed.output : 'general';
}

function chatSessionSummarySource(
  value: SessionExternalValue,
): ChatSessionSummarySource | null {
  const parsed = v.safeParse(summarySourceSchema, value);
  return parsed.success ? parsed.output : null;
}

function summaryStatus(
  summary: string | null,
  generatedAt: string | null,
): ChatSessionSummaryStatus {
  if (!summary) return 'missing';
  if (!generatedAt) return 'stale';
  return 'fresh';
}
