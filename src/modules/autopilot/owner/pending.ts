import { randomUUID } from 'node:crypto';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import { runtimePaths, type ThinkingLevel } from '../../../runtime-home';
import type { PrWatch } from '../../watches';
import type { AutopilotOwnerEnvelope } from './envelope';

export type AutopilotOwnerTurnSource = 'watch-event' | 'direct-human';

export type PreparedAutopilotOwnerContext = {
  schema: 'neondeck.autopilot-owner-prepared.v1';
  model: string;
  thinkingLevel: ThinkingLevel;
  instructions: string;
  workspaceContext: { path: string; home: string } | null;
  capabilities: string[];
  watch: PrWatch;
};

export type PendingAutopilotTurn = {
  approvedRevisionKey?: string;
  correlationId?: string;
  envelope?: AutopilotOwnerEnvelope;
  eventFingerprint?: string;
  idempotencyKey?: string;
  instanceId: string;
  learningMemoryAvailable: boolean;
  learningMemoryLoaded: boolean;
  learningMemoryIds: string[];
  learningMemoryText: string | null;
  messageBody?: string;
  mode: PrWatch['autopilotMode'];
  prepared?: PreparedAutopilotOwnerContext;
  settling: boolean;
  source: AutopilotOwnerTurnSource;
  status: 'reserved' | 'admitted' | 'settling' | 'settled';
  turnId: string;
  watchId: string;
};

export function registerPendingAutopilotTurn(
  home: string,
  instanceId: string,
  eventFingerprint: string | undefined,
  mode: PrWatch['autopilotMode'],
  source: AutopilotOwnerTurnSource,
  approvedRevisionKey?: string,
  options: {
    envelope?: AutopilotOwnerEnvelope;
    idempotencyKey?: string;
    messageBody?: string;
    prepared?: PreparedAutopilotOwnerContext;
    turnId?: string;
    watchId?: string;
  } = {},
) {
  const paths = runtimePaths(home);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  const turnId = options.turnId ?? randomUUID();
  const watchId = options.watchId ?? options.envelope?.watchId ?? instanceId;
  try {
    return withImmediateTransaction(database, () => {
      if (eventFingerprint) {
        const existing = database
          .prepare(
            `SELECT * FROM autopilot_owner_turns WHERE instance_id = ? AND event_fingerprint = ? AND status IN ('reserved', 'admitted', 'settling') LIMIT 1;`,
          )
          .get(instanceId, eventFingerprint);
        if (existing) return readTurnRow(existing);
      }
      if (options.idempotencyKey) {
        const existing = database
          .prepare(
            `SELECT * FROM autopilot_owner_turns WHERE instance_id = ? AND idempotency_key = ? LIMIT 1;`,
          )
          .get(instanceId, options.idempotencyKey);
        if (existing) return readTurnRow(existing);
      }
      database
        .prepare(
          `UPDATE autopilot_owner_turns SET status = 'settled', settled_at = ?, updated_at = ? WHERE instance_id = ? AND status IN ('reserved', 'admitted', 'settling');`,
        )
        .run(now, now, instanceId);
      database
        .prepare(
          `
        INSERT INTO autopilot_owner_turns (
          turn_id, instance_id, watch_id, source, mode, idempotency_key, event_fingerprint,
          approved_revision_key, envelope_json, message_body, prepared_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?);
        `,
        )
        .run(
          turnId,
          instanceId,
          watchId,
          source,
          mode,
          options.idempotencyKey ?? null,
          eventFingerprint ?? null,
          approvedRevisionKey ?? null,
          options.envelope ? JSON.stringify(options.envelope) : null,
          options.messageBody ?? null,
          options.prepared ? JSON.stringify(options.prepared) : null,
          now,
          now,
        );
      return readTurnById(database, turnId)!;
    });
  } finally {
    database.close();
  }
}

export function readPendingAutopilotTurn(home: string, instanceId: string) {
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT * FROM autopilot_owner_turns
        WHERE instance_id = ? AND status IN ('reserved', 'admitted', 'settling')
        ORDER BY created_at DESC LIMIT 1;
      `,
      )
      .get(instanceId);
    return row ? readTurnRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function listRecoverableAutopilotTurns(home: string) {
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    return database
      .prepare(
        `SELECT * FROM autopilot_owner_turns WHERE status IN ('reserved', 'admitted', 'settling') ORDER BY created_at ASC;`,
      )
      .all()
      .map(readTurnRow);
  } finally {
    database.close();
  }
}

export function readAutopilotTurnBySubmissionId(
  home: string,
  instanceId: string,
  submissionId: string,
) {
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    const row = database
      .prepare(
        `SELECT * FROM autopilot_owner_turns WHERE instance_id = ? AND submission_id = ? ORDER BY created_at DESC LIMIT 1;`,
      )
      .get(instanceId, submissionId);
    return row ? readTurnRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function resetSettlingAutopilotTurns(home: string) {
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE autopilot_owner_turns SET status = CASE WHEN submission_id IS NULL THEN 'reserved' ELSE 'admitted' END, updated_at = ? WHERE status = 'settling';`,
      )
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}

export function recordPendingAutopilotTurnPreparedContext(
  home: string,
  instanceId: string,
  turnId: string,
  prepared: PreparedAutopilotOwnerContext,
) {
  return updateTurn(home, instanceId, turnId, 'prepared_json = ?', [
    JSON.stringify(prepared),
  ]);
}

