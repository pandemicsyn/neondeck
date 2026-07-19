import { openDb } from '../../lib/sqlite.ts';
/* eslint-disable no-unused-vars */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { listExecutionApprovals } from '../execution';
import { flueRunInspectionUrl } from '../runtime';
import {
  globalAutopilotPolicy,
  mergeAutopilotConcurrency,
  mergeAutopilotLimits,
  readRepoAutopilotConfig,
  type AutopilotConcurrencyPolicy,
  type AutopilotMode,
  type AutopilotPolicyLimits,
} from '../autopilot-policy';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { listNotifications, type NotificationLevel } from '../app-state';
import {
  listPreparedDiffs,
  type PreparedDiffApprovalRecord,
  type PreparedDiffRecord,
  type PreparedDiffStatus,
} from '../prepared-diffs';
import { listPrWatchRecords, type PrWatch } from '../watches';
import {
  listWorktrees,
  type WorktreeLifecycleStatus,
  type WorktreeRecord,
} from '../worktrees';
import {
  isAutopilotWorkflow,
  type AutopilotActivity,
  type WorkflowEventRow,
  type WorkflowRunRow,
  type WorktreeEventRow,
} from './state-schemas';

export function readActiveAutopilotRuns(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT run_id, workflow, status, started_at, last_event_at, last_message
        FROM workflow_run_observations
        WHERE status = 'active'
        ORDER BY last_event_at DESC
        LIMIT 20;
      `,
      )
      .all()
      .map(readWorkflowRunRow)
      .filter((row) => isAutopilotWorkflow(row.workflow));
  } finally {
    database.close();
  }
}

export function readRecentAutopilotWorkflowEvents(
  paths: RuntimePaths,
): AutopilotActivity[] {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT id, run_id, workflow, event_type, message, is_error, summary_json, created_at
        FROM workflow_events
        ORDER BY created_at DESC, id DESC
        LIMIT 120;
      `,
      )
      .all()
      .map(readWorkflowEventRow)
      .filter((row) => row.workflow && isAutopilotWorkflow(row.workflow))
      .slice(0, 20)
      .map((row) => ({
        id: `workflow-event:${row.id}`,
        type: 'workflow',
        level: row.is_error ? 'attention' : 'info',
        title: row.workflow ?? 'autopilot workflow',
        message: row.message,
        repoId: null,
        repoFullName: null,
        prNumber: null,
        createdAt: row.created_at,
      }));
  } finally {
    database.close();
  }
}

export function readRecentWorktreeEvents(
  paths: RuntimePaths,
  worktrees: WorktreeRecord[],
): AutopilotActivity[] {
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT id, worktree_id, repo_id, event_type, status, message, created_at
        FROM worktree_events
        ORDER BY created_at DESC
        LIMIT 40;
      `,
      )
      .all()
      .map(readWorktreeEventRow)
      .filter((row) => Boolean(byId.get(row.worktree_id)?.prNumber))
      .slice(0, 20)
      .map((row) => {
        const worktree = byId.get(row.worktree_id);
        return {
          id: `worktree-event:${row.id}`,
          type: 'worktree',
          level: row.status === 'failed' ? 'attention' : 'info',
          title: row.event_type,
          message: row.message,
          repoId: row.repo_id,
          repoFullName: worktree?.repoFullName ?? null,
          prNumber: worktree?.prNumber ?? null,
          createdAt: row.created_at,
        };
      });
  } finally {
    database.close();
  }
}

export function readWorkflowRunRow(row: unknown): WorkflowRunRow {
  return v.parse(
    v.object({
      run_id: v.string(),
      workflow: v.string(),
      status: v.string(),
      started_at: v.string(),
      last_event_at: v.string(),
      last_message: v.string(),
    }),
    row,
  );
}

export function readWorkflowEventRow(row: unknown): WorkflowEventRow {
  return v.parse(
    v.object({
      id: v.number(),
      run_id: v.nullable(v.string()),
      workflow: v.nullable(v.string()),
      event_type: v.string(),
      message: v.string(),
      is_error: v.number(),
      summary_json: v.nullable(v.string()),
      created_at: v.string(),
    }),
    row,
  );
}

export function readWorktreeEventRow(row: unknown): WorktreeEventRow {
  return v.parse(
    v.object({
      id: v.string(),
      worktree_id: v.string(),
      repo_id: v.string(),
      event_type: v.string(),
      status: v.string(),
      message: v.string(),
      created_at: v.string(),
    }),
    row,
  );
}
