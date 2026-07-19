import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { insertAutopilotAdmissionEvent } from '../coordination/advance';
import {
  readAutopilotPrOwner,
  type AutopilotPrOwner,
} from '../coordination/schemas';

export function ensureAutopilotOwnerInstanceInDatabase(
  database: DatabaseSync,
  ownerId: string,
  now: string,
) {
  const owner = readOwner(database, ownerId);
  if (!owner) throw new Error(`Autopilot owner ${ownerId} was not found.`);
  if (owner.flueInstanceId) {
    ensureGenerationRow(database, owner, owner.flueInstanceId, now);
    return owner;
  }
  const instanceId = ownerInstanceId(owner.id, owner.generation);
  const update = database
    .prepare(
      `UPDATE autopilot_pr_owners
       SET flue_instance_id = ?, status = 'active', updated_at = ?
       WHERE id = ? AND generation = ? AND flue_instance_id IS NULL;`,
    )
    .run(instanceId, now, owner.id, owner.generation);
  const current = readOwner(database, owner.id);
  if (update.changes !== 1 && current?.flueInstanceId !== instanceId) {
    if (!current?.flueInstanceId) {
      throw new Error('Autopilot owner instance creation lost its CAS.');
    }
    ensureGenerationRow(database, current, current.flueInstanceId, now);
    return current;
  }
  if (!current) throw new Error('Created owner instance could not be read.');
  ensureGenerationRow(database, current, instanceId, now);
  return current;
}

export function rotateAutopilotOwnerInstanceInDatabase(
  database: DatabaseSync,
  input: {
    ownerId: string;
    admissionId: string;
    attemptId: string;
    expectedGeneration: number;
    reason: string;
    handoff: Record<string, unknown>;
    now: string;
  },
) {
  const owner = ensureAutopilotOwnerInstanceInDatabase(
    database,
    input.ownerId,
    input.now,
  );
  if (owner.generation !== input.expectedGeneration || !owner.flueInstanceId) {
    throw new Error('Autopilot owner rotation lost its generation CAS.');
  }
  const nextGeneration = owner.generation + 1;
  const nextInstanceId = ownerInstanceId(owner.id, nextGeneration);
  database
    .prepare(
      `UPDATE autopilot_owner_generations
       SET status = 'archived', rotation_reason = ?, handoff_json = ?, archived_at = ?
       WHERE owner_id = ? AND generation = ? AND status = 'active';`,
    )
    .run(
      input.reason,
      JSON.stringify(input.handoff),
      input.now,
      owner.id,
      owner.generation,
    );
  const update = database
    .prepare(
      `UPDATE autopilot_pr_owners
       SET generation = ?, flue_instance_id = ?, updated_at = ?
       WHERE id = ? AND generation = ? AND flue_instance_id = ?;`,
    )
    .run(
      nextGeneration,
      nextInstanceId,
      input.now,
      owner.id,
      owner.generation,
      owner.flueInstanceId,
    );
  if (update.changes !== 1) {
    throw new Error('Autopilot owner rotation lost its owner CAS.');
  }
  const rotated = readOwner(database, owner.id);
  if (!rotated) throw new Error('Rotated owner instance could not be read.');
  ensureGenerationRow(database, rotated, nextInstanceId, input.now);
  insertAutopilotAdmissionEvent(database, {
    admissionId: input.admissionId,
    fromState: 'owner-turn-admitted',
    toState: 'owner-turn-admitted',
    reason: 'owner-instance-rotated',
    data: {
      attemptId: input.attemptId,
      fromGeneration: owner.generation,
      toGeneration: nextGeneration,
      fromInstanceId: owner.flueInstanceId,
      toInstanceId: nextInstanceId,
      rotationReason: input.reason,
      handoff: input.handoff,
    },
    now: input.now,
  });
  return rotated;
}

function ensureGenerationRow(
  database: DatabaseSync,
  owner: AutopilotPrOwner,
  instanceId: string,
  now: string,
) {
  database
    .prepare(
      `INSERT INTO autopilot_owner_generations (
         id, owner_id, generation, flue_instance_id, status, handoff_json, created_at
       ) VALUES (?, ?, ?, ?, 'active', '{}', ?)
       ON CONFLICT(owner_id, generation) DO NOTHING;`,
    )
    .run(
      `autopilot-owner-generation:${randomUUID()}`,
      owner.id,
      owner.generation,
      instanceId,
      now,
    );
}

function ownerInstanceId(ownerId: string, generation: number) {
  return `pr-owner-${ownerId.slice(-36)}-g${generation}`;
}

function readOwner(database: DatabaseSync, ownerId: string) {
  return readAutopilotPrOwner(
    database
      .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
      .get(ownerId),
  );
}
