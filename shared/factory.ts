import * as v from 'valibot';

const text = (max = 20000) => v.pipe(v.string(), v.maxLength(max));
const label = v.pipe(text(240), v.trim(), v.minLength(1));
const version = v.pipe(v.number(), v.integer(), v.minValue(1));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const factoryConfigSchema = v.strictObject({
  enabled: v.optional(v.boolean(), false),
  codingPolicy: v.optional(v.literal('isolated-local-v1'), 'isolated-local-v1'),
});
export const factoryPolicy = {
  version: 'isolated-local-v1',
  implementation: 'isolated-worktree',
  checks: 'repo-configured',
  publish: false,
  merge: false,
  deploy: false,
} as const;
export const specSchema = v.pipe(
  v.strictObject({
    outcome: text(),
    scope: text(),
    nonGoals: text(),
    approach: text(),
    acceptanceCriteria: v.pipe(
      v.array(v.strictObject({ id: label, text: label })),
      v.maxLength(100),
    ),
    constraints: text(),
    assumptions: text(),
    decisions: v.pipe(
      v.array(
        v.strictObject({
          id: label,
          question: label,
          blocking: v.boolean(),
          answer: v.nullable(text()),
        }),
      ),
      v.maxLength(100),
    ),
    references: v.pipe(
      v.array(v.strictObject({ path: label, commit: label, note: text(2000) })),
      v.maxLength(100),
    ),
  }),
  v.check(
    (s) =>
      new Set(s.acceptanceCriteria.map((c) => c.id)).size ===
        s.acceptanceCriteria.length &&
      new Set(s.decisions.map((d) => d.id)).size === s.decisions.length,
    'Criterion and decision IDs must be unique.',
  ),
);
export type FactorySpec = v.InferOutput<typeof specSchema>;
export const emptyFactorySpec = (): FactorySpec => ({
  outcome: '',
  scope: '',
  nonGoals: '',
  approach: '',
  acceptanceCriteria: [],
  constraints: '',
  assumptions: '',
  decisions: [],
  references: [],
});
export const manualIntakeSchema = v.strictObject({
  requestKey: label,
  title: label,
  body: text(),
  repoId: v.nullable(label),
});
export const sourceSchema = v.strictObject({
  id: label,
  provider: v.literal('manual'),
  requestKey: label,
  requestHash: hash,
  title: label,
  body: text(),
  repoId: v.nullable(label),
  version,
  status: v.picklist(['open', 'closed']),
  actor: label,
  createdAt: label,
});
export const repoContextSchema = v.strictObject({
  path: v.string(),
  defaultBranch: v.string(),
  commands: v.record(v.string(), v.string()),
});
export const revisionSchema = v.strictObject({
  workId: label,
  version,
  parentVersion: v.nullable(version),
  spec: specSchema,
  hash,
  sourceVersion: version,
  repoFingerprint: v.nullable(hash),
  repoContext: v.nullable(repoContextSchema),
  authorKind: v.literal('human'),
  actor: label,
  createdAt: label,
});
export const workSchema = v.strictObject({
  id: label,
  sourceId: label,
  title: label,
  repoId: v.nullable(label),
  lifecycle: v.picklist(['inbox', 'shaping', 'queued', 'paused', 'closed']),
  version,
  specVersion: version,
  createdAt: label,
  updatedAt: label,
});
export const releaseSchema = v.strictObject({
  id: label,
  workId: label,
  requestKey: label,
  actor: label,
  specVersion: version,
  specHash: hash,
  sourceVersion: version,
  repoId: label,
  repoFingerprint: hash,
  policy: v.strictObject({
    version: v.literal('isolated-local-v1'),
    implementation: v.literal('isolated-worktree'),
    checks: v.literal('repo-configured'),
    publish: v.literal(false),
    merge: v.literal(false),
    deploy: v.literal(false),
  }),
  createdAt: label,
  withdrawnAt: v.nullable(label),
  withdrawalReason: v.nullable(label),
});
export const saveSpecSchema = v.strictObject({
  expectedVersion: version,
  expectedSpecVersion: version,
  expectedRepoFingerprint: v.nullable(hash),
  spec: specSchema,
});
export const releaseInputSchema = v.strictObject({
  requestKey: label,
  expectedVersion: version,
  specVersion: version,
  specHash: hash,
  sourceVersion: version,
  repoFingerprint: hash,
  policyVersion: v.literal('isolated-local-v1'),
});
export const transitionSchema = v.strictObject({
  expectedVersion: version,
  action: v.picklist(['pause', 'withdraw', 'reopen', 'close']),
});
export const updateSourceSchema = v.strictObject({
  expectedVersion: version,
  title: label,
  body: text(),
  repoId: v.nullable(label),
});
export const factoryDetailSchema = v.strictObject({
  work: workSchema,
  source: sourceSchema,
  revisions: v.array(revisionSchema),
  releases: v.array(releaseSchema),
  blockers: v.array(v.string()),
  eligible: v.boolean(),
  repoFingerprint: v.nullable(hash),
  repoContext: v.nullable(repoContextSchema),
});
export const factoryStateSchema = v.strictObject({
  enabled: v.boolean(),
  policy: v.literal('isolated-local-v1'),
  repos: v.array(v.strictObject({ id: label, name: label })),
  items: v.array(workSchema),
});
export type FactoryDetail = v.InferOutput<typeof factoryDetailSchema>;
export type FactoryWork = v.InferOutput<typeof workSchema>;
export type FactorySource = v.InferOutput<typeof sourceSchema>;
export type FactoryRevision = v.InferOutput<typeof revisionSchema>;
export type FactoryRelease = v.InferOutput<typeof releaseSchema>;
export type FactoryState = v.InferOutput<typeof factoryStateSchema>;
export function renderFactorySpec(spec: FactorySpec) {
  return [
    `# Outcome\n${spec.outcome}`,
    `## Scope\n${spec.scope}`,
    `## Non-goals\n${spec.nonGoals}`,
    `## Approach\n${spec.approach}`,
    `## Acceptance criteria\n${spec.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`).join('\n')}`,
    `## Constraints\n${spec.constraints}`,
    `## Assumptions\n${spec.assumptions}`,
    `## Decisions\n${spec.decisions.map((d) => `- [${d.id}] ${d.question} (${d.blocking ? 'blocking' : 'optional'})\n  ${d.answer ?? 'Unresolved'}`).join('\n')}`,
    `## References\n${spec.references.map((r) => `- ${r.path} @ ${r.commit}: ${r.note}`).join('\n')}`,
  ].join('\n\n');
}

export type FactoryChangeEvent = { changedAt: string };
