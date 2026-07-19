import { type JsonValue } from '@flue/runtime';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { type RuntimePaths, ensureRuntimeHome } from '../../runtime-home';
import {
  persistedJsonValueSchema,
  persistedStaleReasonsSchema,
  type ChatSessionCommandEvent,
  type ChatSessionKind,
  type ChatSessionRecord,
  type ChatSessionSummarySource,
  type ChatSessionSummaryStatus,
  type NeonSessionStaleReason,
} from './schemas';

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
    .get(surface) as { session_id?: unknown } | undefined;
  return typeof row?.session_id === 'string' ? row.session_id : null;
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
  row: unknown,
  database: DatabaseSync,
): ChatSessionRecord {
  const record = row as Record<string, unknown>;
  const persistedReasons = parsePersistedStaleReasons(
    record.stale_reasons_json,
  );
  const lastActiveAt = String(record.last_active_at);
  const contextLoadedAt =
    typeof record.context_loaded_at === 'string'
      ? record.context_loaded_at
      : String(record.created_at);
  const contextMemoryIds = parsePersistedStringArray(
    record.context_memory_ids_json,
  );
  const dynamicReasons = readStaleReasons(
    database,
    contextLoadedAt,
    contextMemoryIds,
  );
  const summaryGeneratedAt =
    typeof record.summary_generated_at === 'string'
      ? record.summary_generated_at
      : null;
  const summary = typeof record.summary === 'string' ? record.summary : null;

  return {
    id: String(record.id),
    title: String(record.title),
    agentName: String(record.agent_name),
    kind: chatSessionKind(record.kind),
    pinned: Boolean(record.pinned),
    archivedAt:
      typeof record.archived_at === 'string' ? record.archived_at : null,
    linkedRepoId:
      typeof record.linked_repo_id === 'string' ? record.linked_repo_id : null,
    linkedWatchId:
      typeof record.linked_watch_id === 'string'
        ? record.linked_watch_id
        : null,
    linkedTaskId:
      typeof record.linked_task_id === 'string' ? record.linked_task_id : null,
    staleReasons: [...dynamicReasons, ...persistedReasons].sort(
      (a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt),
    ),
    uiMetadata: parsePersistedJsonValue(record.ui_metadata_json),
    summary,
    summaryGeneratedAt,
    summarySource: chatSessionSummarySource(record.summary_source),
    summaryRefreshNote:
      typeof record.summary_refresh_note === 'string'
        ? record.summary_refresh_note
        : null,
    summaryStatus: summaryStatus(summary, summaryGeneratedAt),
    contextLoadedAt,
    contextMemoryIds,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
    lastActiveAt,
  };
}

export function readChatSessionCommandEventRow(
  row: unknown,
): ChatSessionCommandEvent {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    sessionId: String(record.session_id),
    input: String(record.input),
    status:
      record.status === 'completed' || record.status === 'failed'
        ? record.status
        : 'running',
    result: parsePersistedJsonValue(record.result_json),
    flueRunId:
      typeof record.flue_run_id === 'string' ? record.flue_run_id : null,
    workflowSummaryId:
      typeof record.workflow_summary_id === 'string'
        ? record.workflow_summary_id
        : null,
    createdAt: String(record.created_at),
    completedAt:
      typeof record.completed_at === 'string' ? record.completed_at : null,
    updatedAt: String(record.updated_at),
  };
}

function parsePersistedStaleReasons(value: unknown): NeonSessionStaleReason[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = v.safeParse(persistedStaleReasonsSchema, JSON.parse(value));
    return parsed.success ? parsed.output : [];
  } catch {
    return [];
  }
}

function parsePersistedJsonValue(value: unknown): JsonValue | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = v.safeParse(persistedJsonValueSchema, JSON.parse(value));
    return parsed.success ? (parsed.output as JsonValue) : null;
  } catch {
    return null;
  }
}

