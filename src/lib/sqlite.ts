import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';
import * as v from 'valibot';
import { asJsonValue } from './action-result';

export type OpenDbOptions = DatabaseSyncOptions;

export const defaultSqliteBusyTimeoutMs = 5000;

export function openDb(path: string, options: OpenDbOptions = {}) {
  const busyTimeoutMs = options.timeout ?? defaultSqliteBusyTimeoutMs;
  return configureDb(
    new DatabaseSync(path, {
      ...options,
      timeout: busyTimeoutMs,
    }),
    busyTimeoutMs,
  );
}

export function configureDb(
  database: DatabaseSync,
  busyTimeoutMs = defaultSqliteBusyTimeoutMs,
) {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  database.exec('PRAGMA foreign_keys = ON;');
  return database;
}

export function enableWal(database: DatabaseSync) {
  database.exec('PRAGMA journal_mode = WAL;');
  return database;
}

export function rollbackQuietly(database: DatabaseSync) {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Preserve the original transaction failure when BEGIN did not succeed.
  }
}

export function withTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  mode: 'deferred' | 'immediate' = 'deferred',
) {
  let transactionOpen = false;
  try {
    database.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE;' : 'BEGIN;');
    transactionOpen = true;
    const result = operation();
    if (
      result !== null &&
      typeof result === 'object' &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      throw new Error(
        'SQLite transaction callbacks must be synchronous; do not hold an app database transaction across await.',
      );
    }
    database.exec('COMMIT;');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) rollbackQuietly(database);
    throw error;
  }
}

export function withImmediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
) {
  return withTransaction(database, operation, 'immediate');
}

export function isSqliteBusy(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED') ||
    message.includes('database is locked')
  );
}

export function parseRow<T>(
  row: unknown,
  schema: v.GenericSchema<unknown, T>,
  context: string,
): T {
  const parsed = v.safeParse(schema, row);
  if (parsed.success) return parsed.output;
  throw new Error(`${context}: ${v.summarize(parsed.issues)}`);
}

export function readJsonColumn<T = unknown>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
}

export function writeJsonColumn(value: unknown): string {
  return JSON.stringify(asJsonValue(value));
}

export function writeNullableJsonColumn(value: unknown | null | undefined) {
  return value == null ? null : writeJsonColumn(value);
}

export const nullableStringColumnSchema = v.nullable(v.string());
export const nullableNumberColumnSchema = v.nullable(v.number());
export const nullableBooleanColumnSchema = v.nullable(v.boolean());

export function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}
