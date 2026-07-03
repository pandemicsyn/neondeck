import { defineAction, type JsonValue } from '@flue/runtime';
import { asJsonValue } from './lib/action-result';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { openDb } from './lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';
import { buildMemoryPromptSnapshotSync } from './memory-actions';
import {
  publishChatSessionEvent,
  type ChatSessionEventAction,
} from './session-events';
import { suggestUtilitySessionTitle } from './utility-model';

export type ChatSessionKind =
  'main' | 'scratch' | 'general' | 'repo' | 'watch' | 'task' | 'briefing';

export type ChatSessionSummarySource =
  'manual' | 'metadata' | 'agent' | 'transcript-summary';

export type ChatSessionSummaryStatus = 'missing' | 'fresh' | 'stale';

export type NeonSessionStaleReason = {
  type: 'config' | 'memory' | 'model' | 'provider' | 'repo' | 'skill' | 'soul';
  message: string;
  changedAt: string;
  target: string | null;
};

export type ChatSessionRecord = {
  id: string;
  title: string;
  agentName: string;
  kind: ChatSessionKind;
  pinned: boolean;
  archivedAt: string | null;
  linkedRepoId: string | null;
  linkedWatchId: string | null;
  linkedTaskId: string | null;
  staleReasons: NeonSessionStaleReason[];
  uiMetadata: JsonValue | null;
  summary: string | null;
  summaryGeneratedAt: string | null;
  summarySource: ChatSessionSummarySource | null;
  summaryRefreshNote: string | null;
  summaryStatus: ChatSessionSummaryStatus;
  contextLoadedAt: string;
  contextMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};

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

export type NeonSessionState = {
  ok: boolean;
  action: 'session_status';
  activeSession: NeonSessionRecord;
  activeChatSession: ChatSessionRecord;
  activeSessionId: string;
  surface: string;
  stale: boolean;
  staleReasons: NeonSessionStaleReason[];
  history: NeonSessionRecord[];
  sessions: ChatSessionRecord[];
  fetchedAt: string;
};

