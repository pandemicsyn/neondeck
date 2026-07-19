import { openDb } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import {
  readAutopilotAdmission,
  readAutopilotPrOwner,
  readAutopilotStageAttempt,
} from '../coordination/schemas';

export async function readAutopilotOwnerInspection(
  ownerId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const owner = readAutopilotPrOwner(
      database
        .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
        .get(ownerId),
    );
    if (!owner) return null;
    return {
      owner,
      generations: database
        .prepare(
          `SELECT generation, flue_instance_id AS instanceId, status,
                  rotation_reason AS rotationReason, handoff_json AS handoff,
                  created_at AS createdAt, archived_at AS archivedAt
           FROM autopilot_owner_generations WHERE owner_id = ?
           ORDER BY generation DESC;`,
        )
        .all(ownerId)
        .map(parseJsonColumns),
      groundingSnapshots: database
        .prepare(
          `SELECT id, admission_id AS admissionId, attempt_id AS attemptId,
                  generation, flue_instance_id AS instanceId,
                  config_history_id AS configHistoryId,
                  memory_event_at AS memoryEventAt,
                  memory_event_id AS memoryEventId,
                  memory_ids_json AS memoryIds,
                  stale_reasons_json AS staleReasons,
                  envelope_hash AS envelopeHash, policy_hash AS policyHash,
                  status, dispatch_id AS dispatchId, accepted_at AS acceptedAt,
                  created_at AS createdAt
           FROM autopilot_owner_grounding_snapshots WHERE owner_id = ?
           ORDER BY created_at DESC;`,
        )
        .all(ownerId)
        .map(parseJsonColumns),
      admissions: database
        .prepare(
          `SELECT * FROM autopilot_admissions WHERE owner_id = ?
           ORDER BY event_sequence DESC;`,
        )
        .all(ownerId)
        .map(readAutopilotAdmission)
        .filter(Boolean),
    };
  } finally {
    database.close();
  }
}

export async function readAutopilotAdmissionInspection(
  admissionId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const admission = readAutopilotAdmission(
      database
        .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
        .get(admissionId),
    );
    if (!admission) return null;
    return {
      admission,
      attempts: database
        .prepare(
          `SELECT * FROM autopilot_stage_attempts WHERE admission_id = ?
           ORDER BY created_at ASC;`,
        )
        .all(admissionId)
        .map(readAutopilotStageAttempt)
        .filter(Boolean),
      submissions: database
        .prepare(
          `SELECT id, attempt_id AS attemptId, dispatch_id AS dispatchId,
                  disposition, status, request_hash AS requestHash,
                  prepared_diff_id AS preparedDiffId, result_json AS result,
                  error, created_at AS createdAt, finished_at AS finishedAt
           FROM autopilot_owner_fix_submissions WHERE admission_id = ?
           ORDER BY created_at ASC;`,
        )
        .all(admissionId)
        .map(parseJsonColumns),
      events: database
        .prepare(
          `SELECT * FROM autopilot_admission_events WHERE admission_id = ?
           ORDER BY id ASC;`,
        )
        .all(admissionId)
        .map(parseJsonColumns),
    };
  } finally {
    database.close();
  }
}

function parseJsonColumns(row: unknown) {
  const result = { ...(row as Record<string, unknown>) };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string') continue;
    if (
      !key.toLowerCase().includes('json') &&
      !['handoff', 'memoryIds', 'staleReasons', 'result'].includes(key)
    )
      continue;
    try {
      result[key.replace(/Json$/, '')] = JSON.parse(value);
    } catch {
      // Retain malformed historical values for operator audit.
    }
  }
  return result;
}
