import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { openDb } from '../../../lib/sqlite';
import {
  readRepoCheckoutStatus,
  readRepoDiff,
  readRepoFile,
  searchRepoFiles,
} from '../../../repo-edit';
import {
  gitRefSchema,
  maxPatchBytes,
  maxReadLimit,
  maxSearchResults,
  repoEditOutputSchema,
  repoRelativePathSchema,
} from '../../../repo-edit/schemas';
import { runtimePaths, type RuntimePaths } from '../../../runtime-home';
import { stableJsonHash } from './grounding';

const nonEmpty = v.pipe(v.string(), v.minLength(1));
const scopeSchema = {
  attemptId: nonEmpty,
  token: nonEmpty,
};

export const autopilotOwnerFileReadInputSchema = v.strictObject({
  ...scopeSchema,
  path: repoRelativePathSchema,
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxReadLimit)),
  ),
  includeLineNumbers: v.optional(v.boolean()),
});

export const autopilotOwnerFileSearchInputSchema = v.strictObject({
  ...scopeSchema,
  query: nonEmpty,
  globs: v.optional(v.array(repoRelativePathSchema)),
  maxResults: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(maxSearchResults),
    ),
  ),
  contextLines: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
  ),
});

export const autopilotOwnerDiffInputSchema = v.pipe(
  v.strictObject({
    ...scopeSchema,
    base: v.optional(gitRefSchema),
    paths: v.optional(v.array(repoRelativePathSchema)),
    includePatch: v.optional(v.boolean()),
    expectedRevisionKey: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(768)),
    ),
    maxPatchBytes: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxPatchBytes)),
    ),
  }),
  v.check(
    (input) =>
      !input.paths?.length ||
      input.includePatch !== true ||
      Boolean(input.expectedRevisionKey),
    'expectedRevisionKey is required for a scoped patch read.',
  ),
);

export const autopilotOwnerStatusInputSchema = v.strictObject(scopeSchema);

export const autopilotOwnerFileReadAction = defineAction({
  name: 'neondeck_autopilot_file_read',
  description:
    'Read a file only from the worktree bound to the current accepted owner turn.',
  input: autopilotOwnerFileReadInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return runScopedRead(input, readRepoFile);
  },
});

export const autopilotOwnerFileSearchAction = defineAction({
  name: 'neondeck_autopilot_file_search',
  description:
    'Search only the worktree bound to the current accepted owner turn.',
  input: autopilotOwnerFileSearchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return runScopedRead(input, searchRepoFiles);
  },
});

export const autopilotOwnerDiffAction = defineAction({
  name: 'neondeck_autopilot_diff',
  description:
    'Read a diff only from the worktree bound to the current accepted owner turn.',
  input: autopilotOwnerDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return runScopedRead(input, readRepoDiff);
  },
});

export const autopilotOwnerStatusAction = defineAction({
  name: 'neondeck_autopilot_checkout_status',
  description:
    'Read checkout status only for the worktree bound to the current accepted owner turn.',
  input: autopilotOwnerStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return runScopedRead(input, readRepoCheckoutStatus);
  },
});

export async function runScopedOwnerRead(
  rawInput: unknown,
  kind: 'file' | 'search' | 'diff' | 'status',
  paths: RuntimePaths = runtimePaths(),
) {
  const schema = {
    file: autopilotOwnerFileReadInputSchema,
    search: autopilotOwnerFileSearchInputSchema,
    diff: autopilotOwnerDiffInputSchema,
    status: autopilotOwnerStatusInputSchema,
  }[kind];
  const parsed = v.safeParse(schema, rawInput);
  if (!parsed.success) return scopedFailure(v.summarize(parsed.issues));
  const target = readAcceptedScope(parsed.output, paths);
  if (!target)
    return scopedFailure('Owner read scope is stale or no longer active.');
  const { attemptId: _attemptId, token: _token, ...request } = parsed.output;
  const bound = {
    ...request,
    repoId: target.repoId,
    worktreeId: target.worktreeId,
  };
  if (kind === 'file') return readRepoFile(bound, paths);
  if (kind === 'search') return searchRepoFiles(bound, paths);
  if (kind === 'diff') return readRepoDiff(bound, paths);
  return readRepoCheckoutStatus(bound, paths);
}

async function runScopedRead(
  input: { attemptId: string; token: string },
  reader: (rawInput: unknown, paths?: RuntimePaths) => Promise<unknown>,
): Promise<v.InferOutput<typeof repoEditOutputSchema>> {
  const paths = runtimePaths();
  const target = readAcceptedScope(input, paths);
  if (!target)
    return scopedFailure('Owner read scope is stale or no longer active.');
  const {
    attemptId: _attemptId,
    token: _token,
    ...request
  } = input as Record<string, unknown>;
  return (await reader(
    { ...request, repoId: target.repoId, worktreeId: target.worktreeId },
    paths,
  )) as v.InferOutput<typeof repoEditOutputSchema>;
}

function readAcceptedScope(
  input: { attemptId: string; token: string },
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT owners.repo_id, owners.worktree_id
         FROM autopilot_owner_grounding_snapshots AS grounding
         INNER JOIN autopilot_stage_attempts AS attempts
           ON attempts.id = grounding.attempt_id
         INNER JOIN autopilot_admissions AS admissions
           ON admissions.id = attempts.admission_id
         INNER JOIN autopilot_pr_owners AS owners
           ON owners.id = attempts.owner_id
         WHERE grounding.attempt_id = ? AND grounding.status = 'accepted'
           AND grounding.submit_token_hash = ?
           AND attempts.stage = 'owner-turn' AND attempts.status = 'running'
           AND attempts.dispatch_id = grounding.dispatch_id
           AND admissions.state = 'owner-turn-running'
           AND admissions.current_stage_attempt_id = attempts.id
           AND owners.generation = attempts.owner_generation
           AND owners.flue_instance_id = attempts.flue_instance_id
           AND owners.worktree_id IS NOT NULL;`,
      )
      .get(input.attemptId, stableJsonHash(input.token)) as
      { repo_id?: unknown; worktree_id?: unknown } | undefined;
    return typeof row?.repo_id === 'string' &&
      typeof row.worktree_id === 'string'
      ? { repoId: row.repo_id, worktreeId: row.worktree_id }
      : null;
  } finally {
    database.close();
  }
}

function scopedFailure(message: string) {
  return {
    ok: false,
    action: 'autopilot_owner_read',
    changed: false,
    message,
    errors: [message],
  } as const;
}
