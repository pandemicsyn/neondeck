import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { failedSessionResult, escapeLike } from './utils';
import {
  findChatSession,
  readActiveSessionId,
  readChatSessionRow,
  recordSessionAudit,
} from './store';
import {
  sessionListInputSchema,
  sessionMessagesInputSchema,
  sessionReadInputSchema,
  sessionSearchInputSchema,
} from './schemas';

export async function listChatSessions(
  input: v.InferInput<typeof sessionListInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionListInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_list', v.summarize(parsed.issues));
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const filters = ['agent_name = ?'];
    const params: Array<string | number> = ['display-assistant'];
    if (!parsed.output.includeArchived) filters.push('archived_at IS NULL');
    if (parsed.output.kind) {
      filters.push('kind = ?');
      params.push(parsed.output.kind);
    }

    const limit = parsed.output.limit ?? 50;
    const sessions = database
      .prepare(
        `
        SELECT *
        FROM chat_sessions
        WHERE ${filters.join(' AND ')}
        ORDER BY pinned DESC, last_active_at DESC, created_at DESC
        LIMIT ?;
      `,
      )
      .all(...params, limit)
      .map((row) => readChatSessionRow(row, database));
    const activeSessionId = readActiveSessionId(
      database,
      parsed.output.surface ?? 'dashboard',
    );

    return {
      ok: true,
      action: 'session_list',
      changed: false,
      sessions,
      activeSessionId,
      surface: parsed.output.surface ?? 'dashboard',
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function searchChatSessions(
  input: v.InferInput<typeof sessionSearchInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionSearchInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_search', v.summarize(parsed.issues));
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const filters = [
      'agent_name = ?',
      '(id LIKE ? OR title LIKE ? OR summary LIKE ? OR linked_repo_id LIKE ? OR linked_watch_id LIKE ? OR linked_task_id LIKE ?)',
    ];
    const needle = `%${escapeLike(parsed.output.query)}%`;
    const params: Array<string | number> = [
      'display-assistant',
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
    ];
    if (!parsed.output.includeArchived) filters.push('archived_at IS NULL');
    const limit = parsed.output.limit ?? 20;
    const sessions = database
      .prepare(
        `
        SELECT *
        FROM chat_sessions
        WHERE ${filters.join(' AND ')}
        ORDER BY pinned DESC, last_active_at DESC, created_at DESC
        LIMIT ?;
      `,
      )
      .all(...params, limit)
      .map((row) => readChatSessionRow(row, database));

    recordSessionAudit(database, {
      action: 'search',
      sessionId: null,
      surface: parsed.output.surface ?? null,
      reason: `query:${parsed.output.query}`,
      metadata: { count: sessions.length },
    });

    return {
      ok: true,
      action: 'session_search',
      changed: false,
      sessions,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function readChatSession(
  input: v.InferInput<typeof sessionReadInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionReadInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_read', v.summarize(parsed.issues));
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const session = findChatSession(database, parsed.output.id);
    if (!session) {
      return failedSessionResult(
        'session_read',
        `Session ${parsed.output.id} was not found.`,
      );
    }

    recordSessionAudit(database, {
      action: 'read',
      sessionId: session.id,
      surface: parsed.output.surface ?? null,
      reason: parsed.output.reason ?? null,
    });

    return {
      ok: true,
      action: 'session_read',
      changed: false,
      message:
        'Read chat session metadata. Conversation history remains in Flue persistence.',
      session,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function readChatSessionMessages(
  input: v.InferInput<typeof sessionMessagesInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionMessagesInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_messages', v.summarize(parsed.issues));
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const session = findChatSession(database, parsed.output.id);
    if (!session) {
      return failedSessionResult(
        'session_messages',
        `Session ${parsed.output.id} was not found.`,
      );
    }
    if (!parsed.output.explicitUserRequest) {
      recordSessionAudit(database, {
        action: 'messages_denied',
        sessionId: session.id,
        surface: parsed.output.surface ?? null,
        reason: parsed.output.reason ?? null,
        metadata: {
          cursor: parsed.output.cursor ?? null,
          limit: parsed.output.limit ?? 50,
          requires: 'explicitUserRequest',
        },
      });

      return {
        ok: false,
        action: 'session_messages',
        changed: false,
        message:
          'Raw transcript access requires an explicit user request. Use session summaries and metadata first.',
        session,
        messages: [],
        nextCursor: null,
        transcriptUnavailable: true,
        transcriptOwner: `display-assistant/${session.id}`,
        requires: ['explicitUserRequest'],
        fetchedAt: new Date().toISOString(),
      };
    }

    recordSessionAudit(database, {
      action: 'messages_read',
      sessionId: session.id,
      surface: parsed.output.surface ?? null,
      reason: parsed.output.reason ?? null,
      metadata: {
        cursor: parsed.output.cursor ?? null,
        limit: parsed.output.limit ?? 50,
        explicitUserRequest: true,
      },
    });

    return {
      ok: true,
      action: 'session_messages',
      changed: false,
      message:
        'Transcript reads are audited, but Neondeck app state does not duplicate Flue-owned display-assistant messages.',
      session,
      messages: [],
      nextCursor: null,
      transcriptUnavailable: true,
      transcriptOwner: `display-assistant/${session.id}`,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}
