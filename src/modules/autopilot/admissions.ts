import { randomUUID } from 'node:crypto';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import { readRepoRegistrySnapshot } from '../repos';
import { listPrWatchRecords } from '../watches';
import type {
  AutopilotConcurrencyPolicy,
  AutopilotMode,
} from '../autopilot-policy';
import { repoAutopilotPolicyForWatch } from '../autopilot-policy';

export type AutopilotAdmissionState =
  | 'triage-admitted'
  | 'triaged'
  | 'prepare-admitted'
  | 'prepared'
  | 'blocked'
  | 'manual-review'
  | 'failed'
  | 'superseded';

export type AutopilotAdmission = {
  id: string;
  watchId: string;
  eventFingerprint: string;
  repoId: string;
  prNumber: number;
  mode: AutopilotMode;
  input: Record<string, unknown>;
  state: AutopilotAdmissionState;
  currentWorkflow: string | null;
  currentRunId: string | null;
  worktreeId: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutopilotAdmissionTerminalFact = {
  workflow: 'triage-pr-event' | 'prepare-pr-worktree';
  failed: boolean;
  shouldPrepare?: boolean;
  worktreeId?: string;
};

const terminalFactKeyPrefix = 'autopilot.admission.terminal:';
const staleAdmissionMs = 5 * 60 * 1000;
const terminalFactRetentionMs = 60 * 60 * 1000;

export async function reconcileAutopilotAdmissions(
  paths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleAdmissionMs).toISOString();
  const factBefore = new Date(
    now.getTime() - terminalFactRetentionMs,
  ).toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = 'failed', current_workflow = NULL, last_error = ?,
             next_attempt_at = ?, updated_at = ?
         WHERE state IN ('triage-admitted', 'prepare-admitted')
           AND current_run_id IS NULL
           AND updated_at <= ?;`,
      )
      .run(
        'Autopilot admission became stale before its workflow completed.',
        nowIso,
        nowIso,
        staleBefore,
      );
    const terminalRuns = database
      .prepare(
        `SELECT a.*, observation.status AS observation_status,
                observation.last_event_at AS observation_last_event_at
         FROM autopilot_admissions AS a
         JOIN workflow_run_observations AS observation
           ON observation.run_id = a.current_run_id
         WHERE a.state IN ('triage-admitted', 'prepare-admitted')
           AND observation.status IN ('completed', 'failed');`,
      )
      .all();
    for (const run of terminalRuns) {
      const admission = readAdmission(run);
      if (!admission) continue;
      const terminal = readTerminalFact(
        database
          .prepare('SELECT value FROM app_metadata WHERE key = ?;')
          .get(terminalFactKey(admission.currentRunId ?? '')),
      );
      if (
        !terminal &&
        (run as { observation_status?: unknown }).observation_status ===
          'completed' &&
        Date.parse(
          String(
            (run as { observation_last_event_at?: unknown })
              .observation_last_event_at ?? '',
          ),
        ) > Date.parse(staleBefore)
      ) {
        continue;
      }
      const settled = settledAdmissionState(
        admission,
        terminal,
        (run as { observation_status?: unknown }).observation_status ===
          'failed',
      );
      const preserveTriageDecision =
        terminal?.workflow === 'triage-pr-event' &&
        !terminal.failed &&
        terminal.shouldPrepare === true;
      const uncertainPrepare =
        !terminal &&
        admission.currentWorkflow === 'prepare-pr-worktree' &&
        (run as { observation_status?: unknown }).observation_status ===
          'completed';
      database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = ?, current_workflow = NULL, worktree_id = ?, last_error = ?,
               next_attempt_at = ?, updated_at = ?
           WHERE id = ?;`,
        )
        .run(
          terminal
            ? settled.state
            : uncertainPrepare
              ? 'manual-review'
              : 'failed',
          settled.worktreeId ?? admission.worktreeId,
          uncertainPrepare
            ? 'Prepare run completed before its durable result was recorded; inspect before retrying.'
            : settled.failed
              ? 'Attached Flue run ended before its durable result was recorded.'
              : null,
          uncertainPrepare || !settled.failed ? null : nowIso,
          nowIso,
          admission.id,
        );
      if (terminal && !preserveTriageDecision) {
        database
          .prepare('DELETE FROM app_metadata WHERE key = ?;')
          .run(terminalFactKey(admission.currentRunId ?? ''));
      }
    }
    const due = database
      .prepare(
        `SELECT * FROM autopilot_admissions
         WHERE state IN ('blocked', 'failed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY priority DESC, updated_at ASC;`,
      )
      .all(nowIso)
      .map(readAdmission);
    const retries = due.filter((admission): admission is AutopilotAdmission =>
      Boolean(admission),
    );
    database
      .prepare(
        `DELETE FROM app_metadata
         WHERE key LIKE ? AND updated_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM autopilot_admissions AS admission
             WHERE admission.state = 'triaged'
               AND app_metadata.key = ? || admission.current_run_id
           );`,
      )
      .run(`${terminalFactKeyPrefix}%`, factBefore, terminalFactKeyPrefix);
    database.exec('COMMIT;');
    return retries;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function listAutopilotAdmissions(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare('SELECT * FROM autopilot_admissions ORDER BY updated_at DESC;')
      .all()
      .map(readAdmission)
      .filter((admission): admission is AutopilotAdmission =>
        Boolean(admission),
      );
  } finally {
    database.close();
  }
}

