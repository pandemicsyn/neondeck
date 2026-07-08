import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { asJsonValue } from './action-result';

export type OpenDbOptions = {
  readOnly?: boolean;
};

export const defaultSqliteBusyTimeoutMs = 5000;

export function openDb(path: string, options: OpenDbOptions = {}) {
  return configureDb(new DatabaseSync(path, options));
}

export function configureDb(database: DatabaseSync) {
  database.exec(`PRAGMA busy_timeout = ${defaultSqliteBusyTimeoutMs};`);
  return database;
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
