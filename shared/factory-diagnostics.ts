import * as v from 'valibot';
import { deliveryRevisionSchema } from './factory-delivery-revision';
import {
  factoryWorkerHealthSchema,
  factoryWorkerSchema,
  factoryDiagnosticOperationSchema,
  factorySafeErrorSchema,
} from './factory-observability';

const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const time = v.pipe(v.string(), v.isoTimestamp());
export const factoryTimelineQuerySchema = v.strictObject({
  limit: v.optional(v.pipe(natural, v.minValue(1), v.maxValue(100)), 25),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2000))),
});
export const factoryDiagnosticWorkIdSchema = label;
export const factoryTimelineEntrySchema = v.strictObject({
  id: label,
  kind: v.picklist([
    'task',
    'spec',
    'release',
    'withdrawal',
    'audit',
    'planning',
    'planning-receipt',
    'coding',
    'authorization',
    'review',
    'verification',
    'judge',
    'repair',
    'effect',
    'outcome',
  ]),
  recordType: v.picklist(['audit', 'record']),
  occurredAt: v.nullable(time),
  timeBasis: v.picklist(['recorded', 'unknown']),
  actor: v.nullable(
    v.strictObject({
      kind: v.picklist(['human', 'model', 'source', 'unknown']),
      id: label,
    }),
  ),
  summary: label,
  correlation: v.strictObject({
    workItemId: label,
    releaseId: v.optional(label),
    runId: v.optional(label),
    attemptId: v.optional(label),
    submissionId: v.optional(label),
    deliveryId: v.optional(label),
    effectId: v.optional(label),
    specVersion: v.optional(v.pipe(natural, v.minValue(1))),
    specHash: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
  }),
  revision: v.nullable(deliveryRevisionSchema),
  repairTarget: v.optional(v.strictObject({ runId: label, attemptId: label })),
  evidenceRefs: v.pipe(v.array(label), v.maxLength(100)),
});
export const factoryTimelineCoverageSchema = v.strictObject({
  bounded: v.literal(true),
  limit: natural,
  truncated: v.boolean(),
  note: label,
});
export const factoryTimelineSchema = v.strictObject({
  workId: label,
  entries: v.pipe(v.array(factoryTimelineEntrySchema), v.maxLength(100)),
  nextCursor: v.nullable(v.string()),
  coverage: factoryTimelineCoverageSchema,
});
export const factoryTaskDiagnosisSchema = v.strictObject({
  workId: label,
  status: label,
  pendingSince: v.nullable(time),
  pendingAgeMs: v.nullable(natural),
  nextRetryAt: v.nullable(time),
  nextStep: label,
  truncated: v.boolean(),
  budgets: v.pipe(
    v.array(
      v.strictObject({
        deliveryId: label,
        consumedExecutionMs: natural,
        reservedExecutionMs: natural,
        remainingExecutionMs: natural,
        repairsUsed: natural,
        repairsRemaining: natural,
      }),
    ),
    v.maxLength(200),
  ),
  unresolvedEffects: v.pipe(
    v.array(
      v.strictObject({
        deliveryId: v.nullable(label),
        connectionId: v.optional(label),
        effectId: label,
        kind: label,
        state: label,
      }),
    ),
    v.maxLength(200),
  ),
});
export const factoryHealthSchema = v.strictObject({
  generatedAt: time,
  status: v.picklist(['healthy', 'attention', 'not-running']),
  summary: label,
  workers: v.pipe(
    v.array(factoryWorkerHealthSchema),
    v.maxLength(factoryWorkerSchema.options.length),
  ),
  tasks: v.pipe(v.array(factoryTaskDiagnosisSchema), v.maxLength(50)),
  truncated: v.boolean(),
});
// Export fields deliberately exclude raw authority, free-form prose, paths and actors.
// IDs are pseudonymized consistently; hashes/revisions remain useful for diagnosis.
const safeToken = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*:[a-f0-9]{24}$/));
export const factoryDiagnosticExportSchema = v.strictObject({
  schemaVersion: v.literal(1),
  generatedAt: time,
  workId: safeToken,
  notice: v.literal(
    'Local diagnostic summary. IDs are pseudonymized; no raw logs, prompts, paths, credentials or actor identities. Authority records and retained diagnostic spans are distinct; this is not a complete execution trace.',
  ),
  health: v.strictObject({
    status: factoryHealthSchema.entries.status,
    truncated: v.optional(v.boolean(), false),
    workers: v.pipe(
      v.array(
        v.strictObject({
          worker: factoryWorkerSchema,
          status: v.picklist([
            'running',
            'waiting',
            'stopped',
            'stale',
            'not-running',
          ]),
          lastSuccessAt: v.nullable(time),
          nextTickAt: v.nullable(time),
          consecutiveFailures: natural,
        }),
      ),
      v.maxLength(factoryWorkerSchema.options.length),
    ),
    tasks: v.pipe(
      v.array(
        v.strictObject({
          workId: safeToken,
          pendingAgeMs: v.nullable(natural),
          remainingExecutionMs: v.nullable(natural),
          repairsRemaining: v.nullable(natural),
          unresolvedEffectCount: natural,
          truncated: v.optional(v.boolean(), false),
        }),
      ),
      v.maxLength(1),
    ),
  }),
  timeline: v.strictObject({
    entries: v.pipe(
      v.array(
        v.strictObject({
          id: safeToken,
          kind: factoryTimelineEntrySchema.entries.kind,
          recordType: factoryTimelineEntrySchema.entries.recordType,
          occurredAt: v.nullable(time),
          correlation: v.record(
            v.picklist([
              'workItemId',
              'releaseId',
              'runId',
              'attemptId',
              'submissionId',
              'deliveryId',
              'effectId',
            ]),
            safeToken,
          ),
          specVersion: v.nullable(natural),
          specHash: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
          evidenceCount: natural,
        }),
      ),
      v.maxLength(100),
    ),
    truncated: v.boolean(),
  }),
  diagnostics: v.strictObject({
    spans: v.pipe(
      v.array(
        v.strictObject({
          id: safeToken,
          traceId: safeToken,
          parentSpanId: v.nullable(safeToken),
          operation: factoryDiagnosticOperationSchema,
          correlation: v.record(
            v.picklist([
              'workItemId',
              'releaseId',
              'runId',
              'attemptId',
              'submissionId',
              'deliveryId',
              'effectId',
              'intentId',
            ]),
            safeToken,
          ),
          error: v.nullable(v.strictObject(factorySafeErrorSchema.entries)),
          kind: v.picklist(['phase', 'external']),
          startedAt: time,
          finishedAt: time,
          durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
          outcome: v.picklist(['success', 'failure']),
        }),
      ),
      v.maxLength(100),
    ),
    truncated: v.boolean(),
  }),
});
export type FactoryTimelineEntry = v.InferOutput<
  typeof factoryTimelineEntrySchema
>;
export type FactoryTimeline = v.InferOutput<typeof factoryTimelineSchema>;
export type FactoryTaskDiagnosis = v.InferOutput<
  typeof factoryTaskDiagnosisSchema
>;
export type FactoryHealth = v.InferOutput<typeof factoryHealthSchema>;
export type FactoryDiagnosticExport = v.InferOutput<
  typeof factoryDiagnosticExportSchema
>;
