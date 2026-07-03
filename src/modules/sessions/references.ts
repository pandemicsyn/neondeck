import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { failedSessionResult } from './utils';
import { refreshChatSessionSummary } from './summaries';
import {
  findChatSession,
  readChatSessionInternal,
  recordSessionAudit,
} from './store';
import { sessionReferenceInputSchema, type ChatSessionRecord } from './schemas';

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
