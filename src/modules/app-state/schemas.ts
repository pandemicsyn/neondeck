import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

const appStateExternalValueSchema = v.unknown();
type AppStateExternalValue = v.InferInput<typeof appStateExternalValueSchema>;

const appStateJsonScalarSchema = v.union([
  v.null(),
  v.string(),
  v.pipe(v.number(), v.finite()),
  v.boolean(),
]);

export const appStateJsonValueSchema: v.GenericSchema<
  AppStateExternalValue,
  JsonValue
> = v.lazy(() =>
  v.union([
    appStateJsonScalarSchema,
    v.array(appStateJsonValueSchema),
    v.record(v.string(), appStateJsonValueSchema),
  ]),
);

export const notificationRowSchema = v.object({
  id: v.string(),
  level: v.picklist(['info', 'ready', 'attention', 'urgent']),
  title: v.string(),
  message: v.string(),
  source: v.nullable(v.string()),
  source_id: v.nullable(v.string()),
  data_json: v.nullable(v.string()),
  read_at: v.nullable(v.string()),
  resolved_at: v.nullable(v.string()),
  occurrence_count: v.optional(v.nullable(v.number())),
  created_at: v.string(),
  updated_at: v.optional(v.nullable(v.string())),
});

export const workflowSummaryRowSchema = v.object({
  id: v.string(),
  workflow: v.string(),
  run_id: v.nullable(v.string()),
  status: v.string(),
  summary_json: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
});

export const kiloTaskSummarySchema = v.object({
  kiloTaskId: v.optional(v.string()),
});
