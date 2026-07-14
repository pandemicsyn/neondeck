import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import * as v from 'valibot';
import {
  isJsonValue,
  sessionActivityListInputSchema,
  type ChatSessionActivityItem,
} from './schemas';
import { findChatSession } from './store';
import { failedSessionResult } from './utils';

export async function listChatSessionActivity(
  input: v.InferInput<typeof sessionActivityListInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionActivityListInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult(
      'session_activity_list',
      v.summarize(parsed.issues),
    );
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const session = findChatSession(database, parsed.output.sessionId);
    if (!session) {
      return failedSessionResult(
        'session_activity_list',
        `Session ${parsed.output.sessionId} was not found.`,
      );
    }

    const watchId = session.linkedWatchId;
    const items = watchId
      ? database
          .prepare(
            `
            SELECT *
            FROM (
              SELECT *
              FROM notifications
              WHERE source_id = ?
                OR CASE
                  WHEN json_valid(data_json) THEN
                    json_extract(data_json, '$.watchId') = ?
                    OR (
                      source = 'watch-pr'
                      AND json_extract(data_json, '$.id') = ?
                    )
                  ELSE 0
                END
              ORDER BY COALESCE(updated_at, created_at) DESC,
                created_at DESC,
                id DESC
              LIMIT ?
            )
            ORDER BY COALESCE(updated_at, created_at) ASC,
              created_at ASC,
              id ASC;
          `,
          )
          .all(watchId, watchId, watchId, parsed.output.limit ?? 50)
          .map(readActivityRow)
      : [];

    return {
      ok: true,
      action: 'session_activity_list' as const,
      changed: false,
      items,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

function readActivityRow(row: unknown): ChatSessionActivityItem {
  const record = row as Record<string, unknown>;
  const createdAt = String(record.created_at);
  return {
    id: String(record.id),
    kind: 'notification',
    level: notificationLevel(record.level),
    title: String(record.title),
    message: String(record.message),
    source: typeof record.source === 'string' ? record.source : null,
    sourceId: typeof record.source_id === 'string' ? record.source_id : null,
    data: parseJsonValue(record.data_json),
    readAt: typeof record.read_at === 'string' ? record.read_at : null,
    resolvedAt:
      typeof record.resolved_at === 'string' ? record.resolved_at : null,
    occurrenceCount: Number(record.occurrence_count ?? 1),
    createdAt,
    updatedAt:
      typeof record.updated_at === 'string' ? record.updated_at : createdAt,
  };
}

function notificationLevel(value: unknown): ChatSessionActivityItem['level'] {
  return value === 'ready' || value === 'attention' || value === 'urgent'
    ? value
    : 'info';
}

function parseJsonValue(value: unknown): ChatSessionActivityItem['data'] {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed)
      ? (parsed as ChatSessionActivityItem['data'])
      : null;
  } catch {
    return null;
  }
}
