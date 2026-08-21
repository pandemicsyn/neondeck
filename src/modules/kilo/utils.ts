import { type WriteStream } from 'node:fs';
import * as v from 'valibot';
import { invalidInputAction } from '../../lib/action-result';
import { parseInput as parseActionInput } from '../../lib/valibot';

const untrustedInputSchema = v.unknown();
const looseObjectSchema = v.looseObject({});
const stringSchema = v.string();
const numberSchema = v.number();
const errorSchema = v.instance(Error);

export type KiloUntrustedInput = v.InferInput<typeof untrustedInputSchema>;

export function stringField(row: KiloUntrustedInput, keys: string[]) {
  const parsedRow = v.safeParse(looseObjectSchema, row);
  if (!parsedRow.success) return undefined;
  for (const key of keys) {
    const parsedValue = v.safeParse(stringSchema, parsedRow.output[key]);
    if (parsedValue.success && parsedValue.output.trim()) {
      return parsedValue.output;
    }
  }
  return undefined;
}

export function numberOrDateField(row: KiloUntrustedInput, keys: string[]) {
  const parsedRow = v.safeParse(looseObjectSchema, row);
  if (!parsedRow.success) return undefined;
  for (const key of keys) {
    const parsedNumber = v.safeParse(numberSchema, parsedRow.output[key]);
    if (parsedNumber.success) return parsedNumber.output;
    const parsedString = v.safeParse(stringSchema, parsedRow.output[key]);
    if (parsedString.success) {
      const numeric = Number(parsedString.output);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(parsedString.output);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function parseJsonLine(
  line: string,
): { ok: true; value: KiloUntrustedInput } | { ok: false } {
  try {
    return { ok: true, value: v.parse(untrustedInputSchema, JSON.parse(line)) };
  } catch {
    return { ok: false };
  }
}

export function eventType(value: KiloUntrustedInput) {
  return stringField(value, ['type']) ?? 'json';
}

export function topLevelSessionId(value: KiloUntrustedInput) {
  return stringField(value, ['sessionID', 'sessionId']);
}

export function extractSessionIds(value: KiloUntrustedInput) {
  const ids = new Set<string>();
  const visit = (item: KiloUntrustedInput) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const parsedItem = v.safeParse(looseObjectSchema, item);
    if (!parsedItem.success) return;
    for (const [key, child] of Object.entries(parsedItem.output)) {
      if (key === 'sessionID' || key === 'sessionId') {
        const parsedId = v.safeParse(stringSchema, child);
        if (parsedId.success) ids.add(parsedId.output);
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return [...ids];
}

export function summarizeEvent(value: KiloUntrustedInput) {
  const parsedValue = v.safeParse(looseObjectSchema, value);
  if (!parsedValue.success) return 'Kilo emitted an event.';
  const type = eventType(value);
  const directPart = v.safeParse(looseObjectSchema, parsedValue.output.part);
  const properties = v.safeParse(
    looseObjectSchema,
    parsedValue.output.properties,
  );
  const nestedPart = properties.success
    ? v.safeParse(looseObjectSchema, properties.output.part)
    : undefined;
  const part = directPart.success
    ? directPart.output
    : nestedPart?.success
      ? nestedPart.output
      : undefined;
  const partType = part ? v.safeParse(stringSchema, part.type) : undefined;
  if (part && partType?.success) {
    const text = v.safeParse(stringSchema, part.text);
    if (partType.output === 'text' && text.success) {
      return truncate(text.output.trim() || `${type}: text`, 1_000);
    }
    if (partType.output === 'tool') {
      const tool = v.safeParse(stringSchema, part.tool);
      const state = v.safeParse(looseObjectSchema, part.state);
      const status = state.success
        ? v.safeParse(stringSchema, state.output.status)
        : undefined;
      return `${type}: ${tool.success ? tool.output : 'tool'} ${status?.success ? status.output : 'updated'}`;
    }
    return `${type}: ${partType.output}`;
  }
  const error = v.safeParse(stringSchema, parsedValue.output.error);
  if (error.success) return truncate(error.output, 1_000);
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

export function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  rawInput: KiloUntrustedInput,
  action: string,
):
  | { ok: true; input: v.InferOutput<TSchema> }
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

export function errorMessage(error: KiloUntrustedInput) {
  const parsedError = v.safeParse(errorSchema, error);
  if (parsedError.success) return parsedError.output.message;
  return String(error);
}
