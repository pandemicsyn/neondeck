import { randomUUID } from 'node:crypto';
import { openDb } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import type {
  AutopilotConcurrencyPolicy,
  AutopilotMode,
} from '../autopilot-policy';

export type AutopilotAdmissionState =
  'triage-admitted' | 'triaged' | 'blocked' | 'failed' | 'superseded';

export type AutopilotAdmission = {
  id: string;
  watchId: string;
  eventFingerprint: string;
  repoId: string;
  prNumber: number;
  mode: AutopilotMode;
  state: AutopilotAdmissionState;
  currentWorkflow: string | null;
  currentRunId: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const activeStates: AutopilotAdmissionState[] = ['triage-admitted'];

export async function claimAutopilotTriageAdmission(
  input: {
    watchId: string;
    eventFingerprint: string;
    repoId: string;
    prNumber: number;
    mode: AutopilotMode;
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
      database.exec('COMMIT;');
      return {
        claimed: false,
        admission: existing,
        reason: 'duplicate' as const,
      };
    }
    const usage = database
      .prepare(
        `SELECT COUNT(*) AS global_count,
          SUM(CASE WHEN repo_id = ? THEN 1 ELSE 0 END) AS repo_count
         FROM autopilot_admissions
         WHERE state IN ('triage-admitted');`,
      )
      .get(input.repoId) as { global_count?: unknown; repo_count?: unknown };
    const globalCount = Number(usage.global_count ?? 0);
    const repoCount = Number(usage.repo_count ?? 0);
    const capped =
      globalCount >= input.limits.maxAutonomousJobs ||
      globalCount >= input.limits.maxActiveWorkflowRuns ||
      repoCount >= input.limits.maxPerRepoAutonomousJobs;
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
      state,
      currentWorkflow: capped ? null : 'triage-pr-event',
      currentRunId: null,
      attemptCount: capped ? 0 : 1,
      nextAttemptAt: capped ? now : null,
      lastError: capped ? 'Autopilot admission limit reached.' : null,
      createdAt: now,
      updatedAt: now,
    };
    database
      .prepare(
        `INSERT INTO autopilot_admissions (
          id, watch_id, event_fingerprint, repo_id, pr_number, mode, state,
          current_workflow, current_run_id, attempt_count, next_attempt_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        admission.id,
        admission.watchId,
        admission.eventFingerprint,
        admission.repoId,
        admission.prNumber,
        admission.mode,
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
    database.exec('ROLLBACK;');
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
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE autopilot_admissions
         SET current_run_id = ?, updated_at = ?
         WHERE id = ? AND state = 'triage-admitted';`,
      )
      .run(input.runId, new Date().toISOString(), input.id);
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
         WHERE id = ? AND state = 'triage-admitted';`,
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
    state: value.state as AutopilotAdmissionState,
    currentWorkflow:
      typeof value.current_workflow === 'string'
        ? value.current_workflow
        : null,
    currentRunId:
      typeof value.current_run_id === 'string' ? value.current_run_id : null,
    attemptCount: Number(value.attempt_count),
    nextAttemptAt:
      typeof value.next_attempt_at === 'string' ? value.next_attempt_at : null,
    lastError: typeof value.last_error === 'string' ? value.last_error : null,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}
