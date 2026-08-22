import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import { runtimePaths, type ThinkingLevel } from '../../../runtime-home';
import type { PrWatch } from '../../watches';
import {
  parseAutopilotOwnerEnvelope,
  type AutopilotOwnerEnvelope,
} from './envelope';

export type AutopilotOwnerTurnSource = 'watch-event' | 'direct-human';

type PreparedAutopilotOwnerContextBase = {
  model: string;
  thinkingLevel: ThinkingLevel;
  instructions: string;
  workspaceContext: { path: string; home: string } | null;
  capabilities: string[];
  watch: PrWatch;
};

export type LegacyPreparedAutopilotOwnerContext =
  PreparedAutopilotOwnerContextBase & {
    schema: 'neondeck.autopilot-owner-prepared.v1';
  };

export type PreparedAutopilotOwnerContext =
  PreparedAutopilotOwnerContextBase & {
    schema: 'neondeck.autopilot-owner-prepared.v2';
    exploreModel: string;
    exploreThinkingLevel: ThinkingLevel;
  };

export type PersistedAutopilotOwnerContext =
  LegacyPreparedAutopilotOwnerContext | PreparedAutopilotOwnerContext;

export type PendingAutopilotTurn = {
  approvedRevisionKey?: string;
  correlationId?: string;
  envelope?: AutopilotOwnerEnvelope;
  error?: string;
  eventFingerprint?: string;
  idempotencyKey?: string;
  instanceId: string;
  learningMemoryAvailable: boolean;
  learningMemoryLoaded: boolean;
  learningMemoryIds: string[];
  learningMemoryText: string | null;
  messageBody?: string;
  mode: PrWatch['autopilotMode'];
  prepared?: PersistedAutopilotOwnerContext;
  settling: boolean;
  source: AutopilotOwnerTurnSource;
  status: 'reserved' | 'admitted' | 'settling' | 'settled';
  turnId: string;
  watchId: string;
};

const autopilotModeSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
]);
const turnSourceSchema = v.picklist(['watch-event', 'direct-human']);
const turnStatusSchema = v.picklist([
  'reserved',
  'admitted',
  'settling',
  'settled',
]);
const nullableStringSchema = v.nullable(v.string());
const pendingTurnExternalValueSchema = v.unknown();
type PendingTurnExternalValue = v.InferInput<
  typeof pendingTurnExternalValueSchema
>;
const storedTurnRowSchema = v.object({
  approved_revision_key: nullableStringSchema,
  submission_id: nullableStringSchema,
  envelope_json: nullableStringSchema,
  error: nullableStringSchema,
  event_fingerprint: nullableStringSchema,
  idempotency_key: nullableStringSchema,
  instance_id: v.string(),
  learning_memory_available: v.number(),
  learning_memory_loaded: v.number(),
  learning_memory_ids_json: nullableStringSchema,
  learning_memory_text: nullableStringSchema,
  message_body: nullableStringSchema,
  mode: autopilotModeSchema,
  prepared_json: nullableStringSchema,
  source: turnSourceSchema,
  status: turnStatusSchema,
  turn_id: v.string(),
  watch_id: v.string(),
});
const storedTurnIdentitySchema = v.object({ turn_id: v.string() });
const storedTurnFenceSchema = v.object({
  created_at: v.string(),
  status: turnStatusSchema,
  turn_id: v.string(),
});
const malformedTurnFenceMs = 60 * 60_000;

const persistedSnapshotSchema = v.nullable(
  v.custom<NonNullable<PrWatch['lastSnapshot']>>(
    (value) =>
      v.safeParse(
        v.object({
          state: v.string(),
          merged: v.boolean(),
          mergeCommitSha: nullableStringSchema,
          checks: v.nullable(v.unknown()),
          title: v.string(),
          url: v.string(),
          updatedAt: v.string(),
          headSha: v.string(),
          baseRef: v.string(),
        }),
        value,
      ).success,
    'Stored PR snapshot is malformed.',
  ),
);

const persistedWatchSchema = v.object({
  id: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  githubOwner: v.string(),
  githubName: v.string(),
  prNumber: v.number(),
  desiredTerminalState: v.picklist(['checks', 'merged']),
  status: v.picklist([
    'watching',
    'ready',
    'merged',
    'closed',
    'green',
    'attention-needed',
    'unknown',
  ]),
  prState: nullableStringSchema,
  title: nullableStringSchema,
  url: nullableStringSchema,
  mergeCommitSha: nullableStringSchema,
  lastSnapshot: persistedSnapshotSchema,
  lastOutcome: v.nullable(
    v.picklist(['created', 'updated', 'removed', 'silent']),
  ),
  lastCheckedAt: nullableStringSchema,
  createdBy: nullableStringSchema,
  processExisting: v.boolean(),
  initialEventProcessedAt: nullableStringSchema,
  eventWatermarkVersion: v.number(),
  autopilotMode: autopilotModeSchema,
  autopilotStatus: v.picklist([
    'watching',
    'working',
    'waiting',
    'blocked',
    'stopping',
    'complete',
  ]),
  ownerInstanceId: nullableStringSchema,
  worktreeId: nullableStringSchema,
  lastEventFingerprint: nullableStringSchema,
  createdAt: v.string(),
  updatedAt: v.string(),
});

