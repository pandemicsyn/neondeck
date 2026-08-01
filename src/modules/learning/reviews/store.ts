import { openDb, withImmediateTransaction } from '../../../lib/sqlite.ts';
import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { runtimePaths, type RuntimePaths } from '../../../runtime-home';
import type {
  LearningReviewKind,
  LearningReviewRecord,
  LearningReviewStatus,
  PreparedLearningReview,
} from './schemas';
import { preparedLearningReviewSchema } from './schemas';

export function listLearningReviews(
  input: {
    kind?: LearningReviewKind;
    status?: LearningReviewStatus;
    limit?: number;
  } = {},
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const filters = [];
    const params: Array<string | number> = [];
    if (input.kind) {
      filters.push('kind = ?');
      params.push(input.kind);
    }
    if (input.status) {
      filters.push('status = ?');
      params.push(input.status);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return {
      ok: true,
      action: 'learning_review_list',
      changed: false,
      reviews: database
        .prepare(
          `
          SELECT *
          FROM learning_reviews
          ${where}
          ORDER BY started_at DESC
          LIMIT ?;
        `,
        )
        .all(...params, input.limit ?? 50)
        .map(readLearningReviewRow),
    };
  } finally {
    database.close();
  }
}

export function startLearningReview(
  input: {
    id?: string;
    kind: LearningReviewKind;
    model: string;
    thinkingLevel: string;
    trigger: JsonValue;
    inputSummary: JsonValue;
  },
  paths = runtimePaths(),
) {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    withImmediateTransaction(database, () => {
      const insert = database
        .prepare(
          `
        INSERT INTO learning_reviews (
          id,
          kind,
          status,
          model,
          thinking_level,
          trigger_json,
          input_summary_json,
          started_at
        )
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING;
      `,
        )
        .run(
          id,
          input.kind,
          input.model,
          input.thinkingLevel,
          JSON.stringify(input.trigger),
          JSON.stringify(input.inputSummary),
          now,
        );
      if (insert.changes === 0) return;
      recordLearningEventInDatabase(database, {
        type:
          input.kind === 'conversation'
            ? 'reflection_started'
            : input.kind === 'curation'
              ? 'curation_started'
              : 'pr_retrospective_started',
        source: 'learning-review-agent',
        data: { reviewId: id },
        createdAt: now,
      });
    });
  } finally {
    database.close();
  }
  return id;
}

export type LearningReviewAdmissionIntent = {
  id: string;
  kind: LearningReviewKind;
  sessionId: string | null;
  input: Record<string, unknown>;
  status: 'pending' | 'processing' | 'admitted';
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function insertLearningReviewAdmissionIntent(
  database: DatabaseSync,
  input: {
    id?: string;
    kind: LearningReviewKind;
    sessionId?: string | null;
    reviewInput: Record<string, unknown>;
    createdAt: string;
  },
) {
  const id = input.id ?? randomUUID();
  database
    .prepare(
      `
      INSERT INTO learning_review_admissions (
        id, kind, session_id, input_json, status, error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?);
    `,
    )
    .run(
      id,
      input.kind,
      input.sessionId ?? null,
      JSON.stringify(input.reviewInput),
      input.createdAt,
      input.createdAt,
    );
  return id;
}

export function listPendingLearningReviewAdmissionIntents(
  paths = runtimePaths(),
  sessionId?: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM learning_review_admissions
        WHERE status != 'admitted'
          ${sessionId ? 'AND session_id = ?' : ''}
        ORDER BY created_at ASC;
      `,
      )
      .all(...(sessionId ? [sessionId] : []))
      .map(readLearningReviewAdmissionIntentRow);
  } finally {
    database.close();
  }
}

export function claimLearningReviewAdmissionIntent(
  id: string,
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return (
      database
        .prepare(
          `UPDATE learning_review_admissions SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending';`,
        )
        .run(new Date().toISOString(), id).changes === 1
    );
  } finally {
    database.close();
  }
}