export async function listAutopilotAdmissionsAwaitingPreparation(
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const admissions = database
      .prepare(
        `SELECT * FROM autopilot_admissions
         WHERE state = 'triaged' AND current_run_id IS NOT NULL
         ORDER BY updated_at ASC;`,
      )
      .all()
      .map(readAdmission)
      .filter((admission): admission is AutopilotAdmission =>
        Boolean(admission),
      );
    return admissions.filter((admission) => {
      const fact = readTerminalFact(
        database
          .prepare('SELECT value FROM app_metadata WHERE key = ?;')
          .get(terminalFactKey(admission.currentRunId ?? '')),
      );
      return (
        fact?.workflow === 'triage-pr-event' &&
        !fact.failed &&
        fact.shouldPrepare === true
      );
    });
  } finally {
    database.close();
  }
}

export async function claimAutopilotTriageAdmission(
  input: {
    watchId: string;
    eventFingerprint: string;
    repoId: string;
    prNumber: number;
    mode: AutopilotMode;
    input: Record<string, unknown>;
    limits: AutopilotConcurrencyPolicy;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = readAdmission(
      database
        .prepare(
          'SELECT * FROM autopilot_admissions WHERE watch_id = ? AND event_fingerprint = ?;',
        )
        .get(input.watchId, input.eventFingerprint),
    );
    if (existing) {
      const due =
        (existing.state === 'blocked' || existing.state === 'failed') &&
        (!existing.nextAttemptAt ||
          Date.parse(existing.nextAttemptAt) <= Date.parse(now));
      const capped = admissionUsageExceedsLimits(
        readAdmissionUsage(database, input.repoId, input.prNumber),
        input.limits,
      );
      if (due && !capped) {
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'triage-admitted', current_workflow = 'triage-pr-event',
                 current_run_id = NULL, attempt_count = attempt_count + 1,
                 next_attempt_at = NULL, last_error = NULL, updated_at = ?
             WHERE id = ?;`,
          )
          .run(now, existing.id);
        database.exec('COMMIT;');
        return {
          claimed: true,
          admission: {
            ...existing,
            state: 'triage-admitted' as const,
            currentWorkflow: 'triage-pr-event',
            currentRunId: null,
            attemptCount: existing.attemptCount + 1,
            nextAttemptAt: null,
            lastError: null,
            updatedAt: now,
          },
          reason: 'retry' as const,
        };
      }
      database.exec('COMMIT;');
      return {
        claimed: false,
        admission: existing,
        reason: 'duplicate' as const,
      };
    }
    const capped = admissionUsageExceedsLimits(
      readAdmissionUsage(database, input.repoId, input.prNumber),
      input.limits,
    );
    const state: AutopilotAdmissionState = capped
      ? 'blocked'
      : 'triage-admitted';
    const admission: AutopilotAdmission = {
      id: `autopilot-admission:${randomUUID()}`,
      watchId: input.watchId,
      eventFingerprint: input.eventFingerprint,
      repoId: input.repoId,
      prNumber: input.prNumber,
      mode: input.mode,
      input: input.input,
      state,
      currentWorkflow: capped ? null : 'triage-pr-event',
      currentRunId: null,
      worktreeId: null,
      attemptCount: capped ? 0 : 1,
      nextAttemptAt: capped ? now : null,
      lastError: capped ? 'Autopilot admission limit reached.' : null,
      createdAt: now,
      updatedAt: now,
    };
    database
      .prepare(
        `INSERT INTO autopilot_admissions (
          id, watch_id, event_fingerprint, repo_id, pr_number, mode, input_json, state,
          current_workflow, current_run_id, attempt_count, next_attempt_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        admission.id,
        admission.watchId,
        admission.eventFingerprint,
        admission.repoId,
        admission.prNumber,
        admission.mode,
        JSON.stringify(input.input),
        admission.state,
        admission.currentWorkflow,
        null,
        admission.attemptCount,
        admission.nextAttemptAt,
        admission.lastError,
        now,
        now,
      );
    database.exec('COMMIT;');
    return {
      claimed: !capped,
      admission,
      reason: capped ? ('limited' as const) : null,
    };
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function recordAutopilotAdmissionRun(
  input: { id: string; runId: string },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const admission = readAdmission(
      database
        .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
        .get(input.id),
    );
    if (!admission) {
      database.exec('COMMIT;');
      return;
    }
    const observation = database
      .prepare(
        `SELECT status FROM workflow_run_observations
         WHERE run_id = ? AND status IN ('completed', 'failed');`,
      )
      .get(input.runId) as { status?: unknown } | undefined;
    const terminal = readTerminalFact(
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(terminalFactKey(input.runId)),
    );
    const observationFailed = observation?.status === 'failed';
    const settles = Boolean(observation || terminal);
    const workflowMatches =
      !terminal || terminal.workflow === admission.currentWorkflow;
    const awaitsPrepareFact =
      observation?.status === 'completed' &&
      admission.currentWorkflow === 'prepare-pr-worktree' &&
      !terminal;
    const settled =
      settles && workflowMatches && !awaitsPrepareFact
        ? settledAdmissionState(admission, terminal, observationFailed)
        : undefined;
    const update = database
      .prepare(
        `UPDATE autopilot_admissions
         SET current_run_id = ?, state = ?, current_workflow = ?, worktree_id = ?,
             last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('triage-admitted', 'prepare-admitted');`,
      )
      .run(
        input.runId,
        settled?.state ?? admission.state,
        settled ? null : admission.currentWorkflow,
        settled?.worktreeId ?? null,
        settled?.failed
          ? 'Workflow ended before its admission run id was attached.'
          : null,
        settled?.failed ? now : null,
        now,
        input.id,
      );
    if (
      settled &&
      workflowMatches &&
      update.changes > 0 &&
      !(
        terminal?.workflow === 'triage-pr-event' &&
        !terminal.failed &&
        terminal.shouldPrepare
      )
    ) {
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(terminalFactKey(input.runId));
    }
    database.exec('COMMIT;');
    return {
      admission: {
        ...admission,
        currentRunId: input.runId,
        state: settled?.state ?? admission.state,
        currentWorkflow: settled ? null : admission.currentWorkflow,
        nextAttemptAt: settled?.failed ? now : null,
        lastError: settled?.failed
          ? 'Workflow ended before its admission run id was attached.'
          : null,
        updatedAt: now,
      },
      terminal: settles && workflowMatches ? terminal : undefined,
    };
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function failAutopilotAdmission(
  input: { id: string; error: string },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('triage-admitted', 'prepare-admitted');`,
      )
      .run(
        input.error,
        new Date().toISOString(),
        new Date().toISOString(),
        input.id,
      );
  } finally {
    database.close();
  }
}

export async function settleAutopilotAdmissionTriage(
  input: { runId: string; failed: boolean; shouldPrepare?: boolean },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const update = database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = ?, current_workflow = NULL, last_error = ?,
             next_attempt_at = ?, updated_at = ?
         WHERE current_run_id = ? AND state = 'triage-admitted';`,
      )
      .run(
        input.failed ? 'failed' : 'triaged',
        input.failed ? 'Triage workflow failed; see Flue run details.' : null,
        input.failed ? now : null,
        now,
        input.runId,
      );
    if (update.changes > 0 && (input.failed || !input.shouldPrepare)) {
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(terminalFactKey(input.runId));
    }
  } finally {
    database.close();
  }
}

export async function beginAutopilotAdmissionPrepare(
  input: { triageRunId: string; limits?: AutopilotConcurrencyPolicy },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const configuredLimits = await readAdmissionLimits(input.triageRunId, paths);
  if (configuredLimits === 'disabled') return undefined;
  const limits = configuredLimits ?? input.limits;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const admission = readAdmission(
      database
        .prepare(
          `SELECT * FROM autopilot_admissions
          WHERE current_run_id = ? AND state = 'triaged';`,
        )
        .get(input.triageRunId),
    );
    if (!admission) {
      database.exec('COMMIT;');
      return undefined;
    }
    if (
      !limits ||
      admissionUsageExceedsLimits(
        readAdmissionUsage(database, admission.repoId, admission.prNumber),
        limits,
      )
    ) {
      database.exec('COMMIT;');
      return undefined;
    }
    database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = 'prepare-admitted', current_workflow = 'prepare-pr-worktree',
             current_run_id = NULL, attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ?;`,
      )
      .run(now, admission.id);
    database
      .prepare('DELETE FROM app_metadata WHERE key = ?;')
      .run(terminalFactKey(input.triageRunId));
    database.exec('COMMIT;');
    return {
      ...admission,
      state: 'prepare-admitted' as const,
      currentWorkflow: 'prepare-pr-worktree',
      currentRunId: null,
      attemptCount: admission.attemptCount + 1,
      updatedAt: now,
    };
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function recordAutopilotAdmissionTerminalFact(
  input: { runId: string; fact: AutopilotAdmissionTerminalFact },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      )
      .run(
        terminalFactKey(input.runId),
        JSON.stringify(input.fact),
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

export async function settleAutopilotAdmissionPrepare(
  input: { runId: string; failed: boolean; worktreeId?: string },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const update = database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = ?, current_workflow = NULL, worktree_id = ?, last_error = ?,
             next_attempt_at = ?, updated_at = ?
         WHERE current_run_id = ? AND state = 'prepare-admitted';`,
      )
      .run(
        input.failed || !input.worktreeId ? 'failed' : 'prepared',
        input.worktreeId ?? null,
        input.failed || !input.worktreeId
          ? 'Prepare workflow failed or did not produce a worktree.'
          : null,
        input.failed || !input.worktreeId ? now : null,
        now,
        input.runId,
      );
    if (update.changes > 0) {
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(terminalFactKey(input.runId));
    }
  } finally {
    database.close();
  }
}

function terminalFactKey(runId: string) {
  return `${terminalFactKeyPrefix}${runId}`;
}

function readTerminalFact(
  row: unknown,
): AutopilotAdmissionTerminalFact | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as { value?: unknown }).value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      (parsed.workflow !== 'triage-pr-event' &&
        parsed.workflow !== 'prepare-pr-worktree') ||
      typeof parsed.failed !== 'boolean'
    ) {
      return undefined;
    }
    return {
      workflow: parsed.workflow,
      failed: parsed.failed,
      shouldPrepare:
        typeof parsed.shouldPrepare === 'boolean'
          ? parsed.shouldPrepare
          : undefined,
      worktreeId:
        typeof parsed.worktreeId === 'string' ? parsed.worktreeId : undefined,
    };
  } catch {
    return undefined;
  }
}

