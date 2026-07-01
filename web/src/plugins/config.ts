import type { PluginConfigParseResult } from '../types';

export function plainConfigRecord(value: Record<string, unknown> | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

export function parsePositiveIntegerConfig<T extends Record<string, number>>(
  defaults: T,
  value: Record<string, unknown> | undefined,
): PluginConfigParseResult<T> {
  const source = plainConfigRecord(value);
  const config = { ...defaults };
  const issues: string[] = [];

  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const raw = source[String(key)];
    if (raw === undefined) continue;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
      config[key] = raw as T[typeof key];
    } else {
      issues.push(`${String(key)} must be an integer >= 1.`);
    }
  }

  return { config, issues };
}

export function nonEmptyString(
  value: unknown,
  fallback: string,
  label: string,
  issues: string[],
) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  issues.push(`${label} must be a non-empty string.`);
  return fallback;
}