const persistedPreparedContextSchema = v.union([
  v.object({
    schema: v.literal('neondeck.autopilot-owner-prepared.v1'),
    model: v.string(),
    thinkingLevel: v.picklist([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]),
    instructions: v.string(),
    workspaceContext: v.nullable(
      v.object({ path: v.string(), home: v.string() }),
    ),
    capabilities: v.array(v.string()),
    watch: persistedWatchSchema,
  }),
  v.object({
    schema: v.literal('neondeck.autopilot-owner-prepared.v2'),
    model: v.string(),
    thinkingLevel: v.picklist([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]),
    instructions: v.string(),
    workspaceContext: v.nullable(
      v.object({ path: v.string(), home: v.string() }),
    ),
    capabilities: v.array(v.string()),
    watch: persistedWatchSchema,
    exploreModel: v.string(),
    exploreThinkingLevel: v.picklist([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]),
  }),
]);

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
        const existingTurn = tryReadTurnRow(existing);
        if (existingTurn) return existingTurn;
        preserveRecentMalformedTurnFence(existing, now);
        quarantineMalformedTurn(database, existing, now);
      }
      if (options.idempotencyKey) {
        const existing = database
          .prepare(
            `SELECT * FROM autopilot_owner_turns WHERE instance_id = ? AND idempotency_key = ? LIMIT 1;`,
          )
          .get(instanceId, options.idempotencyKey);
        const existingTurn = tryReadTurnRow(existing);
        if (existingTurn) return existingTurn;
        preserveRecentMalformedTurnFence(existing, now);
        quarantineMalformedTurn(database, existing, now);
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
    return tryReadTurnRow(row);
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
      .flatMap(safeReadTurnRow);
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
    return tryReadTurnRow(row);
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
  return updateTurn(
    home,
    instanceId,
    turnId,
    'prepared_json = ?, error = NULL',
    [JSON.stringify(prepared)],
  );
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
  return tryReadTurnRow(row) ?? null;
}

function readTurnRow(
  row: v.InferOutput<typeof storedTurnRowSchema>,
): PendingAutopilotTurn {
  const envelope = row.envelope_json
    ? parseAutopilotOwnerEnvelope(row.envelope_json)
    : undefined;
  const learningMemoryIds = row.learning_memory_ids_json
    ? v
        .parse(v.array(v.unknown()), JSON.parse(row.learning_memory_ids_json))
        .flatMap((item) => {
          const id = v.safeParse(v.string(), item);
          return id.success ? [id.output] : [];
        })
    : [];
  const prepared = row.prepared_json
    ? v.parse(persistedPreparedContextSchema, JSON.parse(row.prepared_json))
    : undefined;
  return {
    approvedRevisionKey: row.approved_revision_key ?? undefined,
    correlationId: row.submission_id ?? undefined,
    envelope,
    error: row.error ?? undefined,
    eventFingerprint: row.event_fingerprint ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    instanceId: row.instance_id,
    learningMemoryAvailable: row.learning_memory_available === 1,
    learningMemoryLoaded: row.learning_memory_loaded === 1,
    learningMemoryIds,
    learningMemoryText: row.learning_memory_text,
    messageBody: row.message_body ?? undefined,
    mode: row.mode,
    prepared,
    settling: row.status === 'settling',
    source: row.source,
    status: row.status,
    turnId: row.turn_id,
    watchId: row.watch_id,
  };
}

function safeReadTurnRow(
  row: Record<string, SQLOutputValue>,
): PendingAutopilotTurn[] {
  const turn = tryReadTurnRow(row);
  return turn ? [turn] : [];
}

function tryReadTurnRow(
  row: PendingTurnExternalValue,
): PendingAutopilotTurn | undefined {
  try {
    return readTurnRow(v.parse(storedTurnRowSchema, row));
  } catch {
    // A persisted recovery row is advisory. Skip a malformed legacy row so it
    // cannot prevent the scheduler from recovering other pending turns.
    return undefined;
  }
}

function quarantineMalformedTurn(
  database: ReturnType<typeof openDb>,
  row: PendingTurnExternalValue,
  now: string,
) {
  const identity = v.safeParse(storedTurnIdentitySchema, row);
  if (!identity.success) return;
  database
    .prepare(
      `UPDATE autopilot_owner_turns
       SET status = 'settled',
           idempotency_key = NULL,
           event_fingerprint = NULL,
           settled_at = ?,
           error = COALESCE(error, 'Malformed persisted owner turn was quarantined.'),
           updated_at = ?
       WHERE turn_id = ?;`,
    )
    .run(now, now, identity.output.turn_id);
}

function preserveRecentMalformedTurnFence(
  row: PendingTurnExternalValue,
  now: string,
) {
  const fence = v.safeParse(storedTurnFenceSchema, row);
  if (!fence.success || fence.output.status === 'settled') return;
  const createdAt = Date.parse(fence.output.created_at);
  const currentTime = Date.parse(now);
  if (
    Number.isFinite(createdAt) &&
    Number.isFinite(currentTime) &&
    currentTime - createdAt >= malformedTurnFenceMs
  ) {
    return;
  }
  throw new Error(
    `Autopilot owner turn ${fence.output.turn_id} is malformed but may still be active; refusing a duplicate reservation.`,
  );
}
