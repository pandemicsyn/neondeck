import { collectValidRowsInBatches, openDb } from '../../lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import type { NeonSessionState } from './schemas';
import { readActiveChatSession, safeReadChatSessionRow } from './store';

export async function readNeonSessionState(
  paths: RuntimePaths = runtimePaths(),
  surface = 'dashboard',
): Promise<NeonSessionState> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    const active = readActiveChatSession(database, surface);
    const sessions = collectValidRowsInBatches(
      30,
      (batchLimit, offset) =>
        database
          .prepare(
            `
        SELECT *
        FROM chat_sessions
        WHERE agent_name = 'display-assistant'
        ORDER BY pinned DESC, archived_at IS NULL DESC, last_active_at DESC, created_at DESC
        LIMIT ? OFFSET ?;
      `,
          )
          .all(batchLimit, offset),
      (row) => {
        const session = safeReadChatSessionRow(row, database);
        return session ? [session] : [];
      },
    );

    return {
      ok: true,
      action: 'session_status',
      activeChatSession: active,
      activeSessionId: active.id,
      surface,
      stale: active.staleReasons.length > 0,
      staleReasons: active.staleReasons,
      sessions,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}
