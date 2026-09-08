/* eslint-disable no-control-regex -- Reject control bytes in executable inputs. */
import * as v from 'valibot';
import { validRange } from 'semver';

const text = (max: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const id = v.pipe(text(64), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/));
export const repoWorkflowCwdSchema = v.pipe(
  text(512),
  v.check(
    (value) =>
      value === '.' ||
      (!value.startsWith('/') &&
        !/[\\:\x00-\x1f]/.test(value) &&
        value
          .split('/')
          .every((part) => !!part && part !== '.' && part !== '..')),
    'Use a normalized relative repository directory.',
  ),
);
export const repoWorkflowCommandSchema = v.strictObject({
  command: v.pipe(
    text(2000),
    v.check((value) => !/(?:[\x00\r\n;&|<>`]|\$\()/.test(value)),
  ),
  cwd: repoWorkflowCwdSchema,
});
const version = v.pipe(
  text(120),
  v.check(
    (value) => validRange(value) !== null,
    'Use a valid semantic version requirement.',
  ),
);
export const repoWorkflowEnvironmentRefSchema = v.pipe(
  text(128),
  v.regex(/^[A-Z_][A-Z0-9_]*$/),
  v.check(
    (value) =>
      !/^(?:HOME|PATH|SHELL|USER|LOGNAME|TMPDIR|TMP|TEMP|ENV|BASH_ENV|CDPATH|NODE_OPTIONS|NODE_PATH|XDG_.*|NPM_CONFIG_.*|npm_config_.*|GIT_.*|NEONDECK_.*|LD_.*|DYLD_.*|PYTHON.*|RUBY.*|PERL.*|BUN_.*|COREPACK_.*|YARN_.*|PNPM_.*)$/.test(
        value,
      ),
    'Environment reference cannot override runtime or process controls.',
  ),
);
const timeout = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1000),
  v.maxValue(3_600_000),
);
export const repoWorkflowProfileSchema = v.strictObject({
  id,
  name: text(120),
  setupCommands: v.pipe(v.array(repoWorkflowCommandSchema), v.maxLength(16)),
  validationCommands: v.pipe(
    v.array(repoWorkflowCommandSchema),
    v.maxLength(16),
  ),
  setupTimeoutMs: timeout,
  validationTimeoutMs: timeout,
  runtime: v.strictObject({
    node: v.optional(version),
    packageManager: v.optional(
      v.strictObject({
        name: v.picklist(['npm', 'pnpm', 'yarn', 'bun']),
        version: v.optional(version),
      }),
    ),
  }),
  environmentRefs: v.pipe(
    v.array(repoWorkflowEnvironmentRefSchema),
    v.maxLength(32),
    v.check((values) => new Set(values).size === values.length),
  ),
});
export const repoFactoryWorkflowsSchema = v.pipe(
  v.strictObject({
    defaultProfileId: v.nullable(id),
    profiles: v.pipe(
      v.array(repoWorkflowProfileSchema),
      v.minLength(1),
      v.maxLength(8),
    ),
  }),
  v.check(
    (value) =>
      new Set(value.profiles.map((profile) => profile.id)).size ===
      value.profiles.length,
    'Profile IDs must be unique.',
  ),
  v.check(
    (value) =>
      value.defaultProfileId === null ||
      value.profiles.some((profile) => profile.id === value.defaultProfileId),
    'Default must identify a saved profile.',
  ),
);
const fingerprint = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const saveRepoWorkflowsInputSchema = v.strictObject({
  expectedFingerprint: fingerprint,
  workflows: v.nullable(repoFactoryWorkflowsSchema),
});
export const proposeRepoWorkflowsInputSchema = v.strictObject({
  expectedFingerprint: fingerprint,
});
export const repoWorkflowProposalDraftSchema = v.strictObject({
  workflows: repoFactoryWorkflowsSchema,
  rationale: text(4000),
  evidencePaths: v.pipe(v.array(repoWorkflowCwdSchema), v.maxLength(24)),
});
export const repoWorkflowProposalSchema = v.strictObject({
  ...repoWorkflowProposalDraftSchema.entries,
  evidenceRevision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40,64}$/)),
});
export type RepoWorkflowCommand = v.InferOutput<
  typeof repoWorkflowCommandSchema
>;
export type RepoWorkflowProfile = v.InferOutput<
  typeof repoWorkflowProfileSchema
>;
export type RepoFactoryWorkflows = v.InferOutput<
  typeof repoFactoryWorkflowsSchema
>;
export type RepoWorkflowProposal = v.InferOutput<
  typeof repoWorkflowProposalSchema
>;
export type SaveRepoWorkflowsInput = v.InferOutput<
  typeof saveRepoWorkflowsInputSchema
>;
export type ProposeRepoWorkflowsInput = v.InferOutput<
  typeof proposeRepoWorkflowsInputSchema
>;
export const repoWorkflowsSnapshotSchema = v.strictObject({
  repoId: text(256),
  fingerprint,
  workflows: v.nullable(repoFactoryWorkflowsSchema),
});
export const repoWorkflowsProposalResultSchema = v.strictObject({
  ...repoWorkflowsSnapshotSchema.entries,
  proposal: repoWorkflowProposalSchema,
});
export type RepoWorkflowsSnapshot = v.InferOutput<
  typeof repoWorkflowsSnapshotSchema
>;
export type RepoWorkflowsProposalResult = v.InferOutput<
  typeof repoWorkflowsProposalResultSchema
>;
