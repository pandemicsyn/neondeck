import type { PluginConfigParseResult } from '../types';
import {
  webExternalRecordSchema,
  webJsonValueSchema,
  type WebExternalValue,
  type WebJsonRecord,
  type WebJsonValue,
} from '../api/schemas';
import * as v from 'valibot';

const plainConfigRecordSchema = v.pipe(
  webExternalRecordSchema,
  v.record(v.string(), webJsonValueSchema),
);

export function plainConfigRecord(value: WebExternalValue): WebJsonRecord {
  const parsed = v.safeParse(plainConfigRecordSchema, value);
  return parsed.success ? parsed.output : {};
}

export function parsePositiveIntegerConfig<T extends Record<string, number>>(
  defaults: T,
  value: WebExternalValue,
): PluginConfigParseResult<T> {
  const source = plainConfigRecord(value);
  const config = { ...defaults };
  const issues: string[] = [];

  for (const [key] of Object.entries(defaults)) {
    const raw = source[key];
    if (raw === undefined) continue;
    const parsed = v.safeParse(
      v.pipe(v.number(), v.integer(), v.minValue(1)),
      raw,
    );
    if (!parsed.success) {
      issues.push(`${String(key)} must be an integer >= 1.`);
      continue;
    }
    Object.assign(config, { [key]: parsed.output });
  }

  return { config, issues };
}

export function nonEmptyString(
  value: WebJsonValue | undefined,
  fallback: string,
  label: string,
  issues: string[],
) {
  if (value === undefined) return fallback;
  const parsed = v.safeParse(
    v.pipe(v.string(), v.trim(), v.minLength(1)),
    value,
  );
  if (parsed.success) return parsed.output;
  issues.push(`${label} must be a non-empty string.`);
  return fallback;
}
