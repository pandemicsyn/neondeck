import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { runtimePaths, type RuntimePaths } from '../../../runtime-home';
import type {
  LearningReviewKind,
  LearningReviewRecord,
  LearningReviewStatus,
} from './schemas';

export function listLearningReviews(
  input: {
    kind?: LearningReviewKind;
    status?: LearningReviewStatus;
    limit?: number;
  } = {},
  paths = runtimePaths(),
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
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
    kind: LearningReviewKind;
    model: string;
    thinkingLevel: string;
    trigger: JsonValue;
    inputSummary: JsonValue;
  },
  paths = runtimePaths(),
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
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
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?);
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
    recordLearningEventInDatabase(database, {
      type:
        input.kind === 'conversation'
          ? 'reflection_started'
          : input.kind === 'curation'
            ? 'curation_started'
            : 'pr_retrospective_started',
      source: 'workflow',
      data: { reviewId: id },
      createdAt: now,
    });
  } finally {
    database.close();
  }
  return id;
}

export function completeLearningReview(
  id: string,
  result: JsonValue,
  paths = runtimePaths(),
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const review = readLearningReviewById(database, id);
    database
      .prepare(
        `
        UPDATE learning_reviews
        SET status = 'completed',
          result_json = ?,
          error = NULL,
          completed_at = ?
        WHERE id = ?;
      `,
      )
      .run(JSON.stringify(result), now, id);
    recordLearningEventInDatabase(database, {
      type:
        review?.kind === 'conversation'
          ? 'reflection_completed'
          : review?.kind === 'curation'
            ? 'memory_curated'
            : 'pr_retrospective_completed',
      source: 'workflow',
      data: { reviewId: id, result },
      createdAt: now,
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
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const review = readLearningReviewById(database, id);
    database
      .prepare(
        `
        UPDATE learning_reviews
        SET status = 'failed',
          error = ?,
          completed_at = ?
        WHERE id = ?;
      `,
      )
      .run(message, now, id);
    recordLearningEventInDatabase(database, {
      type:
        review?.kind === 'conversation'
          ? 'reflection_failed'
          : review?.kind === 'curation'
            ? 'curation_failed'
            : 'pr_retrospective_failed',
      source: 'workflow',
      data: { reviewId: id, error: message },
      createdAt: now,
    });
  } finally {
    database.close();
  }
}

export function attachLearningReviewRunId(
  input: {
    reviewId: string;
    runId: string;
  },
  paths = runtimePaths(),
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE learning_reviews
        SET flue_run_id = ?
        WHERE id = ?;
      `,
      )
      .run(input.runId, input.reviewId);
  } finally {
    database.close();
  }
}

export function markLearningCadenceAdmitted(
  paths: RuntimePaths,
  sessionId: string,
  kind: LearningReviewKind,
  turnCount: number,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    if (kind === 'conversation') {
      database
        .prepare(
          `
          UPDATE chat_sessions
          SET last_learning_review_turn_count = ?,
            last_learning_review_at = ?,
            updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(turnCount, now, now, sessionId);
      return;
    }
    database
      .prepare(
        `
        UPDATE chat_sessions
        SET last_learning_curation_turn_count = ?,
          last_learning_curation_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(turnCount, now, now, sessionId);
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
  const database = new DatabaseSync(paths.neondeckDatabase);
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
    thinkingLevel: String(record.thinking_level),
    trigger: parseNullableJson(record.trigger_json) ?? {},
    inputSummary: parseNullableJson(record.input_summary_json),
    result: parseNullableJson(record.result_json),
    error: typeof record.error === 'string' ? record.error : null,
    flueRunId:
      typeof record.flue_run_id === 'string' ? record.flue_run_id : null,
    startedAt: String(record.started_at),
    completedAt:
      typeof record.completed_at === 'string' ? record.completed_at : null,
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
