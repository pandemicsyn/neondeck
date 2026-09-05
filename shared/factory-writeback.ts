import * as v from 'valibot';
const str = v.string();
const text = v.pipe(str, v.minLength(1), v.maxLength(8000));
export const writebackApprovalSchema = v.strictObject({
  requestKey: v.pipe(str, v.minLength(1), v.maxLength(240)),
  expectedVersion: v.number(),
  specVersion: v.number(),
  specHash: str,
  sourceVersion: v.number(),
  issueId: str,
  kind: v.picklist(['summary', 'question']),
  body: text,
  decisionId: v.nullable(str),
});
export type WritebackApprovalInput = v.InferOutput<
  typeof writebackApprovalSchema
>;
export const writebackPolicySchema = v.object({
  id: str,
  enabled: v.boolean(),
  epoch: str,
  connectionFingerprint: str,
  actor: str,
  approvedAt: str,
});
export const writebackEffectSchema = v.object({
  id: str,
  workId: str,
  connectionId: str,
  issueId: str,
  number: v.number(),
  connectionFingerprint: str,
  epoch: str,
  kind: v.picklist(['status', 'question']),
  body: str,
  bodyHash: str,
  marker: str,
  specVersion: v.number(),
  sourceVersion: v.number(),
  workVersion: v.number(),
  approvalId: v.nullable(str),
  repoFingerprint: v.optional(v.nullable(str), null),
  state: v.picklist([
    'pending',
    'sending',
    'sent',
    'failed',
    'uncertain',
    'repair',
    'cancelled',
  ]),
  remoteId: v.nullable(str),
  author: v.nullable(str),
  authorId: v.optional(v.nullable(v.number()), null),
  confirmedBody: v.nullable(str),
  confirmedUpdatedAt: v.nullable(str),
  error: v.nullable(str),
  scanPage: v.optional(v.number(), 1),
  scanMatches: v.optional(v.pipe(v.array(str), v.maxLength(2)), []),
  attempts: v.number(),
  retryAt: v.number(),
  createdAt: str,
});
export type WritebackEffect = v.InferOutput<typeof writebackEffectSchema>;
export const publicApprovalSchema = v.object({
  ...writebackApprovalSchema.entries,
  id: str,
  workId: str,
  actor: str,
  approvedAt: str,
  repoFingerprint: v.optional(v.nullable(str), null),
  bodyHash: str,
  epoch: str,
});
export const writebackStatusSchema = v.object({
  id: str,
  workId: str,
  marker: str,
  remoteId: v.nullable(str),
  author: v.nullable(str),
  authorId: v.optional(v.nullable(v.number()), null),
  confirmedBody: v.nullable(str),
  confirmedUpdatedAt: v.nullable(str),
  relinquished: v.boolean(),
  repairRequired: v.optional(v.boolean(), false),
});
export const writebackStateSchema = v.object({
  policy: writebackPolicySchema,
  connectionFingerprint: str,
  target: str,
  template: str,
  effects: v.array(writebackEffectSchema),
  approvals: v.array(publicApprovalSchema),
  status: v.nullable(writebackStatusSchema),
});
export type WritebackState = v.InferOutput<typeof writebackStateSchema>;
export const statusLabels = {
  inbox: 'In intake — awaiting human shaping',
  shaping: 'Shaping — awaiting human review',
  queued: 'Released — awaiting coding executor',
  paused: 'Paused',
  closed: 'Closed in Neon',
  review: 'Review needed — release is not currently eligible',
} as const;
export function publicStatusBody(
  lifecycle: keyof typeof statusLabels,
  summary?: string,
) {
  return `### Neon factory\n\n${statusLabels[lifecycle]}${summary ? `\n\nApproved scope:\n${summary}` : ''}\n\nNo coding executor has been started.`;
}
export const writebackRepairSchema = v.object({
  id: str,
  workId: str,
  effectId: str,
  epoch: str,
  workVersion: v.number(),
  observed: v.nullable(
    v.object({ id: str, body: str, author: str, updatedAt: str }),
  ),
  replacement: str,
  expiresAt: v.number(),
  approvedBy: v.optional(v.nullable(str), null),
  approvedAt: v.optional(v.nullable(str), null),
});
export type WritebackRepair = v.InferOutput<typeof writebackRepairSchema>;