function readStaleReasons(
  database: DatabaseSync,
  activatedAt: string,
  contextMemoryIds: string[] = [],
): NeonSessionStaleReason[] {
  const reasons: NeonSessionStaleReason[] = [];
  const config = database
    .prepare(
      `
      SELECT action, target, changed_at
      FROM config_history
      WHERE action != 'briefing_profile_update'
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
    const target = typeof config.target === 'string' ? config.target : null;
    const type = staleReasonType(String(config.action ?? ''), target);
    reasons.push({
      type,
      message: `${staleReasonLabel(type, target)} changed after this session was last active.`,
      changedAt: config.changed_at,
      target,
    });
  }

  const memory = database
    .prepare(
      `
      SELECT memory_id, action, after_json, before_json, created_at
      FROM memory_events
      ${
        contextMemoryIds.length > 0
          ? `WHERE memory_id IN (${contextMemoryIds.map(() => '?').join(', ')})`
          : ''
      }
      ORDER BY created_at DESC
      LIMIT 1;
    `,
    )
    .get(...contextMemoryIds) as
    | {
        memory_id?: unknown;
        action?: unknown;
        after_json?: unknown;
        before_json?: unknown;
        created_at?: unknown;
      }
    | undefined;

  if (
    typeof memory?.created_at === 'string' &&
    Date.parse(memory.created_at) > Date.parse(activatedAt)
  ) {
    const target = memoryEventTarget(memory.after_json, memory.before_json);
    reasons.push({
      type: 'memory',
      message: `Memory ${target ?? 'unknown'} ${String(memory.action ?? 'changed')} after this session was last active.`,
      changedAt: memory.created_at,
      target:
        target ??
        (typeof memory.memory_id === 'string' ? memory.memory_id : null),
    });
  }

  return reasons.sort(
    (a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt),
  );
}

function parsePersistedStringArray(value: unknown) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
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
          AND status = 'active';
      `,
      )
      .run(usedAt, id);
  }
}

function memoryEventTarget(afterJson: unknown, beforeJson: unknown) {
  const after = parseMemoryEventSnapshot(afterJson);
  const before = parseMemoryEventSnapshot(beforeJson);
  const snapshot = after ?? before;
  if (!snapshot) return null;
  return `${snapshot.scope}:${snapshot.key}`;
}

function parseMemoryEventSnapshot(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.scope === 'string' && typeof record.key === 'string'
      ? { scope: record.scope, key: record.key }
      : null;
  } catch {
    return null;
  }
}

export function recordSessionAudit(
  database: DatabaseSync,
  input: {
    action: string;
    sessionId?: string | null;
    surface?: string | null;
    reason?: string | null;
    metadata?: unknown;
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

function chatSessionKind(value: unknown): ChatSessionKind {
  if (
    value === 'main' ||
    value === 'scratch' ||
    value === 'general' ||
    value === 'repo' ||
    value === 'watch' ||
    value === 'task' ||
    value === 'briefing'
  ) {
    return value;
  }
  return 'general';
}

function chatSessionSummarySource(
  value: unknown,
): ChatSessionSummarySource | null {
  if (
    value === 'manual' ||
    value === 'metadata' ||
    value === 'agent' ||
    value === 'transcript-summary'
  ) {
    return value;
  }
  return null;
}

function summaryStatus(
  summary: string | null,
  generatedAt: string | null,
): ChatSessionSummaryStatus {
  if (!summary) return 'missing';
  if (!generatedAt) return 'stale';
  return 'fresh';
}

function staleReasonType(
  action: string,
  target: string | null,
): NeonSessionStaleReason['type'] {
  if (target === 'models' || action.includes('agent_models')) return 'model';
  if (target?.startsWith('providers.') || action.includes('provider')) {
    return 'provider';
  }
  if (target === 'skillRoots' || action.includes('skill')) return 'skill';
  if (
    action === 'config_add_repo' ||
    action === 'config_update_repo' ||
    action === 'config_remove_repo'
  ) {
    return 'repo';
  }
  if (target === 'soul' || action.includes('soul')) return 'soul';
  return 'config';
}

function staleReasonLabel(
  type: NeonSessionStaleReason['type'],
  target: string | null,
) {
  if (type === 'model') return 'Model configuration';
  if (type === 'provider') return 'Provider configuration';
  if (type === 'repo') return 'Repository configuration';
  if (type === 'skill') return 'Runtime skill configuration';
  if (type === 'soul') return 'SOUL context';
  if (type === 'memory') return 'Memory';
  return target ?? 'Runtime config';
}
