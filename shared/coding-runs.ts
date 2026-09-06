import * as v from 'valibot';

export const codingLabelSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(500),
);
const body = v.pipe(v.string(), v.minLength(1), v.maxLength(100000));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const version = v.pipe(natural, v.minValue(1));
const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const codingTimeSchema = v.pipe(v.string(), v.isoTimestamp());
// Serialized caller snapshots are deliberately opaque to this provider-neutral layer.
// Admission validates their domain semantics; these exact bytes are immutable here.
export const codingRunSnapshotSchema = v.strictObject({
  requestId: codingLabelSchema,
  workItemId: codingLabelSchema,
  releaseId: codingLabelSchema,
  specVersion: version,
  specHash: hash,
  specSnapshot: body,
  sourceId: codingLabelSchema,
  sourceSnapshot: body,
  repoId: codingLabelSchema,
  repoSnapshot: body,
  policySnapshot: body,
  contextSnapshot: body,
  baseSha: sha,
  harness: v.strictObject({
    provider: codingLabelSchema,
    version: codingLabelSchema,
    model: codingLabelSchema,
  }),
  sessionMode: v.literal('fresh'),
});
export const codingRunStatusSchema = v.picklist([
  'reserved',
  'running',
  'collecting',
  'needs-reconcile',
  'candidate',
  'failed',
  'cancelled',
]);
export const codingHostIdentitySchema = v.strictObject({
  hostId: codingLabelSchema,
  jobId: codingLabelSchema,
});
export const codingWorkspaceSchema = v.strictObject({
  worktreeId: codingLabelSchema,
  lockId: codingLabelSchema,
});
export const codingDeadProofSchema = v.strictObject({
  runId: codingLabelSchema,
  attemptId: codingLabelSchema,
  ownershipToken: codingLabelSchema,
  host: v.nullable(codingHostIdentitySchema),
  kind: v.picklist(['never-started', 'verified-dead']),
  evidenceRef: codingLabelSchema,
});
export const codingCandidateEvidenceSchema = v.strictObject({
  baseSha: sha,
  headSha: sha,
  worktreeId: codingLabelSchema,
  statusRef: codingLabelSchema,
  diffRef: codingLabelSchema,
  includesUntracked: v.literal(true),
});
export const codingRunRecordSchema = v.pipe(
  v.strictObject({
    runId: codingLabelSchema,
    attemptId: codingLabelSchema,
    ownershipToken: codingLabelSchema,
    version,
    snapshot: codingRunSnapshotSchema,
    status: codingRunStatusSchema,
    host: v.nullable(codingHostIdentitySchema),
    workspace: v.nullable(codingWorkspaceSchema),
    providerSessionId: v.nullable(codingLabelSchema),
    cancelRequestedAt: v.nullable(codingTimeSchema),
    cancelReason: v.nullable(codingLabelSchema),
    reason: v.nullable(codingLabelSchema),
    deadProof: v.nullable(codingDeadProofSchema),
    candidate: v.nullable(codingCandidateEvidenceSchema),
    createdAt: codingTimeSchema,
    updatedAt: codingTimeSchema,
    completedAt: v.nullable(codingTimeSchema),
    cleanupAttentionAt: v.nullable(codingTimeSchema),
    evidenceRetainUntil: v.nullable(codingTimeSchema),
  }),
  v.check((r) => {
    const terminal = ['candidate', 'failed', 'cancelled'].includes(r.status);
    return (
      terminal === (r.deadProof !== null) &&
      terminal === (r.completedAt !== null) &&
      terminal === (r.cleanupAttentionAt !== null) &&
      terminal === (r.evidenceRetainUntil !== null) &&
      (r.status !== 'candidate' ||
        (r.candidate !== null &&
          r.providerSessionId !== null &&
          r.workspace !== null)) &&
      (r.cancelRequestedAt === null) === (r.cancelReason === null) &&
      (r.status !== 'cancelled' || r.cancelRequestedAt !== null) &&
      (r.status !== 'candidate' || r.cancelRequestedAt === null) &&
      (r.status === 'candidate') === (r.candidate !== null) &&
      (!['running', 'collecting'].includes(r.status) ||
        (r.host !== null && r.workspace !== null)) &&
      (r.providerSessionId === null || r.host !== null) &&
      (r.deadProof === null ||
        (r.deadProof.runId === r.runId &&
          r.deadProof.attemptId === r.attemptId &&
          r.deadProof.ownershipToken === r.ownershipToken &&
          JSON.stringify(r.deadProof.host) === JSON.stringify(r.host) &&
          (r.deadProof.kind === 'never-started') === (r.host === null))) &&
      (r.candidate === null ||
        (r.candidate.baseSha === r.snapshot.baseSha &&
          r.candidate.worktreeId === r.workspace?.worktreeId))
    );
  }, 'Inconsistent coding run lifecycle'),
);
export const codingRunGuardSchema = v.strictObject({
  runId: codingLabelSchema,
  attemptId: codingLabelSchema,
  ownershipToken: codingLabelSchema,
  expectedVersion: version,
});
export const codingRunCommandSchema = v.strictObject({
  ...codingRunGuardSchema.entries,
  action: v.variant('type', [
    v.strictObject({
      type: v.literal('bind-host'),
      host: codingHostIdentitySchema,
    }),
    v.strictObject({
      type: v.literal('bind-workspace'),
      workspace: codingWorkspaceSchema,
    }),
    v.strictObject({
      type: v.literal('bind-session'),
      providerSessionId: codingLabelSchema,
    }),
    v.strictObject({ type: v.literal('running') }),
    v.strictObject({ type: v.literal('collecting') }),
    v.strictObject({
      type: v.literal('quarantine'),
      reason: codingLabelSchema,
    }),
    v.strictObject({ type: v.literal('cancel'), reason: codingLabelSchema }),
    v.strictObject({
      type: v.literal('finish'),
      status: v.picklist(['candidate', 'failed', 'cancelled']),
      proof: codingDeadProofSchema,
      candidate: v.optional(codingCandidateEvidenceSchema),
      reason: codingLabelSchema,
    }),
  ]),
});
export const codingRunPageSchema = v.strictObject({
  after: v.optional(natural, 0),
  limit: v.optional(v.pipe(version, v.maxValue(100)), 25),
});
export const codingRunListSchema = v.strictObject({
  ...codingRunPageSchema.entries,
  workItemId: v.optional(codingLabelSchema),
});
export const codingRunEventSchema = v.strictObject({
  sequence: version,
  runId: codingLabelSchema,
  version,
  type: codingLabelSchema,
  status: codingRunStatusSchema,
  createdAt: codingTimeSchema,
});
export type CodingRunSnapshot = v.InferOutput<typeof codingRunSnapshotSchema>;
export type CodingRunRecord = v.InferOutput<typeof codingRunRecordSchema>;
export type CodingRunCommand = v.InferOutput<typeof codingRunCommandSchema>;
