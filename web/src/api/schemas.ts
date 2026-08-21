import * as v from 'valibot';

export const webExternalValueSchema = v.unknown();
export type WebExternalValue = v.InferInput<typeof webExternalValueSchema>;

export const webExternalRecordSchema = v.pipe(
  v.record(v.string(), webExternalValueSchema),
  v.check((value) => !Array.isArray(value), 'Expected an object record.'),
);
export type WebExternalRecord = v.InferOutput<typeof webExternalRecordSchema>;

export const webErrorSchema = v.instance(Error);

export type WebJsonValue =
  | null
  | boolean
  | number
  | string
  | WebJsonValue[]
  | { [key: string]: WebJsonValue };

export type WebJsonRecord = { [key: string]: WebJsonValue };

export const webJsonValueSchema: v.GenericSchema<
  WebExternalValue,
  WebJsonValue
> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(webJsonValueSchema),
    v.record(v.string(), webJsonValueSchema),
  ]),
);

export function externalErrorMessage(error: WebExternalValue) {
  const parsed = v.safeParse(webErrorSchema, error);
  return parsed.success ? parsed.output.message : String(error);
}

export function externalRecord(value: WebExternalValue) {
  const parsed = v.safeParse(webExternalRecordSchema, value);
  return parsed.success ? parsed.output : null;
}