export function resetProcessingLearningReviewAdmissionIntents(
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE learning_review_admissions SET status = 'pending', updated_at = ? WHERE status = 'processing';`,
      )
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}

export function markLearningReviewAdmissionIntentAdmitted(
  id: string,
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE learning_review_admissions SET status = 'admitted', error = NULL, updated_at = ? WHERE id = ?;`,
      )
      .run(new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export function recordLearningReviewAdmissionIntentError(
  id: string,
  error: string,
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE learning_review_admissions SET status = 'pending', error = ?, updated_at = ? WHERE id = ? AND status != 'admitted';`,
      )
      .run(error, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

export function completeLearningReview(
  id: string,
  result: JsonValue,
  paths = runtimePaths(),
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    withImmediateTransaction(database, () => {
      const review = readLearningReviewById(database, id);
      const update = database
        .prepare(
          `
        UPDATE learning_reviews
        SET status = 'completed',
          result_json = ?,
          error = NULL,
          completed_at = ?
        WHERE id = ? AND status = 'running';
      `,
        )
        .run(JSON.stringify(result), now, id);
      if (update.changes === 0) return;
      recordLearningEventInDatabase(database, {
        type:
          review?.kind === 'conversation'
            ? 'reflection_completed'
            : review?.kind === 'curation'
              ? 'memory_curated'
              : 'pr_retrospective_completed',
        source: 'learning-review-agent',
        data: { reviewId: id, result },
        createdAt: now,
      });
    });
  } finally {
    database.close();
  }
}

export function failLearningReview(
  id: string,
  message: string,
  paths = runtimePaths(),
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    withImmediateTransaction(database, () => {
      const review = readLearningReviewById(database, id);
      const update = database
        .prepare(
          `
        UPDATE learning_reviews
        SET status = 'failed',
          error = ?,
          completed_at = ?
        WHERE id = ? AND status = 'running';
      `,
        )
        .run(message, now, id);
      if (update.changes === 0) return;
      recordLearningEventInDatabase(database, {
        type:
          review?.kind === 'conversation'
            ? 'reflection_failed'
            : review?.kind === 'curation'
              ? 'curation_failed'
              : 'pr_retrospective_failed',
        source: 'learning-review-agent',
        data: { reviewId: id, error: message },
        createdAt: now,
      });
    });
  } finally {
    database.close();
  }
}

export function persistPreparedLearningReview(
  prepared: PreparedLearningReview,
  agentId: string,
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const update = database
      .prepare(
        `
        UPDATE learning_reviews
        SET agent_id = ?,
          prepared_json = ?,
          dispatch_error = NULL
        WHERE id = ? AND status = 'running';
      `,
      )
      .run(agentId, JSON.stringify(prepared), prepared.reviewId);
    if (update.changes !== 1) {
      throw new Error(
        `Learning review "${prepared.reviewId}" is not available for admission.`,
      );
    }
  } finally {
    database.close();
  }
}

export function attachLearningReviewSubmission(
  input: {
    reviewId: string;
    submissionId: string;
  },
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE learning_reviews
        SET submission_id = ?, dispatch_error = NULL
        WHERE id = ?;
      `,
      )
      .run(input.submissionId, input.reviewId);
  } finally {
    database.close();
  }
}

export function recordLearningReviewDispatchError(
  reviewId: string,
  error: string,
  paths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE learning_reviews SET dispatch_error = ? WHERE id = ? AND status = 'running';`,
      )
      .run(error, reviewId);
  } finally {
    database.close();
  }
}

export function listRecoverableLearningReviews(paths = runtimePaths()) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `SELECT * FROM learning_reviews WHERE status = 'running' AND prepared_json IS NOT NULL ORDER BY started_at ASC;`,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        const parsed = v.safeParse(
          preparedLearningReviewSchema,
          parseNullableJson(record.prepared_json),
        );
        if (!parsed.success) {
          throw new Error(
            `Learning review "${String(record.id)}" has an invalid prepared snapshot: ${v.summarize(parsed.issues)}`,
          );
        }
        return {
          review: readLearningReviewRow(row),
          prepared: parsed.output as PreparedLearningReview,
        };
      });
  } finally {
    database.close();
  }
}

export function recordLearningEvent(
  paths: RuntimePaths,
  input: {
    type: string;
    source: string;
    sessionId?: string | null;
    repoId?: string | null;
    data?: JsonValue | null;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    recordLearningEventInDatabase(database, {
      ...input,
      createdAt: new Date().toISOString(),
    });
  } finally {
    database.close();
  }
}

export function recordLearningEventInDatabase(
  database: DatabaseSync,
  input: {
    type: string;
    source: string;
    sessionId?: string | null;
    repoId?: string | null;
    data?: JsonValue | null;
    createdAt: string;
  },
) {
  database
    .prepare(
      `
      INSERT INTO learning_events (
        id,
        type,
        source,
        repo_id,
        session_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.type,
      input.source,
      input.repoId ?? null,
      input.sessionId ?? null,
      input.data === undefined || input.data === null
        ? null
        : JSON.stringify(input.data),
      input.createdAt,
    );
}

