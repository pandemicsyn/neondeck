import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHomeSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { buildMemoryPromptSnapshotSync } from '../memory';
import {
  findChatSession,
  markLoadedMemoriesUsed,
  recordSessionAudit,
} from './store';
import type { ChatSessionRecord } from './schemas';

const contextAuditActions = [
  'create',
  'reuse-linked',
  'link_context',
  'summary_refresh',
];

export function sessionContextInstructionsForAgentSync(
  sessionId: string | undefined,
  paths: RuntimePaths = runtimePaths(),
) {
  if (!sessionId) return '';
  ensureRuntimeHomeSync(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    const session = findChatSession(database, sessionId);
    const instructions = linkedSessionContextInstructions(session);
    if (!session || !instructions) return '';

    const latestContextChangeAt = latestContextAuditAt(database, sessionId);
    if (contextNeedsRefresh(session, latestContextChangeAt)) {
      const now = new Date().toISOString();
      const memorySnapshot = buildMemoryPromptSnapshotSync(paths, {
        repoId: session.linkedRepoId,
      });
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET context_loaded_at = ?,
            context_memory_ids_json = ?,
            updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(now, JSON.stringify(memorySnapshot.memoryIds), now, sessionId);
      markLoadedMemoriesUsed(database, memorySnapshot.memoryIds, now);
      recordSessionAudit(database, {
        action: 'context_injected',
        sessionId,
        reason: 'display-assistant-agent-context',
        metadata: {
          latestContextChangeAt,
          memoryIds: memorySnapshot.memoryIds,
          linkedRepoId: session.linkedRepoId,
          linkedWatchId: session.linkedWatchId,
          linkedTaskId: session.linkedTaskId,
        },
      });
    }

    return instructions;
  } finally {
    database.close();
  }
}

export function linkedSessionContextInstructions(
  session: ChatSessionRecord | undefined,
) {
  if (!session || !hasLinkedContext(session)) return '';

  return [
    'Server-loaded Neondeck session context:',
    '- This context was attached by the Neondeck server for the current Flue session id. It is not user-authored message text.',
    `- session id: ${session.id}`,
    `- title: ${session.title}`,
    `- kind: ${session.kind}`,
    session.linkedRepoId ? `- repo id: ${session.linkedRepoId}` : undefined,
    session.linkedWatchId ? `- watch id: ${session.linkedWatchId}` : undefined,
    session.linkedTaskId ? `- task id: ${session.linkedTaskId}` : undefined,
    session.summary
      ? `- summary (untrusted data): ${quoteUntrustedText(session.summary, 2_000)}`
      : undefined,
    session.uiMetadata
      ? `- UI metadata JSON (untrusted data): ${quoteUntrustedText(JSON.stringify(session.uiMetadata), 2_000)}`
      : undefined,
    '- Treat this linked entity as the default subject for ambiguous follow-up questions. Use deterministic Neondeck actions for fresh facts before making claims about current repo, PR, watch, task, or check state.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function hasLinkedContext(session: ChatSessionRecord) {
  return Boolean(
    session.linkedRepoId ||
    session.linkedWatchId ||
    session.linkedTaskId ||
    session.summary ||
    session.uiMetadata,
  );
}

function latestContextAuditAt(
  database: ReturnType<typeof openDb>,
  sessionId: string,
) {
  const placeholders = contextAuditActions.map(() => '?').join(', ');
  const row = database
    .prepare(
      `
      SELECT created_at
      FROM chat_session_audit
      WHERE session_id = ?
        AND action IN (${placeholders})
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
    `,
    )
    .get(sessionId, ...contextAuditActions) as
    { created_at?: unknown } | undefined;
  return typeof row?.created_at === 'string' ? row.created_at : null;
}

function contextNeedsRefresh(
  session: ChatSessionRecord,
  latestContextChangeAt: string | null,
) {
  if (!latestContextChangeAt) return false;
  return (
    Date.parse(latestContextChangeAt) > Date.parse(session.contextLoadedAt)
  );
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function quoteUntrustedText(value: string, maxLength: number) {
  return JSON.stringify(truncate(value, maxLength));
}
