import { openDb } from '../../lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import type { NeonSessionState } from './schemas';
import {
  readActiveChatSession,
  readChatSessionRow,
  toNeonSessionRecord,
} from './store';

export async function readNeonSessionState(
  paths: RuntimePaths = runtimePaths(),
  surface = 'dashboard',
): Promise<NeonSessionState> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    const active = readActiveChatSession(database, surface);
    const activeSession = toNeonSessionRecord(active, active.id);
    const sessions = database
      .prepare(
        `
        SELECT *
        FROM chat_sessions
        WHERE agent_name = 'display-assistant'
        ORDER BY pinned DESC, archived_at IS NULL DESC, last_active_at DESC, created_at DESC
        LIMIT 30;
      `,
      )
      .all()
      .map((row) => readChatSessionRow(row, database));

    return {
      ok: true,
      action: 'session_status',
      activeSession,
      activeChatSession: active,
      activeSessionId: active.id,
      surface,
      stale: active.staleReasons.length > 0,
      staleReasons: active.staleReasons,
      history: sessions
        .slice(0, 10)
        .map((session) => toNeonSessionRecord(session, active.id)),
      sessions,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}
