import type { JsonValue } from '@flue/runtime';
import { failedAction } from '../../lib/action-result';
import { asJsonValue } from '../../lib/action-result';
import { parseInput as parseSharedInput } from '../../lib/valibot';
import type { JobRecord } from '../app-state';
import type { SchedulerResult } from './schemas';
import type * as v from 'valibot';

export function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
) {
  return parseSharedInput(schema, input, (message) =>
    failResult(action, 'Invalid action input.', {
      errors: [message],
    }),
  );
}

export function okResult(
  action: string,
  changed: boolean,
  outcome: string | undefined,
  message: string,
  data: {
    jobs?: JobRecord[];
    notifications?: unknown[];
    extra?: unknown;
  } = {},
): SchedulerResult {
  return {
    ok: true,
    action,
    changed,
    ...(outcome ? { outcome } : {}),
    message,
    ...(data.jobs ? { jobs: data.jobs.map(asJsonValue) } : {}),
    ...(data.notifications
      ? { notifications: data.notifications.map(asJsonValue) }
      : {}),
    ...(data.extra ? { extra: asJsonValue(data.extra) } : {}),
  } as SchedulerResult;
}

export const failResult = failedAction<
  Pick<SchedulerResult, 'errors' | 'requires'>
>;

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function readObjectConfig(config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

export function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

export function jsonRecord(value: Record<string, unknown>) {
  return compactObject(value) as Record<string, JsonValue>;
}

export function readJsonRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

export function readJsonArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function numberField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function booleanField(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