function settledAdmissionState(
  admission: AutopilotAdmission,
  terminal: AutopilotAdmissionTerminalFact | undefined,
  observationFailed: boolean,
) {
  const failed = terminal?.failed ?? observationFailed;
  if (failed) return { state: 'failed' as const, failed: true };
  if (admission.currentWorkflow === 'triage-pr-event') {
    return { state: 'triaged' as const, failed: false };
  }
  if (terminal?.worktreeId) {
    return {
      state: 'prepared' as const,
      failed: false,
      worktreeId: terminal.worktreeId,
    };
  }
  return { state: 'failed' as const, failed: true };
}

function readAdmissionUsage(
  database: ReturnType<typeof openDb>,
  repoId: string,
  prNumber: number,
) {
  const workflows = [
    'triage-pr-event',
    'triage_pr_event',
    'prepare-pr-worktree',
    'prepare_pr_worktree',
    'fix-pr-review-feedback',
    'fix_pr_review_feedback',
    'fix-pr-ci',
    'fix_pr_ci',
    'ci-fix-run',
    'ci_fix_run',
    'fix-pr-ci-failure',
    'fix_pr_ci_failure',
    'verify-pr-worktree',
    'verify_pr_worktree',
    'push-pr-autofix',
    'push_pr_autofix',
    'verify-then-push-pr-autofix',
    'verify_then_push_pr_autofix',
    'comment-pr-autofix-result',
    'comment_pr_autofix_result',
    'cleanup-autopilot-worktree',
    'cleanup_autopilot_worktree',
  ];
  const workflowPlaceholders = workflows.map(() => '?').join(', ');
  return database
    .prepare(
      `WITH active_admissions AS (
         SELECT * FROM autopilot_admissions
         WHERE state IN ('triage-admitted', 'prepare-admitted')
       ), manual_runs AS (
         SELECT run_id FROM workflow_run_observations
         WHERE status = 'active' AND workflow IN (${workflowPlaceholders})
           AND NOT EXISTS (
             SELECT 1 FROM active_admissions
             WHERE active_admissions.current_run_id = workflow_run_observations.run_id
           )
       ), manual_worktrees AS (
         SELECT * FROM worktrees
         WHERE lifecycle_status = 'busy'
           AND (
             owning_workflow_run_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM active_admissions
               WHERE active_admissions.current_run_id = worktrees.owning_workflow_run_id
             )
           )
       )
       SELECT
         (SELECT COUNT(*) FROM active_admissions) +
           (SELECT COUNT(*) FROM manual_runs) +
           (SELECT COUNT(*) FROM manual_worktrees
            WHERE owning_workflow_run_id IS NULL
              OR owning_workflow_run_id NOT IN (SELECT run_id FROM manual_runs))
           AS global_count,
         (SELECT COUNT(*) FROM active_admissions WHERE repo_id = ?) +
           (SELECT COUNT(*) FROM manual_worktrees WHERE repo_id = ?) AS repo_count,
         (SELECT COUNT(*) FROM active_admissions WHERE repo_id = ? AND pr_number = ?) +
           (SELECT COUNT(*) FROM manual_worktrees WHERE repo_id = ? AND pr_number = ?) AS pr_count;`,
    )
    .get(...workflows, repoId, repoId, repoId, prNumber, repoId, prNumber) as {
    global_count?: unknown;
    repo_count?: unknown;
    pr_count?: unknown;
  };
}

