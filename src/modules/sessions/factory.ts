import type { DatabaseSync } from 'node:sqlite';
import { readChatSessionRow, recordSessionAudit } from './store';

/** Called only by the factory service inside the binding transaction. Never
 * exposed as an arbitrary agent/session registration API. */
export function registerFactoryPlannerSession(
  db: DatabaseSync,
  input: {
    sessionId: string;
    workId: string;
    repoId: string | null;
    title: string;
    capturedAt: string;
    memoryIds: string[];
  },
) {
  const prior = findFactorySession(db, input.sessionId);
  if (prior) {
    if (
      prior.agentName !== 'factory-planner' ||
      prior.linkedTaskId !== input.workId
    )
      throw new Error('Factory planner session binding mismatch.');
    return prior;
  }
  db.prepare(
    `INSERT INTO chat_sessions
    (id,title,agent_name,kind,pinned,linked_repo_id,linked_task_id,context_loaded_at,context_memory_ids_json,created_at,updated_at,last_active_at)
    VALUES (?,?,'factory-planner','task',0,?,?,?,?,?,?,?)`,
  ).run(
    input.sessionId,
    input.title,
    input.repoId,
    input.workId,
    input.capturedAt,
    JSON.stringify(input.memoryIds),
    input.capturedAt,
    input.capturedAt,
    input.capturedAt,
  );
  recordSessionAudit(db, {
    action: 'factory-planner-created',
    sessionId: input.sessionId,
    metadata: { workId: input.workId },
  });
  return findFactorySession(db, input.sessionId)!;
}
export function readFactoryPlannerSession(
  db: DatabaseSync,
  sessionId: string,
  workId: string,
) {
  const session = findFactorySession(db, sessionId);
  if (
    !session ||
    session.agentName !== 'factory-planner' ||
    session.kind !== 'task' ||
    session.linkedTaskId !== workId
  )
    throw new Error('Factory planner session binding mismatch.');
  return session;
}

function findFactorySession(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id);
  return row ? readChatSessionRow(row, db) : undefined;
}
