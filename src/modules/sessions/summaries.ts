import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { failedSessionResult } from './utils';
import { publishSessionEvent } from './events';
import { findChatSession, recordSessionAudit } from './store';
import {
  sessionRefreshSummaryInputSchema,
  type ChatSessionRecord,
} from './schemas';

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
