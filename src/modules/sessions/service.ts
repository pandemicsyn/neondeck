import { type JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { buildMemoryPromptSnapshotSync } from '../../memory-actions';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { suggestUtilitySessionTitle } from '../../utility-model';
import { failedSessionResult } from './utils';
import { publishSessionEvent } from './events';
import { readNeonSessionState } from './active-session';
import {
  findChatSession,
  findLinkedChatSession,
  markLoadedMemoriesUsed,
  readActiveSessionId,
  readChatSessionInternal,
  recordSessionAudit,
  setActiveSession,
} from './store';
import {
  legacySessionStartInputSchema,
  sessionArchiveInputSchema,
  sessionCreateInputSchema,
  sessionLinkContextInputSchema,
  sessionPinInputSchema,
  sessionRenameInputSchema,
  sessionSwitchInputSchema,
  type ChatSessionKind,
  type ChatSessionRecord,
} from './schemas';
import type { ChatSessionEventAction } from './events';

export async function createChatSession(
  input: v.InferInput<typeof sessionCreateInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionCreateInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_create', v.summarize(parsed.issues));
  }

  const now = new Date().toISOString();
  const id = `neondeck-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const titleSuggestion = suggestUtilitySessionTitle(
    { label: parsed.output.title, reason: parsed.output.reason },
    paths,
  );
  const title = parsed.output.title ?? titleSuggestion.title;
  const kind = parsed.output.kind ?? inferSessionKind(parsed.output);
  const surface = parsed.output.surface ?? 'dashboard';
  const activate = parsed.output.activate ?? true;
  const uiMetadata = sessionUiMetadata(
    parsed.output.uiMetadata as JsonValue | null | undefined,
    parsed.output.reason,
  );
  const summary = parsed.output.summary?.trim() || null;
  const summaryGeneratedAt = summary ? now : null;
  const summarySource = summary
    ? (parsed.output.summarySource ?? 'manual')
    : null;
  const summaryRefreshNote = summary
    ? 'Stored summary provided when the session metadata was created.'
    : null;
  const memorySnapshot = buildMemoryPromptSnapshotSync(paths, {
    repoId: parsed.output.linkedRepoId ?? null,
  });
  const database = openDb(paths.neondeckDatabase);
  let sessionId = id;
  let eventAction: ChatSessionEventAction = 'created';
  let reusedExisting = false;
  let reusedSessionChanged = false;

  try {
    database.exec('BEGIN;');
    const existing = findLinkedChatSession(database, {
      kind,
      linkedRepoId: parsed.output.linkedRepoId ?? null,
      linkedWatchId: parsed.output.linkedWatchId ?? null,
      linkedTaskId: parsed.output.linkedTaskId ?? null,
    });

    if (existing) {
      reusedExisting = true;
      sessionId = existing.id;
      const shouldStoreSummary = Boolean(summary && !existing.summary);
      reusedSessionChanged = Boolean(existing.archivedAt || shouldStoreSummary);
      eventAction = existing.archivedAt
        ? 'restored'
        : activate
          ? 'switched'
          : 'updated';
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET
            archived_at = NULL,
            summary = ?,
            summary_generated_at = ?,
            summary_source = ?,
            summary_refresh_note = ?,
            updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(
          shouldStoreSummary ? summary : existing.summary,
          shouldStoreSummary ? summaryGeneratedAt : existing.summaryGeneratedAt,
          shouldStoreSummary ? summarySource : existing.summarySource,
          shouldStoreSummary ? summaryRefreshNote : existing.summaryRefreshNote,
          now,
          sessionId,
        );
    } else {
      database
        .prepare(
          `
          INSERT INTO chat_sessions (
            id,
            title,
            agent_name,
            kind,
            pinned,
            linked_repo_id,
            linked_watch_id,
            linked_task_id,
            ui_metadata_json,
            summary,
            summary_generated_at,
            summary_source,
            summary_refresh_note,
            context_loaded_at,
            context_memory_ids_json,
            created_at,
            updated_at,
            last_active_at
          )
          VALUES (?, ?, 'display-assistant', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `,
        )
        .run(
          id,
          title,
          kind,
          parsed.output.linkedRepoId ?? null,
          parsed.output.linkedWatchId ?? null,
          parsed.output.linkedTaskId ?? null,
          uiMetadata === null ? null : JSON.stringify(uiMetadata),
          summary,
          summaryGeneratedAt,
          summarySource,
          summaryRefreshNote,
          now,
          JSON.stringify(memorySnapshot.memoryIds),
          now,
          now,
          now,
        );
    }
    if (activate) {
      setActiveSession(database, surface, sessionId, now);
    }
    markLoadedMemoriesUsed(database, memorySnapshot.memoryIds, now);
    recordSessionAudit(database, {
      action: reusedExisting ? 'reuse-linked' : 'create',
      sessionId,
      surface: activate ? surface : null,
      reason: parsed.output.reason ?? null,
    });
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  const state = await readNeonSessionState(paths, surface);
  const session =
    state.sessions.find((item) => item.id === sessionId) ??
    state.activeChatSession;
  const changed = !reusedExisting || reusedSessionChanged || activate;
  if (changed) {
    publishSessionEvent(eventAction, session, activate ? surface : null);
  }

  return {
    ok: true,
    action: 'session_create',
    changed,
    message:
      reusedExisting && activate
        ? 'Reused linked chat session metadata and switched the surface to it.'
        : reusedExisting
          ? 'Reused linked chat session metadata.'
          : 'Created chat session metadata. New messages for this id remain in Flue persistence.',
    session,
    state,
    titleSuggestion,
  };
}

export async function startNeonSession(
  input: v.InferInput<typeof legacySessionStartInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(legacySessionStartInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_start', v.summarize(parsed.issues));
  }

  const result = await createChatSession(
    {
      title: parsed.output.label,
      reason: parsed.output.reason ?? 'manual-new-session',
      surface: 'dashboard',
      activate: true,
    },
    paths,
  );

  return {
    ...result,
    action: 'session_start',
    message:
      'Started a new Neon session. New chat messages will load current SOUL, skills, model config, and memory context.',
  };
}

export async function switchChatSession(
  input: v.InferInput<typeof sessionSwitchInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionSwitchInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_switch', v.summarize(parsed.issues));
  }

  const now = new Date().toISOString();
  const surface = parsed.output.surface ?? 'dashboard';
  const database = openDb(paths.neondeckDatabase);
  let session: ChatSessionRecord | undefined;

  try {
    database.exec('BEGIN;');
    session = findChatSession(database, parsed.output.id);
    if (!session) {
      database.exec('ROLLBACK;');
      return failedSessionResult(
        'session_switch',
        `Session ${parsed.output.id} was not found.`,
      );
    }
    if (session.archivedAt) {
      database.exec('ROLLBACK;');
      return failedSessionResult(
        'session_switch',
        `Session ${session.title} is archived. Restore it before switching.`,
      );
    }

    setActiveSession(database, surface, session.id, now);
    recordSessionAudit(database, {
      action: 'switch',
      sessionId: session.id,
      surface,
      reason: parsed.output.reason ?? null,
    });
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  const state = await readNeonSessionState(paths, surface);
  publishSessionEvent('switched', state.activeChatSession, surface);

  return {
    ok: true,
    action: 'session_switch',
    changed: true,
    message: `Switched ${surface} to ${state.activeChatSession.title}.`,
    session: state.activeChatSession,
    state,
  };
}

export async function renameChatSession(
  input: v.InferInput<typeof sessionRenameInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(sessionRenameInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_rename', v.summarize(parsed.issues));
  }

  return updateOneSession(
    parsed.output,
    paths,
    'session_rename',
    'rename',
    (database, item, now) => {
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET title = ?, updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(item.title, now, item.id);
    },
  );
}

export async function pinChatSession(
  input: v.InferInput<typeof sessionPinInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(sessionPinInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_pin', v.summarize(parsed.issues));
  }

  return updateOneSession(
    parsed.output,
    paths,
    'session_pin',
    'pin',
    (database, item, now) => {
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET pinned = ?, updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(item.pinned ? 1 : 0, now, item.id);
    },
  );
}

export async function archiveChatSession(
  input: v.InferInput<typeof sessionArchiveInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionArchiveInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_archive', v.summarize(parsed.issues));
  }

  const now = new Date().toISOString();
  const surface = parsed.output.surface ?? 'dashboard';
  const database = openDb(paths.neondeckDatabase);
  let archived: ChatSessionRecord | undefined;

  try {
    database.exec('BEGIN;');
    archived = findChatSession(database, parsed.output.id);
    if (!archived) {
      database.exec('ROLLBACK;');
      return failedSessionResult(
        'session_archive',
        `Session ${parsed.output.id} was not found.`,
      );
    }

    if (readActiveSessionId(database, surface) === parsed.output.id) {
      const replacement = database
        .prepare(
          `
          SELECT id
          FROM chat_sessions
          WHERE archived_at IS NULL
            AND id <> ?
          ORDER BY pinned DESC, last_active_at DESC, created_at DESC
          LIMIT 1;
        `,
        )
        .get(parsed.output.id) as { id?: unknown } | undefined;
      if (typeof replacement?.id !== 'string') {
        database.exec('ROLLBACK;');
        return failedSessionResult(
          'session_archive',
          'Create or switch to another session before archiving the active session.',
        );
      }

      setActiveSession(database, surface, replacement.id, now);
    }
    database
      .prepare(
        `
        UPDATE chat_sessions
        SET archived_at = COALESCE(archived_at, ?), updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, now, parsed.output.id);
    recordSessionAudit(database, {
      action: 'archive',
      sessionId: parsed.output.id,
      surface,
      reason: parsed.output.reason ?? null,
    });
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  const state = await readNeonSessionState(paths, surface);
  const archivedSession =
    state.sessions.find((item) => item.id === parsed.output.id) ?? archived;
  if (archivedSession)
    publishSessionEvent('archived', archivedSession, surface);

  return {
    ok: true,
    action: 'session_archive',
    changed: true,
    message:
      'Archived chat session metadata. Flue conversation history was not deleted.',
    session: archivedSession,
    state,
  };
}

