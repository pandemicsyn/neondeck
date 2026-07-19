import { openDb } from '../../../lib/sqlite.ts';
import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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
    const checkpoint = latestPrRetrospectiveCheckpoint(database);
    const activeAdmission = hasActivePrRetrospectiveAdmission(
      database,
      checkpoint,
    );
    const row = database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM learning_events
        WHERE type = 'pr_handled'
          ${checkpoint ? 'AND created_at > ?' : ''};
      `,
      )
      .get(...(checkpoint ? [checkpoint] : [])) as { count?: unknown };
    const count = Number(row.count ?? 0);
    return { due: count >= threshold, count, activeAdmission };
  } finally {
    database.close();
  }
}

export function markPrRetrospectiveAdmitted(
  paths: RuntimePaths,
  input: { repoId: string | null; count: number; threshold: number },
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
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
  } finally {
    database.close();
  }
}

export function latestPrRetrospectiveCheckpoint(database: DatabaseSync) {
  const review = database
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
    .get() as { completed_at?: unknown } | undefined;
  return typeof review?.completed_at === 'string' ? review.completed_at : null;
}

export function hasActivePrRetrospectiveAdmission(
  database: DatabaseSync,
  checkpoint: string | null,
) {
  const admission = database
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
    .get(...(checkpoint ? [checkpoint] : [])) as
    { created_at?: unknown } | undefined;
  const admittedAt =
    typeof admission?.created_at === 'string' ? admission.created_at : null;
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
  const review = database
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
    .get(admittedAt) as { status?: unknown } | undefined;
  return !review || review.status === 'running';
}
