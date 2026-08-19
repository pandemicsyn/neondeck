import type { Context } from 'hono';
import * as v from 'valibot';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export async function safeJsonBody(c: Context): Promise<JsonValue> {
  // SAFETY: the Fetch JSON decoder only produces JSON-compatible primitives,
  // arrays, and objects; malformed payloads use the empty-object fallback.
  return (await c.req.json().catch(() => ({}))) as JsonValue;
}

export async function safeJsonObject(c: Context): Promise<JsonObject> {
  const body = await safeJsonBody(c);
  return isJsonObject(body) ? body : {};
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return v.is(v.string(), value);
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return Number.isFinite(value);
}

export function boundedQueryLimit(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  return limit;
}

export function queryNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function queryBoolean(value: string | undefined) {
  if (!value) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

export function kiloSessionQuery(c: Context) {
  return {
    limit: queryNumber(c.req.query('limit')),
    offset: queryNumber(c.req.query('offset')),
    maxBytes: queryNumber(c.req.query('maxBytes')),
    includeFullTranscript: queryBoolean(c.req.query('includeFullTranscript')),
    includeToolOutput: queryBoolean(c.req.query('includeToolOutput')),
    includeDiff: queryBoolean(c.req.query('includeDiff')),
    requesterSurface: c.req.query('requesterSurface') ?? 'dashboard',
    readReason: c.req.query('readReason') ?? 'dashboard-kilo-session-read',
  };
}

export function preparedDiffHttpStatus(result: {
  ok: boolean;
  error?: { code?: string };
}) {
  if (result.ok) return 200;
  if (result.error?.code === 'PREPARED_DIFF_NOT_FOUND') return 404;
  return 400;
}
