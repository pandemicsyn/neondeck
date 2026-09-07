import * as v from 'valibot';
const id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240));
const env = v.pipe(id, v.regex(/^[A-Z][A-Z0-9_]*$/));
const timestamp = v.pipe(
  id,
  v.check((s) => Number.isFinite(Date.parse(s))),
);
export const linearConnectionSchema = v.strictObject({
  id: v.pipe(id, v.regex(/^[A-Za-z0-9_-]+$/)),
  enabled: v.boolean(),
  organizationId: id,
  teamId: id,
  projectId: v.nullable(id),
  repoId: id,
  tokenEnv: env,
  webhookSecretEnv: env,
  admission: v.strictObject({
    mode: v.picklist(['all', 'label', 'state']),
    value: v.optional(id),
  }),
  writeback: v.strictObject({
    enabled: v.boolean(),
    states: v.strictObject({
      inbox: v.optional(id),
      shaping: v.optional(id),
      queued: v.optional(id),
      paused: v.optional(id),
      closed: v.optional(id),
    }),
  }),
});
export type LinearConnection = v.InferOutput<typeof linearConnectionSchema>;
export const linearIssueSchema = v.object({
  id,
  identifier: id,
  url: v.pipe(
    id,
    v.url(),
    v.check((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'linear.app' &&
        !url.username &&
        !url.password
      );
    }),
  ),
  title: id,
  description: v.nullable(v.pipe(v.string(), v.maxLength(65536))),
  updatedAt: timestamp,
  archivedAt: v.nullable(timestamp),
  team: v.object({ id }),
  project: v.nullable(v.object({ id })),
  state: v.object({ id, type: id }),
  labels: v.array(v.object({ id })),
});
export type LinearIssue = v.InferOutput<typeof linearIssueSchema>;
export const factoryLinearStateSchema = v.object({
  configFingerprint: v.string(),
  connections: v.array(
    v.object({
      ...linearConnectionSchema.entries,
      readiness: v.array(v.string()),
    }),
  ),
  sync: v.array(
    v.object({
      id,
      cursor: v.nullable(v.string()),
      error: v.nullable(v.string()),
      retryAt: v.number(),
    }),
  ),
  deliveries: v.array(
    v.object({
      id,
      connectionId: id,
      issueId: id,
      state: v.string(),
      error: v.nullable(v.string()),
      retryAt: v.number(),
    }),
  ),
  writebacks: v.array(
    v.object({
      id,
      workId: id,
      stateId: id,
      state: v.string(),
      error: v.nullable(v.string()),
    }),
  ),
});
export type FactoryLinearState = v.InferOutput<typeof factoryLinearStateSchema>;