export async function restoreChatSession(
  input: v.InferInput<typeof sessionArchiveInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(sessionArchiveInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_restore', v.summarize(parsed.issues));
  }

  return updateOneSession(
    parsed.output,
    paths,
    'session_restore',
    'restore',
    (database, item, now) => {
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET archived_at = NULL, updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(now, item.id);
    },
  );
}

export async function linkChatSessionContext(
  input: v.InferInput<typeof sessionLinkContextInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(sessionLinkContextInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult(
      'session_link_context',
      v.summarize(parsed.issues),
    );
  }

  return updateOneSession(
    parsed.output,
    paths,
    'session_link_context',
    'link_context',
    (database, item, now) => {
      const existing = findChatSession(database, item.id);
      const nextSummary =
        item.summary === undefined ? (existing?.summary ?? null) : item.summary;
      const summaryChanged = item.summary !== undefined;
      const summaryGeneratedAt = summaryChanged
        ? item.summary === null
          ? null
          : now
        : (existing?.summaryGeneratedAt ?? null);
      const summarySource = summaryChanged
        ? item.summary === null
          ? null
          : (item.summarySource ?? 'manual')
        : (existing?.summarySource ?? null);
      const summaryRefreshNote = summaryChanged
        ? item.summary === null
          ? null
          : 'Stored summary provided while linking session context.'
        : (existing?.summaryRefreshNote ?? null);
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET
            kind = ?,
            linked_repo_id = ?,
            linked_watch_id = ?,
            linked_task_id = ?,
            ui_metadata_json = ?,
            summary = ?,
            summary_generated_at = ?,
            summary_source = ?,
            summary_refresh_note = ?,
            updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(
          item.kind ?? existing?.kind ?? 'general',
          item.linkedRepoId === undefined
            ? (existing?.linkedRepoId ?? null)
            : item.linkedRepoId,
          item.linkedWatchId === undefined
            ? (existing?.linkedWatchId ?? null)
            : item.linkedWatchId,
          item.linkedTaskId === undefined
            ? (existing?.linkedTaskId ?? null)
            : item.linkedTaskId,
          item.uiMetadata === undefined
            ? existing?.uiMetadata === null ||
              existing?.uiMetadata === undefined
              ? null
              : JSON.stringify(existing.uiMetadata)
            : item.uiMetadata === null
              ? null
              : JSON.stringify(asJsonValue(item.uiMetadata)),
          nextSummary,
          summaryGeneratedAt,
          summarySource,
          summaryRefreshNote,
          now,
          item.id,
        );
    },
  );
}

