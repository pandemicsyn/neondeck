import { openDb } from '../../lib/sqlite';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';

export type PrReviewWorkspaceBudget = {
  key: string;
  limit: number;
};

export function consumePrReviewWorkspaceBudget(
  budget: PrReviewWorkspaceBudget,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `INSERT INTO pr_review_workspace_budgets (
          budget_key, calls_used, call_limit, updated_at
        ) VALUES (?, 0, ?, ?)
        ON CONFLICT(budget_key) DO UPDATE SET
          call_limit = excluded.call_limit,
          updated_at = excluded.updated_at
        WHERE pr_review_workspace_budgets.call_limit <> excluded.call_limit;`,
      )
      .run(budget.key, budget.limit, now);
    const row = database
      .prepare(
        `UPDATE pr_review_workspace_budgets
         SET calls_used = calls_used + 1, updated_at = ?
         WHERE budget_key = ? AND calls_used < call_limit
         RETURNING calls_used, call_limit;`,
      )
      .get(now, budget.key) as
      { calls_used: number; call_limit: number } | undefined;
    return row ? row.call_limit - row.calls_used : null;
  } finally {
    database.close();
  }
}

export function prReviewWorkspaceBudgetKey(input: {
  kind: 'initial' | 'follow-up';
  reviewId: string;
  revision: string;
}) {
  return `${input.kind}:${input.reviewId}:${input.revision}`;
}
