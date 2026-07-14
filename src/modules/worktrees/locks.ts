import { DatabaseSync } from 'node:sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { WorktreeError, isSqliteUniqueConstraint } from './errors';
import type { WorktreeLockRecord, WorktreeRecord } from './schemas';
import { readLockRow } from './store';

export function assertNoForeignActiveLock(
  record: WorktreeRecord,
  lockId: string | undefined,
  paths: RuntimePaths,
) {
  const now = Date.now();
  const locks = activeLocksForWorktree(record, paths).filter(
    (lock) => Date.parse(lock.expiresAt) > now,
  );
  if (lockId) {
    if (locks.some((lock) => lock.id === lockId && !lock.revokedAt)) return;
    throw new WorktreeError(
      'WORKTREE_LOCKED',
      `Worktree lock ${lockId} is no longer active; the mutation lease was revoked or expired.`,
    );
  }
  if (locks.length === 0) return;
  throw new WorktreeError(
    'WORKTREE_LOCKED',
    `Worktree ${record.id} has an active lock held by ${locks[0]!.owner}.`,
  );
}

export function acquireLock(
  lock: WorktreeLockRecord,
  now: Date,
  paths: RuntimePaths,
):
  | { ok: true; lock: WorktreeLockRecord; recovered?: WorktreeLockRecord }
  | { ok: false; active: WorktreeLockRecord } {
  const database = new DatabaseSync(paths.neondeckDatabase);
  let committed = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    const activeRow = database
      .prepare(
        `
        SELECT *
        FROM worktree_locks
        WHERE scope_key = ?
          AND released_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      )
      .get(lock.scopeKey);
    const active = activeRow ? readLockRow(activeRow) : undefined;
    if (active && Date.parse(active.expiresAt) > now.getTime()) {
      database.exec('ROLLBACK;');
      committed = true;
      return { ok: false, active };
    }
    if (active) {
      database
        .prepare(
          `
          UPDATE worktree_locks
          SET released_at = ?, stale_recovered_at = ?, updated_at = ?
          WHERE id = ?
            AND released_at IS NULL;
        `,
        )
        .run(lock.createdAt, lock.createdAt, lock.createdAt, active.id);
    }
    database
      .prepare(
        `
        INSERT INTO worktree_locks (
          id, scope, scope_key, worktree_id, repo_id, pr_number, owner,
          workflow_run_id, expires_at, revoked_at, released_at,
          stale_recovered_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        lock.id,
        lock.scope,
        lock.scopeKey,
        lock.worktreeId,
        lock.repoId,
        lock.prNumber,
        lock.owner,
        lock.workflowRunId,
        lock.expiresAt,
        lock.revokedAt,
        lock.releasedAt,
        lock.staleRecoveredAt,
        lock.createdAt,
        lock.updatedAt,
      );
    database.exec('COMMIT;');
    committed = true;
    return { ok: true, lock, recovered: active };
  } catch (error) {
    if (!committed) {
      database.exec('ROLLBACK;');
    }
    if (isSqliteUniqueConstraint(error)) {
      const active = activeLockByScope(lock.scopeKey, paths);
      if (active) return { ok: false, active };
    }
    throw error;
  } finally {
    database.close();
  }
}

function activeLockByScope(scopeKey: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM worktree_locks
        WHERE scope_key = ?
          AND released_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      )
      .get(scopeKey);
    return row ? readLockRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function activeLocksForWorktree(
  record: WorktreeRecord,
  paths: RuntimePaths,
) {
  const prScope =
    record.prNumber === null ? null : `pr:${record.repoId}:${record.prNumber}`;
  return listLockRecords(paths).filter(
    (lock) =>
      !lock.releasedAt &&
      (lock.scopeKey === `worktree:${record.id}` ||
        (prScope !== null && lock.scopeKey === prScope)),
  );
}

export function listLockRecords(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM worktree_locks
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 200;
      `,
      )
      .all()
      .map(readLockRow);
  } finally {
    database.close();
  }
}

export function requireLock(id: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM worktree_locks WHERE id = ?;')
      .get(id);
    if (!row)
      throw new WorktreeError('LOCK_NOT_FOUND', `Lock ${id} was not found.`);
    return readLockRow(row);
  } finally {
    database.close();
  }
}

export function releaseLock(id: string, now: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE worktree_locks
        SET released_at = ?, updated_at = ?
        WHERE id = ?
          AND released_at IS NULL;
      `,
      )
      .run(now, now, id);
  } finally {
    database.close();
  }
}

export function revokeLock(id: string, now: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE worktree_locks
        SET revoked_at = ?, updated_at = ?
        WHERE id = ?
          AND released_at IS NULL
          AND revoked_at IS NULL;
      `,
      )
      .run(now, now, id);
  } finally {
    database.close();
  }
}
