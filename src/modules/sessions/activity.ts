import { collectValidRowsInBatches, openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import * as v from 'valibot';
import {
  persistedJsonValueSchema,
  sessionActivityListInputSchema,
  type ChatSessionActivityItem,
  type SessionExternalValue,
} from './schemas';
import { findChatSession } from './store';
import { failedSessionResult } from './utils';

const nullableStringSchema = v.nullable(v.string());
const activityRowSchema = v.object({
  id: v.string(),
  level: v.string(),
  title: v.string(),
  message: v.string(),
  source: nullableStringSchema,
  source_id: nullableStringSchema,
  data_json: nullableStringSchema,
  read_at: nullableStringSchema,
  resolved_at: nullableStringSchema,
  occurrence_count: v.number(),
  created_at: v.string(),
  updated_at: nullableStringSchema,
});

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
      ? collectValidRowsInBatches(
          parsed.output.limit ?? 50,
          (limit, offset) =>
            database
              .prepare(
                `
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
                LIMIT ? OFFSET ?;
              `,
              )
              .all(watchId, watchId, watchId, limit, offset),
          safeReadActivityRow,
        ).reverse()
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

function readActivityRow(row: SessionExternalValue): ChatSessionActivityItem {
  const record = v.parse(activityRowSchema, row);
  const createdAt = record.created_at;
  return {
    id: record.id,
    kind: 'notification',
    level: notificationLevel(record.level),
    title: record.title,
    message: record.message,
    source: record.source,
    sourceId: record.source_id,
    data: parseJsonValue(record.data_json),
    readAt: record.read_at,
    resolvedAt: record.resolved_at,
    occurrenceCount: record.occurrence_count,
    createdAt,
    updatedAt: record.updated_at ?? createdAt,
  };
}

function safeReadActivityRow(
  row: SessionExternalValue,
): ChatSessionActivityItem[] {
  try {
    return [readActivityRow(row)];
  } catch {
    return [];
  }
}

function notificationLevel(
  value: SessionExternalValue,
): ChatSessionActivityItem['level'] {
  return value === 'ready' || value === 'attention' || value === 'urgent'
    ? value
    : 'info';
}

function parseJsonValue(
  value: SessionExternalValue,
): ChatSessionActivityItem['data'] {
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
