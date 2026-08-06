import { z } from 'zod';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema = z.custom<JsonValue>(
  (value) => isJsonValue(value, new WeakSet<object>()),
  'Expected a finite, acyclic JSON value.',
);

export const jsonObjectSchema = z.custom<JsonObject>(
  (value) => isPlainObject(value) && isJsonValue(value, new WeakSet<object>()),
  'Expected a finite, acyclic JSON object.',
);

function isJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isJsonValue(value[index], ancestors)) {
          return false;
        }
      }
      return true;
    }
    if (!isPlainObject(value)) return false;
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
      return false;
    }
    return Object.values(value).every((item) => isJsonValue(item, ancestors));
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