export function recordPendingAutopilotTurnLearningMemoryContext(
  home: string,
  instanceId: string,
  turnId: string,
  learningMemoryIds: string[],
  learningMemoryText: string,
  learningMemoryAvailable: boolean,
) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending || pending.turnId !== turnId) return null;
  if (pending.learningMemoryLoaded) return pending;
  return updateTurn(
    home,
    instanceId,
    turnId,
    `learning_memory_available = ?, learning_memory_loaded = 1, learning_memory_ids_json = ?, learning_memory_text = ?`,
    [
      learningMemoryAvailable ? 1 : 0,
      JSON.stringify([...new Set(learningMemoryIds)]),
      learningMemoryText,
    ],
  );
}

export function recordPendingAutopilotTurnCorrelationId(
  home: string,
  instanceId: string,
  turnId: string,
  correlationId: string,
) {
  if (!correlationId) return null;
  return updateTurn(
    home,
    instanceId,
    turnId,
    `submission_id = COALESCE(submission_id, ?), status = 'admitted', admitted_at = COALESCE(admitted_at, ?)`,
    [correlationId, new Date().toISOString()],
  );
}

export function recordPendingAutopilotTurnError(
  home: string,
  instanceId: string,
  turnId: string,
  error: string,
) {
  return updateTurn(home, instanceId, turnId, 'error = ?', [error]);
}

export function claimPendingAutopilotTurnSettlement(
  home: string,
  instanceId: string,
) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending || pending.settling) return null;
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    const changed = database
      .prepare(
        `UPDATE autopilot_owner_turns SET status = 'settling', updated_at = ? WHERE turn_id = ? AND status IN ('reserved', 'admitted');`,
      )
      .run(new Date().toISOString(), pending.turnId).changes;
    return changed === 1 ? readTurnById(database, pending.turnId) : null;
  } finally {
    database.close();
  }
}

export function clearPendingAutopilotTurn(home: string, instanceId: string) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending) return;
  settleTurn(home, pending.turnId);
}

export function clearPendingAutopilotTurnIfMatches(
  home: string,
  instanceId: string,
  turnId: string,
) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending || pending.turnId !== turnId) return false;
  settleTurn(home, turnId);
  return true;
}

export function resetPendingAutopilotTurnsForTests(home?: string) {
  if (!home) return;
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    database.prepare('DELETE FROM autopilot_owner_turns;').run();
  } finally {
    database.close();
  }
}

function updateTurn(
  home: string,
  instanceId: string,
  turnId: string,
  assignment: string,
  values: Array<string | number | null>,
) {
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    const changed = database
      .prepare(
        `UPDATE autopilot_owner_turns SET ${assignment}, updated_at = ? WHERE turn_id = ? AND instance_id = ? AND status IN ('reserved', 'admitted', 'settling');`,
      )
      .run(...values, new Date().toISOString(), turnId, instanceId).changes;
    return changed === 1 ? readTurnById(database, turnId) : null;
  } finally {
    database.close();
  }
}

function settleTurn(home: string, turnId: string) {
  const database = openDb(runtimePaths(home).neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE autopilot_owner_turns SET status = 'settled', settled_at = ?, updated_at = ? WHERE turn_id = ? AND status != 'settled';`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), turnId);
  } finally {
    database.close();
  }
}

function readTurnById(database: ReturnType<typeof openDb>, turnId: string) {
  const row = database
    .prepare('SELECT * FROM autopilot_owner_turns WHERE turn_id = ?;')
    .get(turnId);
  return row ? readTurnRow(row) : null;
}

function readTurnRow(row: unknown): PendingAutopilotTurn {
  const value = row as Record<string, unknown>;
  return {
    approvedRevisionKey:
      typeof value.approved_revision_key === 'string'
        ? value.approved_revision_key
        : undefined,
    correlationId:
      typeof value.submission_id === 'string' ? value.submission_id : undefined,
    envelope:
      typeof value.envelope_json === 'string'
        ? (JSON.parse(value.envelope_json) as AutopilotOwnerEnvelope)
        : undefined,
    eventFingerprint:
      typeof value.event_fingerprint === 'string'
        ? value.event_fingerprint
        : undefined,
    idempotencyKey:
      typeof value.idempotency_key === 'string'
        ? value.idempotency_key
        : undefined,
    instanceId: String(value.instance_id),
    learningMemoryAvailable: value.learning_memory_available === 1,
    learningMemoryLoaded: value.learning_memory_loaded === 1,
    learningMemoryIds:
      typeof value.learning_memory_ids_json === 'string'
        ? (JSON.parse(value.learning_memory_ids_json) as string[])
        : [],
    learningMemoryText:
      typeof value.learning_memory_text === 'string'
        ? value.learning_memory_text
        : null,
    messageBody:
      typeof value.message_body === 'string' ? value.message_body : undefined,
    mode: value.mode as PrWatch['autopilotMode'],
    prepared:
      typeof value.prepared_json === 'string'
        ? (JSON.parse(value.prepared_json) as PreparedAutopilotOwnerContext)
        : undefined,
    settling: value.status === 'settling',
    source: value.source as AutopilotOwnerTurnSource,
    status: value.status as PendingAutopilotTurn['status'],
    turnId: String(value.turn_id),
    watchId: String(value.watch_id),
  };
}
