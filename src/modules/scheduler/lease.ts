import { randomUUID } from 'node:crypto';
import { isSqliteBusy, openDb, rollbackQuietly } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import type {
  SchedulerTickLeaseRenewResult,
  SchedulerTickLeaseResult,
} from './schemas';
import { schedulerTickLeaseKey, schedulerTickLeaseSchema } from './schemas';
import { errorMessage } from './utils';
import * as v from 'valibot';

const sqliteExternalValueSchema = v.unknown();
type SqliteExternalValue = v.InferInput<typeof sqliteExternalValueSchema>;
const metadataValueRowSchema = v.object({ value: v.string() });

export function acquireSchedulerTickLease(
  paths: RuntimePaths,
  now: Date,
  ttlMs: number,
): SchedulerTickLeaseResult {
  const database = openDb(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    if (existingLease && Date.parse(existingLease.expiresAt) > now.getTime()) {
      database.exec('COMMIT;');
      return { acquired: false, reason: 'active' };
    }

    const acquiredAt = now.toISOString();
    const lease = v.parse(schedulerTickLeaseSchema, {
      owner: `pid-${process.pid}-${randomUUID()}`,
      acquiredAt,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run(schedulerTickLeaseKey, JSON.stringify(lease), acquiredAt);
    database.exec('COMMIT;');

    return { acquired: true, owner: lease.owner };
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return { acquired: false, reason: 'busy' };
    throw error;
  } finally {
    database.close();
  }
}

export function startSchedulerTickLeaseHeartbeat(
  paths: RuntimePaths,
  owner: string,
  ttlMs: number,
) {
  const intervalMs = Math.max(10, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    try {
      const result = renewSchedulerTickLease(paths, owner, new Date(), ttlMs);
      if (result === 'lost') {
        clearInterval(timer);
      }
    } catch (error) {
      console.warn(
        `[neondeck] scheduler tick lease heartbeat failed: ${errorMessage(error)}`,
      );
    }
  }, intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
}

export function renewSchedulerTickLease(
  paths: RuntimePaths,
  owner: string,
  now: Date,
  ttlMs: number,
): SchedulerTickLeaseRenewResult {
  const database = openDb(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    if (existingLease?.owner !== owner) {
      database.exec('COMMIT;');
      return 'lost';
    }

    const renewedLease = {
      ...existingLease,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    database
      .prepare(
        `
        UPDATE app_metadata
        SET value = ?, updated_at = ?
        WHERE key = ?;
      `,
      )
      .run(
        JSON.stringify(renewedLease),
        now.toISOString(),
        schedulerTickLeaseKey,
      );
    database.exec('COMMIT;');
    return 'renewed';
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return 'busy';
    throw error;
  } finally {
    database.close();
  }
}

export function isSchedulerTickLeaseOwned(
  paths: RuntimePaths,
  owner: string,
  now: Date,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    return (
      existingLease?.owner === owner &&
      Date.parse(existingLease.expiresAt) > now.getTime()
    );
  } finally {
    database.close();
  }
}

export async function releaseSchedulerTickLease(
  paths: RuntimePaths,
  owner: string,
) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const released = releaseSchedulerTickLeaseOnce(paths, owner);
    if (released) return;
    if (attempt < maxAttempts) {
      await sleep(25 * attempt);
    }
  }

  console.warn(
    '[neondeck] scheduler tick lease release was blocked by SQLite; lease will expire automatically.',
  );
}

export function releaseSchedulerTickLeaseOnce(
  paths: RuntimePaths,
  owner: string,
) {
  const database = openDb(paths.neondeckDatabase);

  try {
    database.exec('BEGIN IMMEDIATE;');
    const existing = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(schedulerTickLeaseKey);
    const existingLease = parseSchedulerTickLease(readMetadataValue(existing));
    if (existingLease?.owner === owner) {
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(schedulerTickLeaseKey);
    }
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    if (isSqliteBusy(error)) return false;
    throw error;
  } finally {
    database.close();
  }
}

export function parseSchedulerTickLease(value: string | undefined) {
  if (!value) return;

  try {
    const parsed = v.safeParse(schedulerTickLeaseSchema, JSON.parse(value));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return;
  }
}

export function readMetadataValue(row: SqliteExternalValue) {
  const parsed = v.safeParse(metadataValueRowSchema, row);
  return parsed.success ? parsed.output.value : undefined;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
