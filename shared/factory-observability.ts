import * as v from 'valibot';

const id = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(/^[A-Za-z0-9:_-]+$/),
);
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
export const factoryDiagnosticRetention = {
  maxRecords: 10000,
  maxAgeMs: 7 * 86400000,
} as const;
export const factoryCorrelationSchema = v.strictObject({
  workItemId: v.optional(id),
  releaseId: v.optional(id),
  runId: v.optional(id),
  attemptId: v.optional(id),
  submissionId: v.optional(id),
  deliveryId: v.optional(id),
  effectId: v.optional(id),
  intentId: v.optional(id),
});
export const factoryDiagnosticOperationSchema = v.picklist([
  'github.tick',
  'github.sync',
  'github.writeback',
  'github.writeback-controller',
  'github.publish',
  'github.source',
  'coding.tick',
  'coding.prepare',
  'coding.launch',
  'coding.inspect',
  'coding.reconcile',
  'coding.cancel',
  'coding.collect',
  'delivery.tick',
  'delivery.advance',
  'delivery.verification',
  'delivery.review',
  'delivery.progress',
  'delivery.commit',
  'delivery.push',
  'delivery.create-pr',
  'delivery.recover',
  'delivery.repair',
  'delivery.watch',
  'planning.dispatch',
  'planning.read',
  'planning.abort',
]);
export const factorySafeErrorSchema = v.object({
  class: v.picklist([
    'abort',
    'timeout',
    'validation',
    'io',
    'http',
    'model',
    'unknown',
  ]),
  code: v.picklist([
    'ABORTED',
    'TIMEOUT',
    'VALIDATION',
    'ENOENT',
    'EACCES',
    'EPERM',
    'ENOSPC',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'HTTP_400',
    'HTTP_401',
    'HTTP_403',
    'HTTP_404',
    'HTTP_409',
    'HTTP_410',
    'HTTP_422',
    'HTTP_429',
    'HTTP_5XX',
    'operation_failed',
    'submission_interrupted',
    'submission_retry_exhausted',
    'submission_timeout',
    'AGENT_FAILED',
    'AGENT_ABORTED',
    'UNKNOWN',
  ]),
});
export const factoryDiagnosticSchema = v.object({
  sequence: count,
  id,
  traceId: id,
  parentSpanId: v.nullable(id),
  operation: factoryDiagnosticOperationSchema,
  kind: v.picklist(['phase', 'external']),
  startedAt: timestamp,
  finishedAt: timestamp,
  durationMs: v.pipe(v.number(), v.minValue(0)),
  outcome: v.picklist(['success', 'failure']),
  correlation: factoryCorrelationSchema,
  error: v.nullable(factorySafeErrorSchema),
});
export const factoryDiagnosticQuerySchema = v.strictObject({
  workItemId: v.optional(id),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
    100,
  ),
  before: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const factoryDiagnosticPageSchema = v.object({
  records: v.array(factoryDiagnosticSchema),
  nextBefore: v.nullable(count),
});
export const factoryWorkerSchema = v.picklist(['github', 'coding', 'delivery']);
export const factoryWorkerHealthSchema = v.object({
  worker: factoryWorkerSchema,
  status: v.picklist(['running', 'waiting', 'stopped', 'stale', 'not-running']),
  ownerPid: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  lastHeartbeatAt: v.nullable(timestamp),
  instanceId: v.nullable(id),
  startedAt: v.nullable(timestamp),
  lastTickAt: v.nullable(timestamp),
  lastSuccessAt: v.nullable(timestamp),
  lastFailureAt: v.nullable(timestamp),
  nextTickAt: v.nullable(timestamp),
  consecutiveFailures: count,
  totalFailures: count,
  staleAfterMs: count,
  lastError: v.nullable(factorySafeErrorSchema),
  diagnosticsDegraded: v.boolean(),
});
export type FactoryCorrelation = v.InferOutput<typeof factoryCorrelationSchema>;
export type FactoryDiagnostic = v.InferOutput<typeof factoryDiagnosticSchema>;
export type FactoryWorkerHealth = v.InferOutput<
  typeof factoryWorkerHealthSchema
>;
export type FactorySafeError = v.InferOutput<typeof factorySafeErrorSchema>;
export type FactoryDiagnosticOperation = v.InferOutput<
  typeof factoryDiagnosticOperationSchema
>;
export type FactoryWorker = v.InferOutput<typeof factoryWorkerSchema>;
