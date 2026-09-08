import * as v from 'valibot';
import {
  codingAdapterIdentitySchema,
  codingAdapterMetadataSchema,
} from './coding-adapters';
import {
  codingPublicRunSnapshotSchema,
  codingRunStatusSchema,
  codingCandidateEvidenceSchema,
  codingRunEventSchema,
} from './coding-runs';
const label = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4096));
const absolute = v.pipe(label, v.regex(/^\//));
export const factoryCodingConfigSchema = v.strictObject({
  enabled: v.optional(v.boolean(), false),
  adapter: v.optional(v.nullable(codingAdapterIdentitySchema), null),
  executable: v.optional(v.nullable(absolute), null),
  model: v.optional(v.nullable(label), null),
  auth: v.optional(
    v.nullable(
      v.union([
        v.strictObject({
          kind: v.picklist(['api-key', 'auth-json']),
          env: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]{0,127}$/)),
        }),
        v.strictObject({
          kind: v.literal('codex-local'),
          path: v.pipe(absolute, v.endsWith('/auth.json')),
        }),
      ]),
    ),
    null,
  ),
  path: v.optional(
    v.pipe(
      label,
      v.check((s) => s.split(':').every((p) => p.startsWith('/'))),
    ),
    '/usr/bin:/bin',
  ),
  sandbox: v.optional(v.literal('workspace-write'), 'workspace-write'),
  wallTimeMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(2700000)),
    2700000,
  ),
  maxOutputBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(67108864)),
    8388608,
  ),
  maxWriters: v.optional(v.literal(1), 1),
  // No decoder default: historical admitted policies retain legacy discovery.
  repositorySkills: v.optional(v.literal('native-v1')),
});
export type FactoryCodingConfig = v.InferOutput<
  typeof factoryCodingConfigSchema
>;
/** Current settings for a new human release, never for a frozen snapshot. */
export function effectiveFactoryCodingConfig(
  input: unknown,
): FactoryCodingConfig {
  return {
    ...v.parse(factoryCodingConfigSchema, input),
    repositorySkills: 'native-v1',
  };
}
export const factoryCodingReadinessSchema = v.strictObject({
  ready: v.boolean(),
  enabled: v.boolean(),
  supportedVersion: label,
  installedVersion: v.nullable(label),
  blockers: v.array(label),
  authentication: v.optional(v.picklist(['unavailable', 'unverified'])),
  status: v.optional(
    v.picklist([
      'disabled',
      'unconfigured',
      'host-unsupported',
      'adapter-unavailable',
      'credential-unavailable',
      'executable-unresolved',
      'unsupported',
      'ready',
      'busy',
    ]),
  ),
});
export const validationAdmissionAttentionSchema = v.strictObject({
  blocker: v.picklist(['policy-changed', 'candidate-unavailable']),
  message: label,
  observedAt: v.pipe(v.string(), v.isoTimestamp()),
  nextAction: v.picklist([
    'review-plan',
    'retry-validation',
    'inspect-diagnostics',
  ]),
  reasonCode: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,79}$/))),
  recovery: v.optional(label),
  diagnosticReference: v.optional(v.pipe(v.string(), v.uuid())),
  stage: v.optional(v.picklist(['authority', 'preview', 'authorization'])),
});
export type ValidationAdmissionAttention = v.InferOutput<
  typeof validationAdmissionAttentionSchema
>;
export const factoryCodingRunSchema = v.strictObject({
  validationAdmission: v.optional(
    v.nullable(validationAdmissionAttentionSchema),
  ),
  record: v.strictObject({
    runId: label,
    attemptId: label,
    version: v.number(),
    snapshot: codingPublicRunSnapshotSchema,
    status: codingRunStatusSchema,
    workspace: v.nullable(v.strictObject({ worktreeId: label })),
    providerSessionId: v.nullable(label),
    cancelRequestedAt: v.nullable(label),
    cancelReason: v.nullable(label),
    reason: v.nullable(label),
    candidate: v.nullable(codingCandidateEvidenceSchema),
    createdAt: label,
    updatedAt: label,
    completedAt: v.nullable(label),
    cleanupAttentionAt: v.nullable(label),
    evidenceRetainUntil: v.nullable(label),
  }),
  displayStatus: v.picklist([
    'reserved',
    'running',
    'cancelling',
    'collecting',
    'needs-reconcile',
    'candidate-awaiting-review',
    'failed',
    'cancelled',
  ]),
  diff: v.nullable(
    v.strictObject({ worktreeId: label, preparedDiffId: label }),
  ),
});
export const factoryCodingStateSchema = v.strictObject({
  config: factoryCodingConfigSchema,
  configFingerprint: label,
  readiness: factoryCodingReadinessSchema,
  adapters: v.optional(v.array(codingAdapterMetadataSchema), []),
});
export const factoryCodingAttentionSchema = v.strictObject({
  workId: label,
  inputFingerprint: label,
  reason: label,
  updatedAt: label,
});
export const factoryCodingPageSchema = v.strictObject({
  attention: v.optional(v.nullable(factoryCodingAttentionSchema), null),
  items: v.array(
    v.strictObject({ sequence: v.number(), run: factoryCodingRunSchema }),
  ),
  nextCursor: v.nullable(v.number()),
});
export const factoryCodingEventsSchema = v.strictObject({
  items: v.array(codingRunEventSchema),
  nextCursor: v.nullable(v.number()),
});
export const factoryCodingControlSchema = v.strictObject({
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export const factoryCodingLogsSchema = v.strictObject({
  text: v.pipe(v.string(), v.maxLength(65536)),
  nextOffset: v.number(),
  truncated: v.boolean(),
});
export type FactoryCodingRun = v.InferOutput<typeof factoryCodingRunSchema>;
export type FactoryCodingState = v.InferOutput<typeof factoryCodingStateSchema>;
export type FactoryCodingPage = v.InferOutput<typeof factoryCodingPageSchema>;
export type FactoryCodingEvents = v.InferOutput<
  typeof factoryCodingEventsSchema
>;
export type FactoryCodingLogs = v.InferOutput<typeof factoryCodingLogsSchema>;

export const factoryCodingConfigInputSchema = v.strictObject({
  expectedFingerprint: label,
  config: factoryCodingConfigSchema,
});
