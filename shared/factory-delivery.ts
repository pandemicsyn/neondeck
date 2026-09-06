import * as v from 'valibot';

const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
export const deliveryMaxCheckCommands = 16;
export const deliveryCheckCommandsSchema = v.pipe(
  v.array(label),
  v.minLength(1),
  v.maxLength(deliveryMaxCheckCommands),
);
const repairInstructions = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(20000),
);
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const version = v.pipe(natural, v.minValue(1));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/));
const time = v.pipe(v.string(), v.isoTimestamp());
export const deliveryRevisionSchema = v.strictObject({
  runId: label,
  attemptId: label,
  releaseId: label,
  specVersion: version,
  specHash: hash,
  candidateDigest: hash,
  baseSha: sha,
  headSha: sha,
  treeSha: sha,
});
export const deliveryEvidenceSchema = v.pipe(
  v.strictObject({
    id: label,
    kind: v.picklist(['verification', 'review']),
    revision: deliveryRevisionSchema,
    producerId: label,
    result: v.picklist(['passed', 'failed', 'blocked']),
    evidenceRef: label,
    effectId: label,
    validationContractDigest: hash,
    bundleDigest: hash,
    verificationEvidenceId: v.nullable(label),
    verificationBundleDigest: v.nullable(hash),
  }),
  v.check((e) =>
    e.kind === 'verification'
      ? e.verificationEvidenceId === null && e.verificationBundleDigest === null
      : e.verificationEvidenceId !== null &&
        e.verificationBundleDigest !== null,
  ),
);
export const deliveryEffectSchema = v.strictObject({
  id: label,
  kind: v.picklist([
    'commit',
    'verification',
    'review',
    'feedback-review',
    'push',
    'create-pr',
    'update-pr',
  ]),
  revision: deliveryRevisionSchema,
  state: v.picklist(['planned', 'in-flight', 'uncertain', 'delivered']),
  receiptRef: v.nullable(label),
  reservedExecutionMs: v.nullable(version),
  executionMs: v.nullable(natural),
});
export const deliveryRepairSchema = v.strictObject({
  runId: label,
  attemptId: label,
  requestId: label,
  reservedExecutionMs: version,
  executionMs: v.nullable(natural),
  fromRevision: deliveryRevisionSchema,
  status: v.picklist(['reserved', 'candidate', 'failed']),
  revision: v.nullable(deliveryRevisionSchema),
  reason: repairInstructions,
});
export const deliveryInterventionSchema = v.strictObject({
  id: label,
  kind: v.picklist(['scope', 'budget', 'authority', 'uncertainty']),
  reason: label,
  revision: deliveryRevisionSchema,
  resolution: v.nullable(label),
});
export const deliveryPrSchema = v.strictObject({
  number: version,
  url: v.pipe(v.string(), v.url()),
});
export const deliveryOutcomeSchema = v.picklist([
  'merged',
  'closed',
  'cancelled',
  'failed',
]);
export const deliveryAuthorizationSchema = v.pipe(
  v.strictObject({
    id: label,
    authorizedBy: label,
    authorizedAt: time,
    revision: deliveryRevisionSchema,
    repoId: label,
    target: v.strictObject({ owner: label, name: label, baseBranch: label }),
    configFingerprint: hash,
    checkCommands: deliveryCheckCommandsSchema,
    maxRepairAttempts: v.pipe(natural, v.maxValue(2)),
    totalExecutionMs: v.pipe(version, v.maxValue(10800000)),
    initialExecutionMs: natural,
  }),
  v.check((r) => r.initialExecutionMs <= r.totalExecutionMs),
);
export const deliveryReservationSchema = v.strictObject({
  workItemId: label,
  repoId: label,
  initialRevision: deliveryRevisionSchema,
  authorization: deliveryAuthorizationSchema,
});
export const deliveryCoordinatorSchema = v.strictObject({
  candidateRef: v.nullable(label),
  watchId: v.nullable(label),
  observationFingerprint: v.nullable(label),
  watchObservedAt: v.optional(v.nullable(time), null),
  terminalObservedAt: v.nullable(time),
});
export const deliveryCommitSchema = v.strictObject({
  revision: deliveryRevisionSchema,
  publishedHeadSha: sha,
  treeSha: sha,
  evidenceRef: label,
});
export const deliveryFeedbackObservationSchema = v.strictObject({
  id: label,
  fingerprint: hash,
  revision: deliveryRevisionSchema,
  publishedHeadSha: sha,
  ciFailed: v.boolean(),
  hasReviewFeedback: v.boolean(),
  evidenceRef: label,
});
export const deliveryFeedbackClassificationSchema = v.strictObject({
  effectId: label,
  result: v.picklist(['scoped-repair', 'scope-change', 'no-action']),
  evidenceRef: label,
});
export const deliveryFeedbackSchema = v.strictObject({
  ...deliveryFeedbackObservationSchema.entries,
  classification: v.nullable(deliveryFeedbackClassificationSchema),
  repairRequestId: v.nullable(label),
});
export const deliveryPipelineSchema = v.strictObject({
  pipelineId: label,
  version,
  workItemId: label,
  repoId: label,
  initialRevision: deliveryRevisionSchema,
  revision: deliveryRevisionSchema,
  branch: label,
  prIdentity: label,
  pr: v.nullable(deliveryPrSchema),
  authorization: deliveryAuthorizationSchema,
  repairs: v.array(deliveryRepairSchema),
  evidence: v.array(deliveryEvidenceSchema),
  effects: v.array(deliveryEffectSchema),
  feedback: v.optional(v.array(deliveryFeedbackSchema), []),
  interventions: v.array(deliveryInterventionSchema),
  commits: v.array(deliveryCommitSchema),
  coordinator: deliveryCoordinatorSchema,
  outcome: v.nullable(deliveryOutcomeSchema),
  outcomeRef: v.nullable(label),
  createdAt: time,
  updatedAt: time,
});
export const deliveryCommandSchema = v.strictObject({
  pipelineId: label,
  expectedVersion: version,
  action: v.variant('type', [
    v.strictObject({
      type: v.literal('bind-effect-receipt'),
      id: label,
      receiptRef: label,
    }),
    v.strictObject({
      type: v.literal('record-feedback'),
      feedback: deliveryFeedbackObservationSchema,
    }),
    v.strictObject({
      type: v.literal('classify-feedback'),
      id: label,
      ...deliveryFeedbackClassificationSchema.entries,
    }),
    v.strictObject({
      type: v.literal('bind-commit'),
      publishedHeadSha: sha,
      treeSha: sha,
      evidenceRef: label,
    }),
    v.strictObject({
      type: v.literal('set-coordinator'),
      coordinator: deliveryCoordinatorSchema,
    }),
    v.strictObject({
      type: v.literal('record-evidence'),
      evidence: deliveryEvidenceSchema,
    }),
    v.strictObject({
      type: v.literal('finish-repair'),
      runId: label,
      attemptId: label,
      revision: v.nullable(deliveryRevisionSchema),
      executionMs: v.nullable(natural),
    }),
    v.strictObject({
      type: v.literal('plan-effect'),
      id: label,
      kind: deliveryEffectSchema.entries.kind,
      maxExecutionMs: v.optional(v.pipe(version, v.maxValue(2700000))),
    }),
    v.strictObject({ type: v.literal('start-effect'), id: label }),
    v.strictObject({
      type: v.literal('settle-effect'),
      id: label,
      state: v.picklist(['uncertain', 'delivered']),
      receiptRef: label,
      executionMs: v.optional(v.nullable(natural)),
      pr: v.optional(deliveryPrSchema),
    }),
    // Only the trusted external observer may attest absence; elapsed time is never proof.
    v.strictObject({
      type: v.literal('reconcile-effect'),
      id: label,
      observation: v.picklist(['not-delivered', 'delivered']),
      receiptRef: label,
      executionMs: v.optional(v.nullable(natural)),
      pr: v.optional(deliveryPrSchema),
    }),
    v.strictObject({
      type: v.literal('intervene'),
      id: label,
      kind: deliveryInterventionSchema.entries.kind,
      reason: label,
    }),
    // Caller establishes human decision authority before resolving scope/budget changes.
    v.strictObject({
      type: v.literal('resolve-intervention'),
      id: label,
      resolution: label,
    }),
    v.strictObject({
      type: v.literal('finish'),
      outcome: deliveryOutcomeSchema,
      evidenceRef: label,
    }),
  ]),
});
export const deliveryListSchema = v.strictObject({
  after: v.optional(natural, 0),
  limit: v.optional(v.pipe(version, v.maxValue(100)), 25),
  workItemId: v.optional(label),
});
export const deliveryOwnershipSchema = v.pipe(
  v.strictObject({
    repoId: label,
    branch: v.optional(label),
    prNumber: v.optional(version),
  }),
  v.check((r) => r.branch !== undefined || r.prNumber !== undefined),
);
export type DeliveryRevision = v.InferOutput<typeof deliveryRevisionSchema>;
export type DeliveryPipeline = v.InferOutput<typeof deliveryPipelineSchema>;
export type DeliveryCommand = v.InferOutput<typeof deliveryCommandSchema>;
export type DeliveryEvidence = v.InferOutput<typeof deliveryEvidenceSchema>;
export type DeliveryEffect = v.InferOutput<typeof deliveryEffectSchema>;
export type DeliveryRepair = v.InferOutput<typeof deliveryRepairSchema>;
export type DeliveryReservation = v.InferOutput<
  typeof deliveryReservationSchema
>;

export const deliveryRepairReservationSchema = v.strictObject({
  pipelineId: label,
  expectedVersion: version,
  requestId: label,
  reason: repairInstructions,
  maxWallTimeMs: v.pipe(version, v.maxValue(2700000)),
});
export type DeliveryAuthorization = v.InferOutput<
  typeof deliveryAuthorizationSchema
>;

export type DeliveryFeedback = v.InferOutput<typeof deliveryFeedbackSchema>;
