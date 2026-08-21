import { openDb } from '../../lib/sqlite';
import * as v from 'valibot';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';

const budgetRowSchema = v.object({
  calls_used: v.number(),
  call_limit: v.number(),
});

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
    const rawRow = database
      .prepare(
        `UPDATE pr_review_workspace_budgets
         SET calls_used = calls_used + 1, updated_at = ?
         WHERE budget_key = ? AND calls_used < call_limit
         RETURNING calls_used, call_limit;`,
      )
      .get(now, budget.key);
    const row = v.safeParse(budgetRowSchema, rawRow);
    return row.success ? row.output.call_limit - row.output.calls_used : null;
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
