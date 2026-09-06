import * as v from 'valibot';
const label = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240));
const timestamp = v.pipe(
  label,
  v.check(
    (text) =>
      /^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text)),
    'Expected an ISO timestamp.',
  ),
);
const identifier = v.pipe(label, v.regex(/^[A-Za-z0-9_-]+$/));
const envRef = v.pipe(label, v.regex(/^[A-Z][A-Z0-9_]*$/));
export const githubConnectionSchema = v.strictObject({
  id: identifier,
  enabled: v.boolean(),
  repoId: label,
  repositoryId: v.pipe(label, v.regex(/^[1-9][0-9]*$/)),
  owner: v.pipe(label, v.regex(/^[A-Za-z0-9-]+$/)),
  name: v.pipe(label, v.regex(/^[A-Za-z0-9_.-]+$/)),
  webhookSecretEnv: envRef,
  tokenEnv: envRef,
  admission: v.strictObject({
    mode: v.picklist(['label', 'all']),
    label: v.optional(label),
  }),
});
export type GitHubConnection = v.InferOutput<typeof githubConnectionSchema>;
export const githubCommentSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: v.pipe(v.string(), v.maxLength(65536)),
  user: v.nullable(v.object({ login: label, id: v.optional(v.number()) })),
  created_at: timestamp,
  updated_at: timestamp,
});
export type GitHubComment = v.InferOutput<typeof githubCommentSchema>;
export const githubIssueSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  body: v.nullable(v.pipe(v.string(), v.maxLength(65536))),
  state: v.picklist(['open', 'closed']),
  updated_at: timestamp,
  user: v.nullable(v.object({ login: label, id: v.optional(v.number()) })),
  labels: v.array(v.union([v.string(), v.object({ name: v.string() })])),
  pull_request: v.optional(v.unknown()),
});
export type GitHubIssue = v.InferOutput<typeof githubIssueSchema>;
// Discovery needs identity and admission only. Validate full content per issue.
export const githubIssueDiscoverySchema = v.pick(githubIssueSchema, [
  'id',
  'number',
  'labels',
  'pull_request',
]);
export type GitHubIssueDiscovery = v.InferOutput<
  typeof githubIssueDiscoverySchema
>;
export const factoryGitHubStateSchema = v.object({
  configFingerprint: v.string(),
  connections: v.array(
    v.object({
      ...githubConnectionSchema.entries,
      readiness: v.array(v.string()),
    }),
  ),
  deliveries: v.array(
    v.object({
      id: v.string(),
      connectionId: v.string(),
      issueNumber: v.number(),
      state: v.string(),
      error: v.nullable(v.string()),
      retryAt: v.number(),
    }),
  ),
  sync: v.array(
    v.object({
      id: v.string(),
      error: v.nullable(v.string()),
      retryAt: v.number(),
      page: v.number(),
    }),
  ),
});
export const factoryGitHubCommentsSchema = v.object({
  nextCursor: v.nullable(v.string()),
  comments: v.array(
    v.object({
      id: v.string(),
      workId: v.string(),
      remoteId: v.string(),
      body: v.string(),
      author: v.string(),
      remoteUpdatedAt: v.string(),
      version: v.number(),
      deleted: v.boolean(),
      intentId: v.nullable(v.string()),
      echo: v.optional(
        v.picklist(['external', 'awaiting-receipt', 'confirmed']),
        'external',
      ),
    }),
  ),
});
export type FactoryGitHubState = v.InferOutput<typeof factoryGitHubStateSchema>;
