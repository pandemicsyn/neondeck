import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export const runtimeExternalValueSchema = v.unknown();
export type RuntimeExternalValue = v.InferInput<
  typeof runtimeExternalValueSchema
>;
export const runtimeExternalRecordSchema = v.record(
  v.string(),
  runtimeExternalValueSchema,
);
export const runtimeErrorSchema = v.instance(Error);
export const runtimeFiniteNumberSchema = v.pipe(v.number(), v.finite());
const runtimeJsonScalarSchema = v.union([
  v.null(),
  v.string(),
  runtimeFiniteNumberSchema,
  v.boolean(),
]);
export const runtimeJsonValueSchema: v.GenericSchema<
  RuntimeExternalValue,
  JsonValue
> = v.lazy(() =>
  v.union([
    runtimeJsonScalarSchema,
    v.array(runtimeJsonValueSchema),
    v.record(v.string(), runtimeJsonValueSchema),
  ]),
);
export const runtimeJsonRecordSchema = v.record(
  v.string(),
  runtimeJsonValueSchema,
);
export type RuntimeJsonRecord = v.InferOutput<typeof runtimeJsonRecordSchema>;