const chatSessionKindSchema = v.picklist([
  'main',
  'scratch',
  'general',
  'repo',
  'watch',
  'task',
  'briefing',
]);
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const persistedStaleReasonSchema = v.object({
  type: v.picklist([
    'config',
    'memory',
    'model',
    'provider',
    'repo',
    'skill',
    'soul',
  ]),
  message: nonEmptyStringSchema,
  changedAt: nonEmptyStringSchema,
  target: v.nullable(v.string()),
});
const persistedStaleReasonsSchema = v.array(persistedStaleReasonSchema);
const persistedJsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Value must be JSON-safe.'),
);
const titleSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(96));
const surfaceSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const nullableLinkSchema = v.optional(v.nullable(nonEmptyStringSchema));
const jsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Value must be JSON-safe.'),
);
const sessionListInputSchema = v.object({
  includeArchived: v.optional(v.boolean()),
  kind: v.optional(chatSessionKindSchema),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  ),
  surface: v.optional(surfaceSchema),
});
const sessionSearchInputSchema = v.object({
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  includeArchived: v.optional(v.boolean()),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
  ),
  surface: v.optional(surfaceSchema),
});
const sessionReadInputSchema = v.object({
  id: nonEmptyStringSchema,
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
});
const sessionMessagesInputSchema = v.object({
  id: nonEmptyStringSchema,
  cursor: v.optional(v.string()),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  ),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
  explicitUserRequest: v.optional(v.boolean()),
});
const summarySourceSchema = v.picklist([
  'manual',
  'metadata',
  'agent',
  'transcript-summary',
]);
const sessionCreateInputSchema = v.object({
  title: v.optional(titleSchema),
  kind: v.optional(chatSessionKindSchema),
  surface: v.optional(surfaceSchema),
  activate: v.optional(v.boolean()),
  linkedRepoId: nullableLinkSchema,
  linkedWatchId: nullableLinkSchema,
  linkedTaskId: nullableLinkSchema,
  uiMetadata: v.optional(v.nullable(jsonValueSchema)),
  summary: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2_000)))),
  summarySource: v.optional(summarySourceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const sessionSwitchInputSchema = v.object({
  id: nonEmptyStringSchema,
  surface: v.optional(surfaceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const sessionRenameInputSchema = v.object({
  id: nonEmptyStringSchema,
  title: titleSchema,
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const sessionPinInputSchema = v.object({
  id: nonEmptyStringSchema,
  pinned: v.boolean(),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const sessionArchiveInputSchema = v.object({
  id: nonEmptyStringSchema,
  surface: v.optional(surfaceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const sessionLinkContextInputSchema = v.object({
  id: nonEmptyStringSchema,
  kind: v.optional(chatSessionKindSchema),
  linkedRepoId: nullableLinkSchema,
  linkedWatchId: nullableLinkSchema,
  linkedTaskId: nullableLinkSchema,
  uiMetadata: v.optional(v.nullable(jsonValueSchema)),
  summary: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2_000)))),
  summarySource: v.optional(summarySourceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
const sessionRefreshSummaryInputSchema = v.object({
  id: nonEmptyStringSchema,
  providedSummary: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
  source: v.optional(summarySourceSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
});
const sessionReferenceInputSchema = v.object({
  id: nonEmptyStringSchema,
  fromSessionId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.pipe(v.string(), v.maxLength(200))),
  surface: v.optional(surfaceSchema),
  includeRawTranscript: v.optional(v.boolean()),
  explicitUserRequest: v.optional(v.boolean()),
});
const legacySessionStartInputSchema = v.object({
  label: v.optional(titleSchema),
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

export const sessionListAction = defineAction({
  name: 'neondeck_session_list',
  description:
    'List Neondeck chat session metadata. Transcripts remain in Flue persistence.',
  input: sessionListInputSchema,
  output: v.looseObject({ ok: v.boolean() }),
  async run({ input }) {
    return listChatSessions(input);
  },
});

export const sessionSearchAction = defineAction({
  name: 'neondeck_session_search',
  description:
    'Search Neondeck chat session metadata and summaries without reading raw transcripts.',
  input: sessionSearchInputSchema,
  output: v.looseObject({ ok: v.boolean() }),
  async run({ input }) {
    return searchChatSessions(input);
  },
});

export const sessionReadAction = defineAction({
  name: 'neondeck_session_read',
  description:
    'Read one Neondeck chat session metadata record and audit the read.',
  input: sessionReadInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return readChatSession(input);
  },
});

export const sessionMessagesAction = defineAction({
  name: 'neondeck_session_messages',
  description:
    'Audit an explicit user-requested Flue transcript read. Neondeck does not duplicate transcripts in app state.',
  input: sessionMessagesInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return readChatSessionMessages(input);
  },
});

export const sessionRefreshSummaryAction = defineAction({
  name: 'neondeck_session_refresh_summary',
  description:
    'Refresh a stored chat-session summary from bounded metadata, or store an explicitly provided summary.',
  input: sessionRefreshSummaryInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return refreshChatSessionSummary(input);
  },
});

export const sessionReferenceAction = defineAction({
  name: 'neondeck_session_reference',
  description:
    'Read a compact cross-session reference payload from summary and metadata, auditing the context use.',
  input: sessionReferenceInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return referenceChatSession(input);
  },
});

export const sessionCreateAction = defineAction({
  name: 'neondeck_session_create',
  description:
    'Create a durable chat session metadata record for display-assistant and optionally switch a surface to it.',
  input: sessionCreateInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return createChatSession(input);
  },
});

export const sessionSwitchAction = defineAction({
  name: 'neondeck_session_switch',
  description:
    'Switch a dashboard/TUI surface to an existing non-archived display-assistant session.',
  input: sessionSwitchInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return switchChatSession(input);
  },
});

export const sessionRenameAction = defineAction({
  name: 'neondeck_session_rename',
  description: 'Rename a Neondeck chat session metadata record.',
  input: sessionRenameInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return renameChatSession(input);
  },
});

export const sessionPinAction = defineAction({
  name: 'neondeck_session_pin',
  description: 'Pin or unpin a Neondeck chat session.',
  input: sessionPinInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return pinChatSession(input);
  },
});

export const sessionArchiveAction = defineAction({
  name: 'neondeck_session_archive',
  description:
    'Archive a chat session metadata record. This does not delete Flue conversation history.',
  input: sessionArchiveInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return archiveChatSession(input);
  },
});

export const sessionRestoreAction = defineAction({
  name: 'neondeck_session_restore',
  description: 'Restore an archived chat session metadata record.',
  input: sessionArchiveInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return restoreChatSession(input);
  },
});

export const sessionLinkContextAction = defineAction({
  name: 'neondeck_session_link_context',
  description:
    'Attach repo, watch, task, UI metadata, or a summary to a chat session metadata record.',
  input: sessionLinkContextInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return linkChatSessionContext(input);
  },
});

export const sessionStatusAction = defineAction({
  name: 'neondeck_session_status',
  description:
    'Read the active Neon display-assistant session id and whether config or memory changes make its context stale.',
  input: v.object({ surface: v.optional(surfaceSchema) }),
  output: sessionActionOutputSchema,
  async run({ input }) {
    const state = await readNeonSessionState(undefined, input.surface);
    return {
      ok: true,
      action: 'session_status',
      changed: false,
      message: state.stale
        ? 'Active Neon session context is stale. Start or switch to a fresh session to reload config, skills, and memory context.'
        : 'Active Neon session context is current.',
      state,
    };
  },
});

export const sessionStartAction = defineAction({
  name: 'neondeck_session_start',
  description:
    'Compatibility action for starting and activating a new Neon display-assistant session.',
  input: legacySessionStartInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return startNeonSession(input);
  },
});

