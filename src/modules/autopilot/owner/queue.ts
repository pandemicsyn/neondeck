import type { DatabaseSync } from 'node:sqlite';
import { insertAutopilotAdmissionEvent } from '../coordination/advance';
import { readAutopilotAdmission } from '../coordination/schemas';

export const maximumOwnerCoalescedBytes = 192 * 1024;

/** Coalesces a bounded batch of durable concurrency-wait admissions per PR. */
export function coalesceQueuedOwnerAdmissionsInDatabase(
  database: DatabaseSync,
  ownerId: string,
  now: string,
) {
  const queued = database
    .prepare(
      `SELECT * FROM autopilot_admissions
       WHERE owner_id = ? AND state = 'blocked'
         AND current_stage_attempt_id IS NULL
         AND json_extract(last_outcome_json, '$.errorCode') = 'concurrency-limited'
       ORDER BY event_sequence DESC LIMIT 32;`,
    )
    .all(ownerId)
    .map(readAutopilotAdmission)
    .filter(
      (item): item is NonNullable<ReturnType<typeof readAutopilotAdmission>> =>
        Boolean(item),
    );
  const survivor = queued[0];
  if (!survivor) return null;
  const coalescedEvents = normalizedAdmissionEvents(survivor);
  const includedAdmissions = [];
  for (const candidate of queued.slice(1).reverse()) {
    const candidateEvents = normalizedAdmissionEvents(candidate);
    const next = dedupeEvents([...coalescedEvents, ...candidateEvents]);
    if (Buffer.byteLength(JSON.stringify(next)) > maximumOwnerCoalescedBytes) {
      continue;
    }
    coalescedEvents.splice(0, coalescedEvents.length, ...next);
    includedAdmissions.push(candidate);
  }
  for (const superseded of includedAdmissions) {
    database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = 'superseded', completed_at = ?, next_attempt_at = NULL,
             last_error = NULL, current_workflow = NULL, version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ? AND state = 'blocked';`,
      )
      .run(now, now, superseded.id, superseded.version);
    insertAutopilotAdmissionEvent(database, {
      admissionId: superseded.id,
      fromState: 'blocked',
      toState: 'superseded',
      reason: 'owner-queue-coalesced',
      data: { survivorAdmissionId: survivor.id },
      now,
    });
  }
  const nextInput = {
    ...survivor.input,
    coalescedEvents,
  };
  database
    .prepare(
      `UPDATE autopilot_admissions
       SET input_json = ?, next_attempt_at = ?, last_outcome_json = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND state = 'blocked';`,
    )
    .run(
      JSON.stringify(nextInput),
      now,
      JSON.stringify({
        stage: 'triage',
        result: 'blocked',
        retryClass: 'transient',
        concurrencyWaitCount: 1,
        retryStage: 'triage',
        resumeState: 'triage-admitted',
        errorCode: 'concurrency-limited',
        message: `Coalesced ${coalescedEvents.length} queued owner events.`,
      }),
      now,
      survivor.id,
      survivor.version,
    );
  insertAutopilotAdmissionEvent(database, {
    admissionId: survivor.id,
    fromState: 'blocked',
    toState: 'blocked',
    reason: 'owner-queue-coalesced-ready',
    data: {
      count: coalescedEvents.length,
      eventFingerprints: coalescedEvents.map((item) => item.eventFingerprint),
    },
    now,
  });
  return survivor.id;
}

function normalizedAdmissionEvents(
  admission: NonNullable<ReturnType<typeof readAutopilotAdmission>>,
) {
  const previous = Array.isArray(admission.input.coalescedEvents)
    ? admission.input.coalescedEvents.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object' && !Array.isArray(value),
      )
    : [];
  return dedupeEvents([
    ...previous,
    {
      admissionId: admission.id,
      eventFingerprint: admission.eventFingerprint,
      eventSequence: admission.eventSequence,
      input: { ...admission.input, coalescedEvents: undefined },
    },
  ]);
}

function dedupeEvents(events: Record<string, unknown>[]) {
  const byFingerprint = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const fingerprint = String(event.eventFingerprint ?? '');
    if (fingerprint) byFingerprint.set(fingerprint, event);
  }
  return [...byFingerprint.values()].sort(
    (left, right) =>
      Number(left.eventSequence ?? 0) - Number(right.eventSequence ?? 0),
  );
}