export function readLearningReviewById(database: DatabaseSync, id: string) {
  const row = database
    .prepare('SELECT * FROM learning_reviews WHERE id = ?;')
    .get(id);
  return row ? readLearningReviewRow(row) : undefined;
}

export function getLearningReview(id: string, paths = runtimePaths()) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return readLearningReviewById(database, id);
  } finally {
    database.close();
  }
}

export function readLearningReviewRow(row: unknown): LearningReviewRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    kind: v.parse(
      v.picklist(['conversation', 'curation', 'pr-batch']),
      record.kind,
    ),
    status: v.parse(
      v.picklist(['running', 'completed', 'failed']),
      record.status,
    ),
    model: String(record.model),
    thinkingLevel: v.parse(
      v.picklist(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
      record.thinking_level,
    ),
    trigger: parseNullableJson(record.trigger_json) ?? {},
    inputSummary: parseNullableJson(record.input_summary_json),
    result: parseNullableJson(record.result_json),
    error: typeof record.error === 'string' ? record.error : null,
    agentId: typeof record.agent_id === 'string' ? record.agent_id : null,
    submissionId:
      typeof record.submission_id === 'string' ? record.submission_id : null,
    dispatchError:
      typeof record.dispatch_error === 'string' ? record.dispatch_error : null,
    startedAt: String(record.started_at),
    completedAt:
      typeof record.completed_at === 'string' ? record.completed_at : null,
  };
}

function readLearningReviewAdmissionIntentRow(
  row: unknown,
): LearningReviewAdmissionIntent {
  const record = row as Record<string, unknown>;
  const input = parseNullableJson(record.input_json);
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new Error(
      `Learning review admission "${String(record.id)}" has invalid input.`,
    );
  }
  return {
    id: String(record.id),
    kind: v.parse(
      v.picklist(['conversation', 'curation', 'pr-batch']),
      record.kind,
    ),
    sessionId: typeof record.session_id === 'string' ? record.session_id : null,
    input: input as Record<string, unknown>,
    status: v.parse(
      v.picklist(['pending', 'processing', 'admitted']),
      record.status,
    ),
    error: typeof record.error === 'string' ? record.error : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

export function summarizeMemories(memories: unknown[], limit = 80) {
  return memories.slice(0, limit).map((memory) => {
    const item = memory as {
      id?: string;
      scope?: string;
      key?: string;
      value?: unknown;
      repoId?: string | null;
      useCount?: number;
      updatedAt?: string;
    };
    return {
      id: item.id,
      scope: item.scope,
      key: item.key,
      value: truncate(
        typeof item.value === 'string'
          ? item.value
          : JSON.stringify(item.value),
        500,
      ),
      repoId: item.repoId ?? null,
      useCount: item.useCount ?? 0,
      updatedAt: item.updatedAt,
    };
  });
}

export function compactJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function parseNullableJson(value: unknown): JsonValue | null {
  if (typeof value !== 'string') return null;
  return JSON.parse(value) as JsonValue;
}

export function failedReview(
  action: string,
  message: string,
  requires?: string[],
) {
  return {
    ok: false as const,
    action,
    changed: false as const,
    message,
    errors: [message],
    ...(requires ? { requires } : {}),
  };
}

export function reviewAction(kind: LearningReviewKind) {
  if (kind === 'conversation') return 'learning_review_conversation';
  if (kind === 'curation') return 'learning_curate';
  return 'learning_review_pr_batch';
}

export function truncate(value: string, maxLength: number) {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3).trimEnd()}...`
    : value;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
