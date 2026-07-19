import { createHash, randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import type {
  AutomationExecutionResult,
  NotificationRecord,
} from '../app-state';
import {
  currentPrWatchEventWatermarkVersion,
  type PrWatchInitialWatermark,
} from '../watches';
export { currentPrWatchEventWatermarkVersion } from '../watches';
import type {
  PrWatchEventWatermarkCategory,
  PrWatchEventWatermarkRecord,
} from './schemas';
import {
  prEventJsonValueSchema,
  prWatchEventWatermarkCategoriesSchema,
  prWatchEventWatermarkCategorySchema,
  prWatchEventWatermarkRecordsSchema,
  watermarkCategories,
} from './schemas';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveSafeIntegerSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const nullableStringSchema = v.nullable(v.string());
const intakeRowSchema = v.strictObject({
  event_id: nonEmptyStringSchema,
  watch_id: nonEmptyStringSchema,
  event_generation_id: nonEmptyStringSchema,
  sequence: positiveSafeIntegerSchema,
  repo_full_name: nonEmptyStringSchema,
  pr_number: positiveSafeIntegerSchema,
  source: v.picklist(['watch']),
  initial_event: v.picklist([0, 1]),
  previous_watermarks_json: v.string(),
  candidate_watermarks_json: v.string(),
  changed_categories_json: v.string(),
  status: v.picklist(['pending', 'acknowledged', 'superseded']),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  acknowledged_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  outcome: v.nullable(
    v.picklist(['admission', 'notification', 'no-op', 'baseline-reset']),
  ),
  admission_id: nullableStringSchema,
  notification_id: nullableStringSchema,
  superseded_reason: nullableStringSchema,
});
const watermarkRowSchema = v.strictObject({
  watch_id: nonEmptyStringSchema,
  category: prWatchEventWatermarkCategorySchema,
  watermark_json: v.string(),
  source_updated_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  checked_at: v.pipe(v.string(), v.isoTimestamp()),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
});

export type PendingPrWatchEventIntake = {
  watchId: string;
  eventId: string;
  eventGenerationId: string;
  sequence: number;
  repoFullName: string;
  prNumber: number;
  source: 'watch';
  initialEvent: boolean;
  previousWatermarks: PrWatchEventWatermarkRecord[];
  candidateWatermarks: PrWatchEventWatermarkRecord[];
  changedCategories: PrWatchEventWatermarkCategory[];
  createdAt: string;
  updatedAt: string;
};

export function readPendingPrWatchEventIntake(
  paths: RuntimePaths,
  watchId: string,
): PendingPrWatchEventIntake | undefined {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT * FROM pr_watch_event_intakes
         WHERE watch_id = ? AND status = 'pending';`,
      )
      .get(watchId);
    return row ? readIntakeRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function stagePrWatchEventIntake(
  paths: RuntimePaths,
  input: {
    watchId: string;
    expectedEventGenerationId: string;
    repoFullName: string;
    prNumber: number;
    initialEvent: boolean;
    next: PrWatchInitialWatermark[];
  },
):
  | { kind: 'unchanged'; watermarks: PrWatchEventWatermarkRecord[] }
  | { kind: 'pending'; intake: PendingPrWatchEventIntake }
  | { kind: 'stale' } {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      if (
        !watchGenerationMatches(
          database,
          input.watchId,
          input.expectedEventGenerationId,
        )
      ) {
        rollbackQuietly(database);
        return { kind: 'stale' };
      }
      const pendingRow = database
        .prepare(
          `SELECT * FROM pr_watch_event_intakes
           WHERE watch_id = ? AND status = 'pending';`,
        )
        .get(input.watchId);
      if (pendingRow) {
        const intake = readIntakeRow(pendingRow);
        database.exec('COMMIT;');
        return { kind: 'pending', intake };
      }

      const previous = readWatermarksInTransaction(database, input.watchId);
      const candidate = candidateWatermarkRecords(
        input.watchId,
        input.next,
        previous,
        now,
      );
      const changedCategories = candidate
        .filter((item) => {
          const existing = previous.find(
            (record) => record.category === item.category,
          );
          return (
            stableJson(
              comparableWatermark(item.category, existing?.watermark),
            ) !== stableJson(comparableWatermark(item.category, item.watermark))
          );
        })
        .map((item) => item.category);
      if (changedCategories.length === 0) {
        database.exec('COMMIT;');
        return { kind: 'unchanged', watermarks: previous };
      }

      const sequenceRow = database
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
           FROM pr_watch_event_intakes WHERE watch_id = ?;`,
        )
        .get(input.watchId) as { next_sequence?: unknown } | undefined;
      const sequence = Number(sequenceRow?.next_sequence ?? 1);
      const eventId = prWatchEventSourceId(
        input.watchId,
        sequence,
        changedCategories,
        previous,
        candidate,
      );
      database
        .prepare(
          `INSERT INTO pr_watch_event_intakes (
             event_id, watch_id, event_generation_id, sequence, repo_full_name, pr_number, source, initial_event,
             previous_watermarks_json,
             candidate_watermarks_json, changed_categories_json,
             status, created_at, updated_at, acknowledged_at,
             outcome, admission_id, notification_id, superseded_reason
           ) VALUES (?, ?, ?, ?, ?, ?, 'watch', ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL);`,
        )
        .run(
          eventId,
          input.watchId,
          input.expectedEventGenerationId,
          sequence,
          input.repoFullName,
          input.prNumber,
          input.initialEvent ? 1 : 0,
          JSON.stringify(previous),
          JSON.stringify(candidate),
          JSON.stringify(changedCategories),
          now,
          now,
        );
      const row = database
        .prepare('SELECT * FROM pr_watch_event_intakes WHERE event_id = ?;')
        .get(eventId);
      if (!row)
        throw new Error('Staged PR event intake could not be read back.');
      const intake = readIntakeRow(row);
      if (intake.eventId !== eventId) {
        throw new Error(
          `A different pending PR event intake already exists for ${input.watchId}.`,
        );
      }
      database.exec('COMMIT;');
      return { kind: 'pending', intake };
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function acknowledgePrWatchEventIntake(
  paths: RuntimePaths,
  input: {
    watchId: string;
    eventId: string;
    markInitialProcessed?: boolean;
    outcome: 'admission' | 'notification' | 'no-op';
    admissionId?: string | null;
    notification?: NonNullable<
      AutomationExecutionResult['notifications']
    >[number];
  },
): {
  acknowledged: boolean;
  notification: NotificationRecord | null;
} {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const row = database
        .prepare(
          `SELECT * FROM pr_watch_event_intakes
           WHERE watch_id = ? AND event_id = ? AND status = 'pending';`,
        )
        .get(input.watchId, input.eventId);
      if (!row) {
        database.exec('COMMIT;');
        return { acknowledged: false, notification: null };
      }
      const intake = readIntakeRow(row);
      const notification = input.notification
        ? persistNotificationInTransaction(database, input.notification, now)
        : null;
      replaceWatermarksInTransaction(
        database,
        input.watchId,
        intake.candidateWatermarks,
        now,
      );
      const marker = input.markInitialProcessed ? now : null;
      const watchUpdated = database
        .prepare(
          `UPDATE pr_watches
           SET event_watermark_version = ?,
               initial_event_processed_at = CASE
                 WHEN ? IS NULL THEN initial_event_processed_at
                 ELSE COALESCE(initial_event_processed_at, ?)
               END,
               updated_at = CASE WHEN ? IS NULL THEN updated_at ELSE ? END
           WHERE id = ?;`,
        )
        .run(
          currentPrWatchEventWatermarkVersion,
          marker,
          marker,
          marker,
          marker,
          input.watchId,
        );
      if (watchUpdated.changes !== 1) {
        throw new Error(
          `PR event intake ${input.eventId} no longer has an active watch.`,
        );
      }
      const acknowledged =
        database
          .prepare(
            `UPDATE pr_watch_event_intakes
             SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?,
                 outcome = ?, admission_id = ?, notification_id = ?
             WHERE event_id = ? AND watch_id = ? AND status = 'pending';`,
          )
          .run(
            now,
            now,
            input.outcome,
            input.admissionId ?? null,
            notification?.id ?? null,
            input.eventId,
            input.watchId,
          ).changes === 1;
      if (!acknowledged) {
        throw new Error(
          `PR event intake ${input.eventId} lost its acknowledgement lease.`,
        );
      }
      database.exec('COMMIT;');
      return { acknowledged: true, notification };
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function installPrWatchEventBaseline(
  paths: RuntimePaths,
  input: {
    watchId: string;
    expectedEventGenerationId: string;
    nextEventGenerationId: string;
    watermarks: PrWatchInitialWatermark[];
    markInitialProcessed?: boolean;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      if (
        !watchGenerationMatches(
          database,
          input.watchId,
          input.expectedEventGenerationId,
        )
      ) {
        rollbackQuietly(database);
        return { installed: false as const };
      }
      const pending = database
        .prepare(
          `SELECT event_id FROM pr_watch_event_intakes
           WHERE watch_id = ? AND status = 'pending';`,
        )
        .get(input.watchId);
      if (pending) {
        throw new Error(
          `Cannot install a PR event baseline while ${input.watchId} has a pending intake.`,
        );
      }
      const previous = readWatermarksInTransaction(database, input.watchId);
      replaceWatermarksInTransaction(
        database,
        input.watchId,
        candidateWatermarkRecords(
          input.watchId,
          input.watermarks,
          previous,
          now,
        ),
        now,
      );
      const updated = database
        .prepare(
          `UPDATE pr_watches
           SET event_watermark_version = ?,
               event_generation_id = ?,
               initial_event_processed_at = CASE
                 WHEN ? = 1 THEN COALESCE(initial_event_processed_at, ?)
                 ELSE initial_event_processed_at
               END,
               updated_at = ?
           WHERE id = ? AND event_generation_id = ?;`,
        )
        .run(
          currentPrWatchEventWatermarkVersion,
          input.nextEventGenerationId,
          input.markInitialProcessed ? 1 : 0,
          now,
          now,
          input.watchId,
          input.expectedEventGenerationId,
        ).changes;
      if (updated !== 1) {
        rollbackQuietly(database);
        return { installed: false as const };
      }
      database.exec('COMMIT;');
      return { installed: true as const, installedAt: now };
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

function watchGenerationMatches(
  database: ReturnType<typeof openDb>,
  watchId: string,
  expectedEventGenerationId: string,
) {
  const row = database
    .prepare(
      `SELECT event_generation_id
       FROM pr_watches
       WHERE id = ?;`,
    )
    .get(watchId) as { event_generation_id?: unknown } | undefined;
  return row?.event_generation_id === expectedEventGenerationId;
}

export function prWatchEventSourceId(
  watchId: string,
  sequence: number,
  categories: PrWatchEventWatermarkCategory[],
  previousWatermarks: PrWatchEventWatermarkRecord[],
  watermarks: PrWatchEventWatermarkRecord[],
) {
  const payload = [...categories].sort().map((category) => ({
    category,
    previous: canonicalWatermark(previousWatermarks, category),
    candidate: canonicalWatermark(watermarks, category),
  }));
  const hash = createHash('sha256').update(stableJson(payload)).digest('hex');
  return `${watchId}:intake:${sequence}:${hash}`;
}

function canonicalWatermark(
  watermarks: PrWatchEventWatermarkRecord[],
  category: PrWatchEventWatermarkCategory,
) {
  const watermark = watermarks.find((item) => item.category === category);
  return {
    sourceUpdatedAt: watermark?.sourceUpdatedAt ?? null,
    watermark: watermark?.watermark ?? null,
  };
}

function candidateWatermarkRecords(
  watchId: string,
  next: PrWatchInitialWatermark[],
  previous: PrWatchEventWatermarkRecord[],
  now: string,
): PrWatchEventWatermarkRecord[] {
  return next.map((watermark) => {
    const existing = previous.find(
      (record) => record.category === watermark.category,
    );
    return {
      watchId,
      category: watermark.category as PrWatchEventWatermarkCategory,
      watermark: watermark.value,
      sourceUpdatedAt: watermark.sourceUpdatedAt,
      checkedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

function readWatermarksInTransaction(
  database: ReturnType<typeof openDb>,
  watchId: string,
) {
  return (
    database
      .prepare(
        `SELECT * FROM pr_watch_event_watermarks
         WHERE watch_id = ? ORDER BY category ASC;`,
      )
      .all(watchId) as Array<Record<string, unknown>>
  ).map(readWatermarkRow);
}

function replaceWatermarksInTransaction(
  database: ReturnType<typeof openDb>,
  watchId: string,
  watermarks: PrWatchEventWatermarkRecord[],
  now: string,
) {
  database
    .prepare('DELETE FROM pr_watch_event_watermarks WHERE watch_id = ?;')
    .run(watchId);
  const insert = database.prepare(
    `INSERT INTO pr_watch_event_watermarks (
       watch_id, category, watermark_json, source_updated_at,
       checked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
  );
  for (const watermark of watermarks) {
    insert.run(
      watchId,
      watermark.category,
      JSON.stringify(watermark.watermark),
      watermark.sourceUpdatedAt,
      now,
      watermark.createdAt,
      now,
    );
  }
}

function persistNotificationInTransaction(
  database: ReturnType<typeof openDb>,
  notification: NonNullable<AutomationExecutionResult['notifications']>[number],
  now: string,
): NotificationRecord | null {
  const source = notification.source ?? 'watch-pr-events';
  const sourceId = notification.sourceId ?? randomUUID();
  const existing = database
    .prepare(
      `SELECT id FROM notifications
       WHERE source = ? AND source_id = ? AND resolved_at IS NULL LIMIT 1;`,
    )
    .get(source, sourceId);
  if (existing) return null;
  const id = randomUUID();
  const data =
    notification.data === undefined ? null : asJsonValue(notification.data);
  database
    .prepare(
      `INSERT INTO notifications (
         id, level, title, message, source, source_id, data_json,
         read_at, resolved_at, occurrence_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?);`,
    )
    .run(
      id,
      notification.level,
      notification.title,
      notification.message,
      source,
      sourceId,
      data === null ? null : JSON.stringify(data),
      now,
      now,
    );
  return {
    id,
    level: notification.level,
    title: notification.title,
    message: notification.message,
    source,
    sourceId,
    data,
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function readIntakeRow(row: unknown): PendingPrWatchEventIntake {
  const record = parsePersistedValue(
    intakeRowSchema,
    row,
    'PR event intake row',
  );
  if (
    record.status !== 'pending' ||
    record.acknowledged_at !== null ||
    record.outcome !== null ||
    record.admission_id !== null ||
    record.notification_id !== null ||
    record.superseded_reason !== null
  ) {
    throw new Error(
      `Invalid pending PR event intake ${record.event_id}: pending outcome fields must be null.`,
    );
  }
  const previousWatermarks = parsePersistedJson(
    prWatchEventWatermarkRecordsSchema,
    record.previous_watermarks_json,
    'previous watermarks',
  );
  const candidateWatermarks = parsePersistedJson(
    prWatchEventWatermarkRecordsSchema,
    record.candidate_watermarks_json,
    'candidate watermarks',
  );
  const changedCategories = parsePersistedJson(
    prWatchEventWatermarkCategoriesSchema,
    record.changed_categories_json,
    'changed categories',
  );
  validatePendingIntakePayload(
    {
      watchId: record.watch_id,
      eventId: record.event_id,
      sequence: record.sequence,
      initialEvent: record.initial_event === 1,
    },
    {
      previousWatermarks,
      candidateWatermarks,
      changedCategories,
    },
  );
  return {
    watchId: record.watch_id,
    eventId: record.event_id,
    eventGenerationId: record.event_generation_id,
    sequence: record.sequence,
    repoFullName: record.repo_full_name,
    prNumber: record.pr_number,
    source: record.source,
    initialEvent: record.initial_event === 1,
    previousWatermarks,
    candidateWatermarks,
    changedCategories,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function readWatermarkRow(
  record: Record<string, unknown>,
): PrWatchEventWatermarkRecord {
  const parsed = parsePersistedValue(
    watermarkRowSchema,
    record,
    'PR event watermark row',
  );
  return {
    watchId: parsed.watch_id,
    category: parsed.category,
    watermark: parsePersistedJson(
      prEventJsonValueSchema,
      parsed.watermark_json,
      'watermark JSON',
    ),
    sourceUpdatedAt: parsed.source_updated_at,
    checkedAt: parsed.checked_at,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

function validatePendingIntakePayload(
  intake: {
    watchId: string;
    eventId: string;
    sequence: number;
    initialEvent: boolean;
  },
  payload: {
    previousWatermarks: PrWatchEventWatermarkRecord[];
    candidateWatermarks: PrWatchEventWatermarkRecord[];
    changedCategories: PrWatchEventWatermarkCategory[];
  },
) {
  for (const watermark of [
    ...payload.previousWatermarks,
    ...payload.candidateWatermarks,
  ]) {
    if (watermark.watchId !== intake.watchId) {
      throw new Error(
        `Invalid pending PR event intake for ${intake.watchId}: watermark watch id ${watermark.watchId} does not match.`,
      );
    }
  }
  assertUniqueCategories(
    payload.previousWatermarks.map((watermark) => watermark.category),
    'previous watermarks',
  );
  assertUniqueCategories(
    payload.candidateWatermarks.map((watermark) => watermark.category),
    'candidate watermarks',
  );
  assertUniqueCategories(payload.changedCategories, 'changed categories');
  const candidateCategories = payload.candidateWatermarks.map(
    (watermark) => watermark.category,
  );
  if (!equalCategorySets(candidateCategories, [...watermarkCategories])) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: candidate watermarks must contain every category exactly once.`,
    );
  }
  const previousCategories = payload.previousWatermarks.map(
    (watermark) => watermark.category,
  );
  if (
    previousCategories.length > 0 &&
    !equalCategorySets(previousCategories, [...watermarkCategories])
  ) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: previous watermarks must be empty or contain every category exactly once.`,
    );
  }
  if (intake.initialEvent && payload.previousWatermarks.length > 0) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: an initial event must start from an empty acknowledged baseline.`,
    );
  }
  if (!intake.initialEvent && payload.previousWatermarks.length === 0) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: a non-initial event must start from a complete acknowledged baseline.`,
    );
  }
  if (payload.changedCategories.length === 0) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: changed categories must not be empty.`,
    );
  }
  const actualChangedCategories = payload.candidateWatermarks
    .filter((candidate) => {
      const previous = payload.previousWatermarks.find(
        (watermark) => watermark.category === candidate.category,
      );
      return (
        stableJson(
          comparableWatermark(candidate.category, previous?.watermark),
        ) !==
        stableJson(comparableWatermark(candidate.category, candidate.watermark))
      );
    })
    .map((watermark) => watermark.category);
  if (!equalCategorySets(payload.changedCategories, actualChangedCategories)) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: stored changed categories do not match the candidate watermark transition.`,
    );
  }
  const expectedEventId = prWatchEventSourceId(
    intake.watchId,
    intake.sequence,
    payload.changedCategories,
    payload.previousWatermarks,
    payload.candidateWatermarks,
  );
  if (intake.eventId !== expectedEventId) {
    throw new Error(
      `Invalid pending PR event intake for ${intake.watchId}: event id does not match the persisted watermark transition.`,
    );
  }
}

function assertUniqueCategories(
  categories: PrWatchEventWatermarkCategory[],
  label: string,
) {
  if (new Set(categories).size !== categories.length) {
    throw new Error(`Invalid PR event intake ${label}: duplicate categories.`);
  }
}

function equalCategorySets(
  left: readonly PrWatchEventWatermarkCategory[],
  right: readonly PrWatchEventWatermarkCategory[],
) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((category, index) => category === sortedRight[index])
  );
}

function parsePersistedJson<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: string, label: string): v.InferOutput<TSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid PR event intake ${label}: malformed JSON.`);
  }
  return parsePersistedValue(schema, decoded, `PR event intake ${label}`);
}

function parsePersistedValue<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: unknown, label: string): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) {
    throw new Error(`Invalid ${label}: ${v.summarize(parsed.issues)}`);
  }
  return parsed.output;
}

function comparableWatermark(category: string, value: unknown) {
  if (category !== 'mergeability') return value ?? null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value ?? null;
  }
  const record = value as Record<string, unknown>;
  return {
    state: record.state,
    draft: typeof record.draft === 'boolean' ? record.draft : false,
    merged: record.merged,
    mergeable: record.mergeable,
    mergeableState: record.mergeableState,
    mergeCommitSha: record.mergeCommitSha,
    headSha: record.headSha,
    baseSha: record.baseSha,
  };
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}
