import { type WriteStream } from 'node:fs';
import * as v from 'valibot';
import { invalidInputAction } from '../../lib/action-result';
import { parseInput as parseActionInput } from '../../lib/valibot';

export function stringField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function numberOrDateField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function parseJsonLine(
  line: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    return { ok: false };
  }
}

export function eventType(value: unknown) {
  if (isRecord(value) && typeof value.type === 'string') return value.type;
  return 'json';
}

export function topLevelSessionId(value: unknown) {
  if (!isRecord(value)) return undefined;
  const candidate = value.sessionID ?? value.sessionId;
  return typeof candidate === 'string' ? candidate : undefined;
}

export function extractSessionIds(value: unknown) {
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (
        (key === 'sessionID' || key === 'sessionId') &&
        typeof child === 'string'
      ) {
        ids.add(child);
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return [...ids];
}

export function summarizeEvent(value: unknown) {
  if (!isRecord(value)) return 'Kilo emitted an event.';
  const type = eventType(value);
  const part = isRecord(value.part)
    ? value.part
    : isRecord(value.properties) && isRecord(value.properties.part)
      ? value.properties.part
      : undefined;
  if (part && typeof part.type === 'string') {
    if (part.type === 'text' && typeof part.text === 'string') {
      return truncate(part.text.trim() || `${type}: text`, 1_000);
    }
    if (part.type === 'tool') {
      const tool = typeof part.tool === 'string' ? part.tool : 'tool';
      const status =
        isRecord(part.state) && typeof part.state.status === 'string'
          ? part.state.status
          : 'updated';
      return `${type}: ${tool} ${status}`;
    }
    return `${type}: ${part.type}`;
  }
  if (typeof value.error === 'string') return truncate(value.error, 1_000);
  return type;
}

export function writeRawLog(
  rawLog: WriteStream | undefined,
  stream: string,
  line: string,
) {
  rawLog?.write(
    `${JSON.stringify({ stream, line, receivedAt: new Date().toISOString() })}\n`,
  );
}

export function splitRepoFullName(fullName: string) {
  const [owner = 'unknown', name = 'unknown'] = fullName.split('/');
  return { owner, name };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseInput<T>(
  schema: v.GenericSchema<unknown, T>,
  rawInput: unknown,
  action: string,
):
  | { ok: true; input: T }
  | { ok: false; result: ReturnType<typeof invalidInputResult> } {
  return parseActionInput(
    schema,
    rawInput,
    (message) => invalidInputResult(action, message),
    (issues) => issues[0]?.message ?? 'Invalid input.',
  );
}

export const invalidInputResult = invalidInputAction;

export function failResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'KILO_HANDOFF_ERROR', message },
  };
}

export function notFoundResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'KILO_NOT_FOUND', message },
  };
}

export function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
