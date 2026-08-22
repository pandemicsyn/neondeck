import { failedAction } from '../../lib/action-result';
import { asJsonValue } from '../../lib/action-result';
import { parseInput as parseSharedInput } from '../../lib/valibot';
import { jsonValueSchema } from '../sessions';
import type { SchedulerResult } from './schemas';
import * as v from 'valibot';

const schedulerExternalValueSchema = v.unknown();
export type SchedulerExternalValue = v.InferInput<
  typeof schedulerExternalValueSchema
>;
const schedulerExternalRecordSchema = v.record(
  v.string(),
  schedulerExternalValueSchema,
);
const schedulerOptionalJsonRecordSchema = v.record(
  v.string(),
  v.optional(jsonValueSchema),
);
const schedulerJsonRecordSchema = v.record(v.string(), jsonValueSchema);
export type SchedulerJsonRecord = v.InferOutput<
  typeof schedulerJsonRecordSchema
>;
const schedulerExternalArraySchema = v.array(schedulerExternalValueSchema);
const nonBlankStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const finiteNumberSchema = v.pipe(v.number(), v.finite());
const errorSchema = v.instance(Error);

export function parseActionInput<T>(
  schema: v.GenericSchema<SchedulerExternalValue, T>,
  input: SchedulerExternalValue,
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
    tasks?: SchedulerExternalValue[];
    notifications?: SchedulerExternalValue[];
    extra?: SchedulerExternalValue;
  } = {},
): SchedulerResult {
  const result: SchedulerResult = {
    ok: true,
    action,
    changed,
    message,
  };
  if (outcome) result.outcome = outcome;
  if (data.tasks) result.tasks = data.tasks.map(asJsonValue);
  if (data.notifications) {
    result.notifications = data.notifications.map(asJsonValue);
  }
  if (data.extra !== undefined) result.extra = asJsonValue(data.extra);
  return result;
}

export const failResult = failedAction<
  Pick<SchedulerResult, 'errors' | 'requires'>
>;

export function errorMessage(error: SchedulerExternalValue) {
  const parsedError = v.safeParse(errorSchema, error);
  return parsedError.success ? parsedError.output.message : String(error);
}

export function readObjectConfig(config: SchedulerExternalValue) {
  if (Array.isArray(config)) return {};
  const parsed = v.safeParse(schedulerExternalRecordSchema, config);
  return parsed.success ? parsed.output : {};
}

export function compactObject(
  value: v.InferInput<typeof schedulerOptionalJsonRecordSchema>,
) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

export function jsonRecord(
  value: v.InferInput<typeof schedulerOptionalJsonRecordSchema>,
) {
  return v.parse(schedulerJsonRecordSchema, compactObject(value));
}

export function readJsonRecord(value: SchedulerExternalValue) {
  if (Array.isArray(value)) return null;
  const parsed = v.safeParse(schedulerJsonRecordSchema, value);
  return parsed.success ? parsed.output : null;
}

export function readJsonArray(value: SchedulerExternalValue) {
  const parsed = v.safeParse(schedulerExternalArraySchema, value);
  if (!parsed.success) return [];
  return parsed.output.flatMap((item) => {
    const json = v.safeParse(jsonValueSchema, item);
    return json.success ? [json.output] : [];
  });
}

export function arrayField(value: SchedulerExternalValue) {
  const parsed = v.safeParse(schedulerExternalArraySchema, value);
  return parsed.success ? parsed.output : [];
}

export function stringField(value: SchedulerExternalValue) {
  const parsed = v.safeParse(nonBlankStringSchema, value);
  return parsed.success ? parsed.output : undefined;
}

export function numberField(value: SchedulerExternalValue) {
  const parsed = v.safeParse(finiteNumberSchema, value);
  return parsed.success ? parsed.output : undefined;
}

export function booleanField(value: SchedulerExternalValue) {
  const parsed = v.safeParse(v.boolean(), value);
  return parsed.success ? parsed.output : undefined;
}

export function stableJson(value: SchedulerExternalValue): string {
  return stableExternalJson(value, new WeakSet());
}

function stableExternalJson(
  value: SchedulerExternalValue,
  ancestors: WeakSet<object>,
): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const string = v.safeParse(v.string(), value);
  if (string.success) return JSON.stringify(string.output);
  const number = v.safeParse(finiteNumberSchema, value);
  if (number.success) return JSON.stringify(number.output);
  const boolean = v.safeParse(v.boolean(), value);
  if (boolean.success) return JSON.stringify(boolean.output);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '"[circular]"';
    ancestors.add(value);
    try {
      return `[${value.map((item) => stableExternalJson(item, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  const record = v.safeParse(schedulerExternalRecordSchema, value);
  if (!record.success) return '"[unsupported]"';
  if (ancestors.has(value)) return '"[circular]"';
  ancestors.add(value);
  try {
    return `{${Object.entries(record.output)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${stableExternalJson(item, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