export const neondeckSessionActions = [
  sessionListAction,
  sessionSearchAction,
  sessionReadAction,
  sessionMessagesAction,
  sessionRefreshSummaryAction,
  sessionReferenceAction,
  sessionCreateAction,
  sessionSwitchAction,
  sessionRenameAction,
  sessionPinAction,
  sessionArchiveAction,
  sessionRestoreAction,
  sessionLinkContextAction,
  sessionStatusAction,
  sessionStartAction,
];

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

export async function refreshChatSessionSummary(
  input: v.InferInput<typeof sessionRefreshSummaryInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionRefreshSummaryInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult(
      'session_refresh_summary',
      v.summarize(parsed.issues),
    );
  }

  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let session: ChatSessionRecord | undefined;

  try {
    database.exec('BEGIN;');
    const before = findChatSession(database, parsed.output.id);
    if (!before) {
      database.exec('ROLLBACK;');
      return failedSessionResult(
        'session_refresh_summary',
        `Session ${parsed.output.id} was not found.`,
      );
    }

    const providedSummary = parsed.output.providedSummary?.trim();
    const summary = providedSummary || buildMetadataSummary(before);
    const source = providedSummary
      ? (parsed.output.source ?? 'agent')
      : 'metadata';
    const note = providedSummary
      ? 'Stored explicitly provided compact summary.'
      : 'Generated from session metadata, links, and stale-context badges because raw transcript paging is not available.';

    database
      .prepare(
        `
        UPDATE chat_sessions
        SET
          summary = ?,
          summary_generated_at = ?,
          summary_source = ?,
          summary_refresh_note = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(summary, now, source, note, now, before.id);
    recordSessionAudit(database, {
      action: 'summary_refresh',
      sessionId: before.id,
      surface: parsed.output.surface ?? null,
      reason: parsed.output.reason ?? null,
      metadata: { source },
    });
    database.exec('COMMIT;');
    session = findChatSession(database, before.id);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  if (session)
    publishSessionEvent('updated', session, parsed.output.surface ?? null);

  return {
    ok: true,
    action: 'session_refresh_summary',
    changed: true,
    message:
      'Refreshed chat session summary metadata. Raw Flue transcript history was not copied.',
    session,
  };
}

export async function referenceChatSession(
  input: v.InferInput<typeof sessionReferenceInputSchema>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(sessionReferenceInputSchema, input);
  if (!parsed.success) {
    return failedSessionResult('session_reference', v.summarize(parsed.issues));
  }
  if (
    parsed.output.includeRawTranscript &&
    !parsed.output.explicitUserRequest
  ) {
    return failedSessionResult(
      'session_reference',
      'Raw transcript access for a referenced session requires an explicit user request.',
      ['explicitUserRequest'],
    );
  }

  let target = await readChatSessionInternal(parsed.output.id, paths);
  if (!target) {
    return failedSessionResult(
      'session_reference',
      `Session ${parsed.output.id} was not found.`,
    );
  }

  let refreshedSummary = false;
  if (target.summaryStatus !== 'fresh') {
    const refreshed = await refreshChatSessionSummary(
      {
        id: target.id,
        reason: parsed.output.reason ?? 'cross-session-reference',
        surface: parsed.output.surface,
      },
      paths,
    );
    refreshedSummary = Boolean(refreshed.ok);
    target =
      (refreshed as { session?: ChatSessionRecord }).session ??
      (await readChatSessionInternal(parsed.output.id, paths)) ??
      target;
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const fromSession = parsed.output.fromSessionId
      ? findChatSession(database, parsed.output.fromSessionId)
      : undefined;
    recordSessionAudit(database, {
      action: 'reference',
      sessionId: target.id,
      surface: parsed.output.surface ?? null,
      reason: parsed.output.reason ?? null,
      metadata: {
        fromSessionId: fromSession?.id ?? parsed.output.fromSessionId ?? null,
        includeRawTranscript: parsed.output.includeRawTranscript ?? false,
        explicitUserRequest: parsed.output.explicitUserRequest ?? false,
        summaryStatus: target.summaryStatus,
      },
    });
  } finally {
    database.close();
  }

  return {
    ok: true,
    action: 'session_reference',
    changed: refreshedSummary,
    message:
      'Prepared cross-session reference from summary and metadata. Raw transcript pages were not read.',
    reference: {
      id: target.id,
      title: target.title,
      kind: target.kind,
      linkedRepoId: target.linkedRepoId,
      linkedWatchId: target.linkedWatchId,
      linkedTaskId: target.linkedTaskId,
      summary: target.summary,
      summaryGeneratedAt: target.summaryGeneratedAt,
      summarySource: target.summarySource,
      summaryStatus: target.summaryStatus,
      staleReasons: target.staleReasons,
      uiMetadata: target.uiMetadata,
      transcript: {
        requested: parsed.output.includeRawTranscript ?? false,
        available: false,
        owner: `display-assistant/${target.id}`,
        reason:
          'Neondeck has no stable Flue transcript paging adapter in this worktree.',
      },
    },
    session: target,
    fetchedAt: new Date().toISOString(),
  };
}

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

async function readChatSessionInternal(
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

function readActiveChatSession(database: DatabaseSync, surface: string) {
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

function readActiveSessionId(database: DatabaseSync, surface: string) {
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

function setActiveSession(
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

function findChatSession(database: DatabaseSync, id: string) {
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

function findLinkedChatSession(
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

function readChatSessionRow(
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

function markLoadedMemoriesUsed(
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

function recordSessionAudit(
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

function toNeonSessionRecord(
  session: ChatSessionRecord,
  activeSessionId: string,
): NeonSessionRecord {
  return {
    id: session.id,
    label: session.title,
    agentName: session.agentName,
    status:
      session.archivedAt || session.id !== activeSessionId
        ? 'archived'
        : 'active',
    reason:
      typeof session.uiMetadata === 'object' &&
      session.uiMetadata !== null &&
      !Array.isArray(session.uiMetadata) &&
      typeof session.uiMetadata.legacyReason === 'string'
        ? session.uiMetadata.legacyReason
        : null,
    createdAt: session.createdAt,
    activatedAt: session.lastActiveAt,
    endedAt: session.archivedAt,
    updatedAt: session.updatedAt,
  };
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

function buildMetadataSummary(session: ChatSessionRecord) {
  const links = [
    session.linkedRepoId ? `repo ${session.linkedRepoId}` : null,
    session.linkedWatchId ? `watch ${session.linkedWatchId}` : null,
    session.linkedTaskId ? `task ${session.linkedTaskId}` : null,
  ].filter(Boolean);
  const metadata = readableMetadata(session.uiMetadata);
  const stale = session.staleReasons
    .slice(0, 3)
    .map((reason) => `${reason.type}:${reason.target ?? 'runtime'}`)
    .join(', ');
  const parts = [
    `${session.title} is a ${session.kind} display-assistant session.`,
    links.length > 0 ? `Linked context: ${links.join(', ')}.` : null,
    metadata ? `Metadata: ${metadata}.` : null,
    stale ? `Stale context badges: ${stale}.` : null,
    `Created ${session.createdAt}; last active ${session.lastActiveAt}.`,
    'Transcript-derived summary is deferred until a stable Flue transcript paging adapter is available.',
  ].filter(Boolean);

  return parts.join(' ').slice(0, 2_000);
}

function readableMetadata(value: JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .filter(([, entry]) =>
      ['string', 'number', 'boolean'].includes(typeof entry),
    )
    .slice(0, 6)
    .map(([key, entry]) => `${key}=${String(entry)}`);
  return entries.length > 0 ? entries.join(', ') : null;
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

function publishSessionEvent(
  action: ChatSessionEventAction,
  session: ChatSessionRecord,
  surface: string | null,
) {
  publishChatSessionEvent({
    id: session.id,
    action,
    session,
    surface,
    changedAt: new Date().toISOString(),
  });
}

function failedSessionResult(
  action: string,
  message: string,
  requires?: string[],
) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    ...(requires ? { requires } : {}),
  };
}

function compactTimestamp(value: string) {
  return value.replace(/\D/g, '').slice(0, 14);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isFinite(value) || typeof value !== 'number';
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