function updateOneSession<TInput extends { id: string; reason?: string }>(
  input: TInput,
  paths: RuntimePaths,
  action: string,
  auditAction: string,
  update: (database: DatabaseSync, input: TInput, now: string) => void,
) {
  return (async () => {
    await ensureRuntimeHome(paths);
    const now = new Date().toISOString();
    const database = openDb(paths.neondeckDatabase);

    try {
      database.exec('BEGIN;');
      const before = findChatSession(database, input.id);
      if (!before) {
        database.exec('ROLLBACK;');
        return failedSessionResult(
          action,
          `Session ${input.id} was not found.`,
        );
      }
      update(database, input, now);
      recordSessionAudit(database, {
        action: auditAction,
        sessionId: input.id,
        reason: input.reason ?? null,
      });
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.close();
    }

    const session = await readChatSessionInternal(input.id, paths);
    if (session) publishSessionEvent('updated', session, null);

    return {
      ok: true,
      action,
      changed: true,
      message: `Updated chat session metadata for ${input.id}.`,
      session,
    };
  })();
}

function inferSessionKind(
  input: v.InferOutput<typeof sessionCreateInputSchema>,
): ChatSessionKind {
  if (input.linkedTaskId) return 'task';
  if (input.linkedWatchId) return 'watch';
  if (input.linkedRepoId) return 'repo';
  return 'scratch';
}

function sessionUiMetadata(
  metadata: JsonValue | null | undefined,
  reason: string | undefined,
) {
  if (!reason) return metadata === undefined ? null : metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return asJsonValue({ ...metadata, legacyReason: reason });
  }

  return asJsonValue({ legacyReason: reason });
}

function compactTimestamp(value: string) {
  return value.replace(/\D/g, '').slice(0, 14);
}
