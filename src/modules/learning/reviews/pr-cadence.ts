import { openDb, withImmediateTransaction } from '../../../lib/sqlite.ts';
import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import type { RuntimePaths } from '../../../runtime-home';

export type HandledPrEventRecord = {
  id: string;
  source: string;
  sourceId: string | null;
  repoId: string | null;
  prKey: string | null;
  data: JsonValue | null;
  createdAt: string;
};

export function prRetrospectiveDue(paths: RuntimePaths, threshold: number) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return prRetrospectiveDueInDatabase(database, threshold);
  } finally {
    database.close();
  }
}

export function prRetrospectiveDueInDatabase(
  database: DatabaseSync,
  threshold: number,
) {
  const checkpoint = latestPrRetrospectiveCheckpoint(database);
  const activeAdmission = hasActivePrRetrospectiveAdmission(
    database,
    checkpoint,
  );
  const row = v.parse(
    v.object({ count: v.optional(v.number()) }),
    database
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM learning_events
      WHERE type = 'pr_handled'
        ${checkpoint ? 'AND created_at > ?' : ''};
    `,
      )
      .get(...(checkpoint ? [checkpoint] : [])),
  );
  const count = Number(row.count ?? 0);
  return { due: count >= threshold, count, activeAdmission };
}

export function markPrRetrospectiveAdmitted(
  paths: RuntimePaths,
  input: { repoId: string | null; count: number; threshold: number },
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    return withImmediateTransaction(database, () => {
      return markPrRetrospectiveAdmittedInDatabase(database, input, now);
    });
  } finally {
    database.close();
  }
}

export function markPrRetrospectiveAdmittedInDatabase(
  database: DatabaseSync,
  input: { repoId: string | null; count: number; threshold: number },
  now = new Date().toISOString(),
) {
  const checkpoint = latestPrRetrospectiveCheckpoint(database);
  if (hasActivePrRetrospectiveAdmission(database, checkpoint)) return false;
  database
    .prepare(
      `
      INSERT INTO learning_events (
        id,
        type,
        source,
        repo_id,
        data_json,
        created_at
      )
      VALUES (?, 'pr_retrospective_admitted', 'app', ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.repoId,
      JSON.stringify({
        count: input.count,
        threshold: input.threshold,
        status: 'admitted',
      }),
      now,
    );
  return true;
}

export function latestPrRetrospectiveCheckpoint(database: DatabaseSync) {
  const review = v.parse(
    v.optional(v.object({ completed_at: v.optional(v.string()) })),
    database
      .prepare(
        `
      SELECT completed_at
      FROM learning_reviews
      WHERE kind = 'pr-batch'
        AND status = 'completed'
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1;
    `,
      )
      .get(),
  );
  return review?.completed_at ?? null;
}

export function hasActivePrRetrospectiveAdmission(
  database: DatabaseSync,
  checkpoint: string | null,
) {
  const pendingIntent = database
    .prepare(
      `SELECT id FROM learning_review_admissions WHERE kind = 'pr-batch' AND status != 'admitted' LIMIT 1;`,
    )
    .get();
  if (pendingIntent) return true;
  const admission = v.parse(
    v.optional(v.object({ created_at: v.optional(v.string()) })),
    database
      .prepare(
        `
      SELECT created_at
      FROM learning_events
      WHERE type = 'pr_retrospective_admitted'
        ${checkpoint ? 'AND created_at > ?' : ''}
      ORDER BY created_at DESC
      LIMIT 1;
    `,
      )
      .get(...(checkpoint ? [checkpoint] : [])),
  );
  const admittedAt = admission?.created_at ?? null;
  if (!admittedAt) {
    const running = database
      .prepare(
        `
        SELECT id
        FROM learning_reviews
        WHERE kind = 'pr-batch'
          AND status = 'running'
          ${checkpoint ? 'AND started_at > ?' : ''}
        LIMIT 1;
      `,
      )
      .get(...(checkpoint ? [checkpoint] : []));
    return Boolean(running);
  }
  const review = v.parse(
    v.optional(v.object({ status: v.optional(v.string()) })),
    database
      .prepare(
        `
      SELECT status
      FROM learning_reviews
      WHERE kind = 'pr-batch'
        AND started_at >= ?
      ORDER BY started_at DESC
      LIMIT 1;
    `,
      )
      .get(admittedAt),
  );
  if (review?.status === 'running') return true;
  const failedAdmission = database
    .prepare(
      `
      SELECT id
      FROM learning_events
      WHERE type = 'pr_retrospective_failed'
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1;
    `,
    )
    .get(admittedAt);
  if (failedAdmission) return false;
  return !review || review.status === 'running';
}