function admissionUsageExceedsLimits(
  usage: { global_count?: unknown; repo_count?: unknown; pr_count?: unknown },
  limits: AutopilotConcurrencyPolicy,
) {
  const globalCount = Number(usage.global_count ?? 0);
  const repoCount = Number(usage.repo_count ?? 0);
  const prCount = Number(usage.pr_count ?? 0);
  return (
    globalCount >= limits.maxAutonomousJobs ||
    globalCount >= limits.maxActiveWorkflowRuns ||
    repoCount >= limits.maxPerRepoAutonomousJobs ||
    (limits.singleMutationPerPr && prCount > 0)
  );
}

async function readAdmissionLimits(
  triageRunId: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  const database = openDb(paths.neondeckDatabase);
  let admission: AutopilotAdmission | undefined;
  try {
    admission = readAdmission(
      database
        .prepare(
          `SELECT * FROM autopilot_admissions
           WHERE current_run_id = ? AND state = 'triaged';`,
        )
        .get(triageRunId),
    );
  } finally {
    database.close();
  }
  if (!admission) return undefined;
  const [registry, appConfig, watches] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
    listPrWatchRecords(paths),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === admission.repoId,
  );
  const watch = watches.find((candidate) => candidate.id === admission.watchId);
  if (!repo || !watch) return undefined;
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: watch.id,
    prNumber: watch.prNumber,
  });
  if (!('concurrency' in policy) || policy.mode === 'notify-only') {
    return 'disabled';
  }
  return policy.concurrency;
}

function readAdmission(row: unknown): AutopilotAdmission | undefined {
  if (!row) return undefined;
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    watchId: String(value.watch_id),
    eventFingerprint: String(value.event_fingerprint),
    repoId: String(value.repo_id),
    prNumber: Number(value.pr_number),
    mode: value.mode as AutopilotMode,
    input: readAdmissionInput(value.input_json),
    state: value.state as AutopilotAdmissionState,
    currentWorkflow:
      typeof value.current_workflow === 'string'
        ? value.current_workflow
        : null,
    currentRunId:
      typeof value.current_run_id === 'string' ? value.current_run_id : null,
    worktreeId:
      typeof value.worktree_id === 'string' ? value.worktree_id : null,
    attemptCount: Number(value.attempt_count),
    nextAttemptAt:
      typeof value.next_attempt_at === 'string' ? value.next_attempt_at : null,
    lastError: typeof value.last_error === 'string' ? value.last_error : null,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function readAdmissionInput(value: unknown) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
