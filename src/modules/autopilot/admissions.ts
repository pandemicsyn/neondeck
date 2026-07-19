import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { admitAutopilotEvent } from './coordination/advance';
import { reconcileAutopilotStageAttempts } from './coordination/reconcile';
import {
  readAutopilotAdmission,
  readAutopilotStageAttempt,
  type AutopilotAdmission,
  type AutopilotAdmissionEvent,
  type AutopilotAdmissionState,
  type AutopilotStageAttempt,
  type AutopilotTerminalObservation,
} from './coordination/schemas';

export type {
  AutopilotAdmission,
  AutopilotAdmissionEvent,
  AutopilotAdmissionState,
  AutopilotStageAttempt,
  AutopilotTerminalObservation as AutopilotAdmissionTerminalFact,
};

export const claimAutopilotTriageAdmission = admitAutopilotEvent;

export async function reconcileAutopilotAdmissions(
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  const result = await reconcileAutopilotStageAttempts(paths, { now });
  return result.dueAdmissions;
}

export async function listAutopilotAdmissions(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare('SELECT * FROM autopilot_admissions ORDER BY updated_at DESC;')
      .all()
      .map(readAutopilotAdmission)
      .filter((admission): admission is AutopilotAdmission =>
        Boolean(admission),
      );
  } finally {
    database.close();
  }
}

export async function listAutopilotAdmissionsAwaitingPreparation(
  paths: RuntimePaths = runtimePaths(),
) {
  const admissions = await listAutopilotAdmissions(paths);
  return admissions.filter(
    (admission) =>
      admission.state === 'triaged' &&
      admission.lastOutcome?.stage === 'triage' &&
      admission.lastOutcome.shouldPrepare === true,
  );
}

export async function listAutopilotStageAttempts(
  input: { admissionId?: string } = {},
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = input.admissionId
      ? database
          .prepare(
            `SELECT * FROM autopilot_stage_attempts
             WHERE admission_id = ? ORDER BY created_at, attempt_number;`,
          )
          .all(input.admissionId)
      : database
          .prepare(
            'SELECT * FROM autopilot_stage_attempts ORDER BY created_at, attempt_number;',
          )
          .all();
    return rows
      .map(readAutopilotStageAttempt)
      .filter((attempt): attempt is AutopilotStageAttempt => Boolean(attempt));
  } finally {
    database.close();
  }
}

export async function listAutopilotAdmissionEvents(
  admissionId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT * FROM autopilot_admission_events
         WHERE admission_id = ? ORDER BY id;`,
      )
      .all(admissionId)
      .map(readAdmissionEvent)
      .filter((event): event is AutopilotAdmissionEvent => Boolean(event));
  } finally {
    database.close();
  }
}

function readAdmissionEvent(row: unknown) {
  if (!row || typeof row !== 'object') return undefined;
  const value = row as Record<string, unknown>;
  const toState = String(value.to_state) as AutopilotAdmissionState;
  return {
    id: Number(value.id),
    admissionId: String(value.admission_id),
    fromState:
      typeof value.from_state === 'string'
        ? (value.from_state as AutopilotAdmissionState)
        : null,
    toState,
    reason: String(value.reason),
    workflow: typeof value.workflow === 'string' ? value.workflow : null,
    runId: typeof value.run_id === 'string' ? value.run_id : null,
    data: parseRecord(value.data_json),
    createdAt: String(value.created_at),
  } satisfies AutopilotAdmissionEvent;
}

function parseRecord(value: unknown) {
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
