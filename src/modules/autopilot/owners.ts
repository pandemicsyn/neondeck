import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import {
  readAutopilotPrOwner,
  type AutopilotPrOwner,
} from './coordination/schemas';

export type EnsureAutopilotPrOwnerInput = {
  watchId: string;
  repoId: string;
  prNumber: number;
};

export async function ensureAutopilotPrOwner(
  input: EnsureAutopilotPrOwnerInput,
  paths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () =>
      ensureAutopilotPrOwnerInDatabase(database, input, now.toISOString()),
    );
  } finally {
    database.close();
  }
}

export function ensureAutopilotPrOwnerInDatabase(
  database: DatabaseSync,
  input: EnsureAutopilotPrOwnerInput,
  now: string,
) {
  const existing = readAutopilotPrOwner(
    database
      .prepare('SELECT * FROM autopilot_pr_owners WHERE watch_id = ?;')
      .get(input.watchId),
  );
  if (existing) {
    if (
      existing.repoId !== input.repoId ||
      existing.prNumber !== input.prNumber
    ) {
      throw new Error(
        `Autopilot owner ${existing.id} is bound to a different repository or PR.`,
      );
    }
    return existing;
  }

  const owner: AutopilotPrOwner = {
    id: `autopilot-owner:${randomUUID()}`,
    watchId: input.watchId,
    repoId: input.repoId,
    prNumber: input.prNumber,
    flueAgent: 'pr-autopilot-owner',
    flueInstanceId: null,
    chatSessionId: null,
    worktreeId: null,
    generation: 1,
    groundingConfigHistoryId: 0,
    groundingMemoryEventAt: null,
    groundingMemoryEventId: null,
    groundingMemoryEventSequence: 0,
    groundingMemoryIds: [],
    status: 'awaiting-event',
    currentHeadSha: null,
    lastDispatchedSequence: 0,
    lastSettledSequence: 0,
    lastEventAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  database
    .prepare(
      `INSERT INTO autopilot_pr_owners (
         id, watch_id, repo_id, pr_number, flue_agent, generation,
         grounding_config_history_id, grounding_memory_ids_json, status,
         last_dispatched_sequence, last_settled_sequence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 0, '[]', 'awaiting-event', 0, 0, ?, ?);`,
    )
    .run(
      owner.id,
      owner.watchId,
      owner.repoId,
      owner.prNumber,
      owner.flueAgent,
      now,
      now,
    );
  return owner;
}

export async function readAutopilotPrOwnerByWatch(
  watchId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return readAutopilotPrOwner(
      database
        .prepare('SELECT * FROM autopilot_pr_owners WHERE watch_id = ?;')
        .get(watchId),
    );
  } finally {
    database.close();
  }
}

export async function readAutopilotPrOwnerById(
  ownerId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return readAutopilotPrOwner(
      database
        .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
        .get(ownerId),
    );
  } finally {
    database.close();
  }
}

export async function listAutopilotPrOwners(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare('SELECT * FROM autopilot_pr_owners ORDER BY updated_at DESC;')
      .all()
      .map(readAutopilotPrOwner)
      .filter((owner): owner is AutopilotPrOwner => Boolean(owner));
  } finally {
    database.close();
  }
}

export async function bindAutopilotOwnerWorktree(
  input: {
    ownerId: string;
    worktreeId: string;
    headSha: string;
  },
  paths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const owner = readAutopilotPrOwner(
        database
          .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
          .get(input.ownerId),
      );
      if (!owner)
        throw new Error(`Autopilot owner ${input.ownerId} was not found.`);
      if (owner.worktreeId && owner.worktreeId !== input.worktreeId) {
        throw new Error(
          `Autopilot owner ${owner.id} is already bound to worktree ${owner.worktreeId}.`,
        );
      }
      const nowIso = now.toISOString();
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET worktree_id = ?, current_head_sha = ?, status = 'active',
               updated_at = ?
           WHERE id = ? AND (worktree_id IS NULL OR worktree_id = ?);`,
        )
        .run(
          input.worktreeId,
          input.headSha,
          nowIso,
          owner.id,
          input.worktreeId,
        );
      const updated = readAutopilotPrOwner(
        database
          .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
          .get(owner.id),
      );
      if (!updated || updated.worktreeId !== input.worktreeId) {
        throw new Error('Autopilot owner worktree binding lost its CAS.');
      }
      return updated;
    });
  } finally {
    database.close();
  }
}
