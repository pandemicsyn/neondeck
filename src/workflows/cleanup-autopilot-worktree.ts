import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';
import { openDb } from '../lib/sqlite';
import { cleanupWorktrees } from '../modules/worktrees';
import { runtimePaths } from '../runtime-home';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  input: v.strictObject({
    admissionId: v.string(),
    attemptId: v.string(),
    worktreeId: v.string(),
  }),
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    changed: v.boolean(),
    message: v.string(),
  }),
  async run({ input }) {
    if (!isCurrentCleanupAttempt(input)) {
      return {
        ok: false,
        action: 'worktree_cleanup',
        changed: false,
        message:
          'The Autopilot cleanup attempt is no longer current; refusing worktree deletion.',
        code: 'cleanup-attempt-not-current',
      };
    }
    const result = await cleanupWorktrees({
      worktreeId: input.worktreeId,
      confirmPreparedDiff: true,
      terminalCleanupRetry: true,
    });
    const results =
      'results' in result && Array.isArray(result.results)
        ? (result.results as Array<{
            outcome?: string;
            reason?: string;
            error?: string;
          }>)
        : [];
    return {
      ...result,
      data: {
        cleanupDeleted: results.some(
          (item) =>
            item.outcome === 'deleted' || item.reason === 'already deleted',
        ),
        cleanupFailed: results.some((item) => item.outcome === 'failed'),
        cleanupError: results.find((item) => item.outcome === 'failed')?.error,
      },
    };
  },
});

function isCurrentCleanupAttempt(input: {
  admissionId: string;
  attemptId: string;
  worktreeId: string;
}) {
  const paths = runtimePaths();
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT admission.id
           FROM autopilot_admissions AS admission
           INNER JOIN autopilot_stage_attempts AS attempt
             ON attempt.id = admission.current_stage_attempt_id
           INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
           WHERE admission.id = ? AND admission.worktree_id = ?
             AND admission.state = 'cleanup-pending'
             AND attempt.id = ? AND attempt.stage = 'cleanup'
             AND attempt.status IN ('reserved', 'running')
             AND owner.status = 'draining';`,
        )
        .get(input.admissionId, input.worktreeId, input.attemptId),
    );
  } finally {
    database.close();
  }
}
