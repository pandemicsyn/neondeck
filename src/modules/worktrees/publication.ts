import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import {
  readRuntimeJson,
  parseRepoRegistry,
  type RuntimePaths,
} from '../../runtime-home';
import {
  getDeliveryPipeline,
  sameDeliveryRevision,
} from '../factory-delivery/store';
import {
  findWorktreeByLocalPath,
  readWorktreeRow,
  upsertWorktree,
} from './store';
import { git } from './git';
import type { WorktreeRecord } from './schemas';

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const claimSchema = v.strictObject({
  pipelineId: hash,
  repoId: v.pipe(v.string(), v.minLength(1)),
  expectedVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type FactoryPublicationClaim = v.InferOutput<typeof claimSchema>;
function owner(input: FactoryPublicationClaim, paths: RuntimePaths) {
  const claim = v.parse(claimSchema, input);
  const pipeline = getDeliveryPipeline(claim.pipelineId, paths);
  if (
    !pipeline ||
    pipeline.repoId !== claim.repoId ||
    pipeline.version !== claim.expectedVersion ||
    pipeline.outcome ||
    pipeline.branch !== `agent/factory-${claim.pipelineId}`
  )
    throw new Error('Factory publication claim is stale or foreign.');
  return pipeline;
}
function assertRecord(
  record: WorktreeRecord,
  pipelineId: string,
  repoId: string,
  root: string,
  revisionDigest: string,
) {
  if (
    record.id !== `factory-publication:${pipelineId}:${revisionDigest}` ||
    record.repoId !== repoId ||
    record.localPath !== root ||
    record.headRef !==
      `agent/factory-${pipelineId}-revision-${revisionDigest}` ||
    record.owningWorkflowRunId !== `factory-delivery:${pipelineId}` ||
    record.createdBy !== 'factory-delivery' ||
    record.adopted ||
    record.directPushAllowed ||
    record.storageKind !== 'home' ||
    record.lifecycleStatus === 'deleted'
  )
    throw new Error('Publication path already has another owner.');
}
/** Read-only canonical context; also usable after authority revocation. */
export async function readFactoryPublicationWorkspace(
  input: { pipelineId: string; repoId: string },
  paths: RuntimePaths,
) {
  const identity = v.parse(
    v.strictObject({
      pipelineId: hash,
      repoId: v.pipe(v.string(), v.minLength(1)),
    }),
    input,
  );
  const pipeline = getDeliveryPipeline(identity.pipelineId, paths);
  if (!pipeline || pipeline.repoId !== identity.repoId)
    throw new Error('Unknown factory publication owner.');
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const repo = registry.repos.find((repo) => repo.id === identity.repoId);
  if (!repo) throw new Error('Publication repository is not configured.');
  const sourceRoot = await realpath(repo.path);
  const storageRoot = await realpath(paths.worktrees);
  const root = join(
    storageRoot,
    `factory-publication-${identity.pipelineId}-${pipeline.revision.candidateDigest}`,
  );
  const record = findWorktreeByLocalPath(root, paths);
  if (record)
    assertRecord(
      record,
      identity.pipelineId,
      identity.repoId,
      root,
      pipeline.revision.candidateDigest,
    );
  return {
    repo,
    sourceRoot,
    storageRoot,
    root,
    worktreeId: `factory-publication:${identity.pipelineId}:${pipeline.revision.candidateDigest}`,
    branch: `agent/factory-${identity.pipelineId}-revision-${pipeline.revision.candidateDigest}`,
    record,
  };
}
/** Worktrees owns the row, deterministic path, unique branch and claim checks.
 * All ownership reads and writes serialize in the same immediate transaction.
 */
export async function reserveFactoryPublicationWorkspace(
  input: FactoryPublicationClaim & { originalHeadSha: string },
  paths: RuntimePaths,
) {
  const request = v.parse(
    v.strictObject({ ...claimSchema.entries, originalHeadSha: sha }),
    input,
  );
  const claim = v.parse(v.object(claimSchema.entries), request);
  owner(claim, paths);
  await mkdir(paths.worktrees, { recursive: true, mode: 0o700 });
  const context = await readFactoryPublicationWorkspace(
    { pipelineId: claim.pipelineId, repoId: claim.repoId },
    paths,
  );
  const pathExists = await lstat(context.root).then(
    () => true,
    (error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    },
  );
  const branchExists =
    (
      await git(context.sourceRoot, [
        'for-each-ref',
        '--format=%(refname)',
        `refs/heads/${context.branch}`,
      ])
    ).trim().length > 0;
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const pipeline = owner(claim, paths);
      const parent =
        pipeline.commits.findLast(
          (c) => !sameDeliveryRevision(c.revision, pipeline.revision),
        )?.publishedHeadSha ?? pipeline.revision.headSha;
      if (request.originalHeadSha !== parent)
        throw new Error(
          'Publication parent does not match the reserved revision.',
        );
      const rows = database
        .prepare(
          'SELECT * FROM worktrees WHERE id=? OR local_path=? OR (repo_id=? AND head_ref=?)',
        )
        .all(context.worktreeId, context.root, claim.repoId, context.branch)
        .map(readWorktreeRow);
      if (rows.length > 1)
        throw new Error('Conflicting publication workspace reservations.');
      const existing = rows[0];
      if (existing) {
        assertRecord(
          existing,
          claim.pipelineId,
          claim.repoId,
          context.root,
          pipeline.revision.candidateDigest,
        );
        return { ...context, record: existing };
      }
      if (pathExists || branchExists)
        throw new Error(
          'Unreserved publication checkout or branch already exists.',
        );
      const now = new Date().toISOString();
      const record: WorktreeRecord = {
        id: context.worktreeId,
        repoId: claim.repoId,
        repoFullName: `${context.repo.github.owner}/${context.repo.github.name}`,
        githubOwner: context.repo.github.owner,
        githubName: context.repo.github.name,
        prNumber: pipeline.pr?.number ?? null,
        baseRef: pipeline.authorization.target.baseBranch,
        headOwner: context.repo.github.owner,
        headName: context.repo.github.name,
        headRef: context.branch,
        headSha: request.originalHeadSha,
        localPath: context.root,
        storageKind: 'home',
        owningWorkflowRunId: `factory-delivery:${claim.pipelineId}`,
        lifecycleStatus: 'creating',
        lastSyncedSha: null,
        lastPushedSha: null,
        cleanupPolicy: {
          retainFailed: true,
          retainPreparedDiff: true,
          successfulGraceHours: 24,
          staleAgeHours: 168,
        },
        directPushAllowed: false,
        adopted: false,
        createdBy: 'factory-delivery',
        createdAt: now,
        updatedAt: now,
      };
      upsertWorktree(record, paths, database);
      return { ...context, record };
    });
  } finally {
    database.close();
  }
}
export function settleFactoryPublicationWorkspace(
  input: FactoryPublicationClaim & {
    phase: 'ready' | 'committed' | 'pushed';
    headSha: string;
  },
  paths: RuntimePaths,
) {
  const request = v.parse(
    v.strictObject({
      ...claimSchema.entries,
      phase: v.picklist(['ready', 'committed', 'pushed']),
      headSha: sha,
    }),
    input,
  );
  const claim = v.parse(v.object(claimSchema.entries), request);
  const db = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(db, () => {
      const pipeline = owner(claim, paths);
      const row = db
        .prepare('SELECT * FROM worktrees WHERE id=?')
        .get(
          `factory-publication:${claim.pipelineId}:${pipeline.revision.candidateDigest}`,
        );
      if (!row) throw new Error('Publication workspace is not reserved.');
      const record = readWorktreeRow(row);
      assertRecord(
        record,
        claim.pipelineId,
        claim.repoId,
        join(
          paths.worktrees,
          `factory-publication-${claim.pipelineId}-${pipeline.revision.candidateDigest}`,
        ),
        pipeline.revision.candidateDigest,
      );
      const updated = {
        ...record,
        headSha: request.headSha,
        lifecycleStatus:
          request.phase === 'pushed'
            ? 'succeeded'
            : request.phase === 'committed'
              ? 'prepared-diff'
              : 'ready',
        lastSyncedSha:
          request.phase === 'ready' ? request.headSha : record.lastSyncedSha,
        lastPushedSha:
          request.phase === 'pushed' ? request.headSha : record.lastPushedSha,
        updatedAt: new Date().toISOString(),
      } satisfies WorktreeRecord;
      upsertWorktree(updated, paths, db);
      return updated;
    });
  } finally {
    db.close();
  }
}
