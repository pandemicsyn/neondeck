import { randomUUID } from 'node:crypto';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { prunePrReviewWorkspaceOutputs } from '../../runtime-home/app-db/reconcile';

export const prReviewWorkspaceOutputMaxEntries = 24;
export const prReviewWorkspaceOutputMaxBytes = 32 * 1024 * 1024;
export const prReviewWorkspaceOutputRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export type PrReviewWorkspaceOutputSource = 'diff' | 'list' | 'search';

export type PrReviewWorkspaceOutputScope = {
  key: string;
  paths?: RuntimePaths;
};

export type RetainedPrReviewWorkspaceOutput = {
  source: PrReviewWorkspaceOutputSource;
  text: string;
  bytes: number;
  lines: number;
};

export function retainPrReviewWorkspaceOutput(
  input: {
    scope: PrReviewWorkspaceOutputScope;
    source: PrReviewWorkspaceOutputSource;
    text: string;
  },
  now = new Date(),
) {
  const bytes = Buffer.byteLength(input.text, 'utf8');
  const lines = countLines(input.text);
  if (bytes > prReviewWorkspaceOutputMaxBytes) {
    return {
      outputRetained: false as const,
      outputBytes: bytes,
      outputLines: lines,
      outputHint:
        'The full output exceeded the retained-output limit. Narrow the original request.',
    };
  }

  const outputRef = randomUUID();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + prReviewWorkspaceOutputRetentionMs,
  ).toISOString();
  const database = openDb(
    (input.scope.paths ?? runtimePaths()).neondeckDatabase,
  );
  try {
    withImmediateTransaction(database, () => {
      database
        .prepare(
          `DELETE FROM pr_review_workspace_outputs WHERE expires_at <= ?;`,
        )
        .run(createdAt);
      const rows = database
        .prepare(
          `SELECT output_ref, byte_size
           FROM pr_review_workspace_outputs
           WHERE scope_key = ?
           ORDER BY created_at ASC, output_ref ASC;`,
        )
        .all(input.scope.key) as Array<{
        output_ref: string;
        byte_size: number;
      }>;
      let retainedBytes = rows.reduce((total, row) => total + row.byte_size, 0);
      while (
        rows.length >= prReviewWorkspaceOutputMaxEntries ||
        retainedBytes + bytes > prReviewWorkspaceOutputMaxBytes
      ) {
        const oldest = rows.shift();
        if (!oldest) break;
        database
          .prepare(
            `DELETE FROM pr_review_workspace_outputs
             WHERE output_ref = ? AND scope_key = ?;`,
          )
          .run(oldest.output_ref, input.scope.key);
        retainedBytes -= oldest.byte_size;
      }
      prunePrReviewWorkspaceOutputs(database, {
        now: now.getTime(),
        reserveEntries: 1,
        reserveBytes: bytes,
      });
      database
        .prepare(
          `INSERT INTO pr_review_workspace_outputs (
             output_ref, scope_key, source, payload, byte_size, line_count,
             created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          outputRef,
          input.scope.key,
          input.source,
          input.text,
          bytes,
          lines,
          createdAt,
          expiresAt,
        );
    });
  } finally {
    database.close();
  }

  return {
    outputRetained: true as const,
    outputRef,
    outputBytes: bytes,
    outputLines: lines,
    outputHint:
      'Use neondeck_review_workspace_output with this outputRef to search the full output or read a targeted line range. Do not repeat the original broad call.',
  };
}

export function readPrReviewWorkspaceOutput(
  input: { scope: PrReviewWorkspaceOutputScope; outputRef: string },
  now = new Date(),
): RetainedPrReviewWorkspaceOutput | null {
  const database = openDb(
    (input.scope.paths ?? runtimePaths()).neondeckDatabase,
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        `SELECT source, payload, byte_size, line_count
         FROM pr_review_workspace_outputs
         WHERE output_ref = ? AND scope_key = ? AND expires_at > ?;`,
      )
      .get(input.outputRef, input.scope.key, now.toISOString()) as
      | {
          source: PrReviewWorkspaceOutputSource;
          payload: string;
          byte_size: number;
          line_count: number;
        }
      | undefined;
    return row
      ? {
          source: row.source,
          text: row.payload,
          bytes: row.byte_size,
          lines: row.line_count,
        }
      : null;
  } finally {
    database.close();
  }
}

function countLines(value: string) {
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}
