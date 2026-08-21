import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';
import * as v from 'valibot';
import { asJsonValue } from './action-result';

export type OpenDbOptions = DatabaseSyncOptions;

export const defaultSqliteBusyTimeoutMs = 5000;

const thenableSchema = v.looseObject({ then: v.function() });

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
    if (v.safeParse(thenableSchema, result).success) {
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

export function isSqliteBusy<TError>(error: TError) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED') ||
    message.includes('database is locked')
  );
}

export function parseRow<T, TRow>(
  row: TRow,
  schema: v.GenericSchema<unknown, T>,
  context: string,
): T {
  const parsed = v.safeParse(schema, row);
  if (parsed.success) return parsed.output;
  throw new Error(`${context}: ${v.summarize(parsed.issues)}`);
}

export function collectValidRowsInBatches<TInput, TOutput>(
  limit: number,
  readBatch: (limit: number, offset: number) => TInput[],
  hydrate: (row: TInput) => readonly TOutput[],
) {
  if (limit <= 0) return [];
  const output: TOutput[] = [];
  const batchSize = Math.max(1, limit);
  let offset = 0;
  while (output.length < limit) {
    const rows = readBatch(batchSize, offset);
    for (const row of rows) {
      for (const value of hydrate(row)) {
        output.push(value);
        if (output.length === limit) return output;
      }
    }
    if (rows.length < batchSize) break;
    offset += rows.length;
  }
  return output;
}

export function readJsonColumn<T = never>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value);
}

export function writeJsonColumn<TValue>(value: TValue): string {
  return JSON.stringify(asJsonValue(value));
}

export function writeNullableJsonColumn<TValue>(
  value: TValue | null | undefined,
) {
  return value == null ? null : writeJsonColumn(value);
}

export const nullableStringColumnSchema = v.nullable(v.string());
export const nullableNumberColumnSchema = v.nullable(v.number());
export const nullableBooleanColumnSchema = v.nullable(v.boolean());

export function isUniqueConstraintError<TError>(error: TError) {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}
