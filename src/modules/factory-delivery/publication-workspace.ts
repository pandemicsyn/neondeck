import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as v from 'valibot';
import {
  deliveryPipelineSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import {
  candidateEvidenceSchema,
  captureCandidateTree,
  type CandidateEvidence,
} from './evidence';
import { getFactoryDeliveryOwnership, sameDeliveryRevision } from './store';
import {
  readFactoryPublicationWorkspace,
  reserveFactoryPublicationWorkspace,
  settleFactoryPublicationWorkspace,
} from '../worktrees';
import { trustedPublicationHooks } from './publication-hooks';
import { assertTree, recoveredCommit } from './publication-tree';
import { readValidatedPublicationCommitReceipt } from './publication-commit-proof';
import {
  hash,
  branch,
  publicationWorkspaceSchema,
  publicationWorkspaceFrom,
  type PublicationWorkspace,
  type AssertPublicationAuthority,
} from './publication-contract';
import { git, object, exists } from './publication-git-io';
async function owned(
  pipelineInput: DeliveryPipeline,
  paths: RuntimePaths,
  assertAuthority: AssertPublicationAuthority,
) {
  await assertAuthority();
  const pipeline = v.parse(deliveryPipelineSchema, pipelineInput);
  const owner = getFactoryDeliveryOwnership(
    { repoId: pipeline.repoId, branch: pipeline.branch },
    paths,
  );
  if (
    !owner ||
    owner.pipelineId !== pipeline.pipelineId ||
    owner.outcome ||
    !sameDeliveryRevision(owner.revision, pipeline.revision)
  )
    throw new Error('Publication reservation is stale or foreign.');
  return pipeline;
}
export async function verifyWorkspace(
  workspaceInput: PublicationWorkspace,
  pipeline: DeliveryPipeline,
  paths: RuntimePaths,
  assertAuthority: AssertPublicationAuthority,
) {
  await owned(pipeline, paths, assertAuthority);
  return readPublicationWorkspaceIdentity(workspaceInput, pipeline, paths);
}
export async function readPublicationWorkspaceIdentity(
  workspaceInput: PublicationWorkspace,
  pipeline: DeliveryPipeline,
  paths: RuntimePaths,
) {
  const workspace = publicationWorkspaceFrom(workspaceInput);
  const context = await readFactoryPublicationWorkspace(
    { pipelineId: pipeline.pipelineId, repoId: pipeline.repoId },
    paths,
  );
  const { sourceRoot: source, storageRoot: storage, record } = context;
  const root = await realpath(workspace.root);
  const parent =
    pipeline.commits.findLast(
      (c) => !sameDeliveryRevision(c.revision, pipeline.revision),
    )?.publishedHeadSha ?? pipeline.revision.headSha;
  if (
    workspace.pipelineId !== pipeline.pipelineId ||
    workspace.repoId !== pipeline.repoId ||
    workspace.branch !== context.branch ||
    workspace.treeSha !== pipeline.revision.treeSha ||
    workspace.originalHeadSha !== parent ||
    source !== workspace.sourceRoot ||
    storage !== workspace.storageRoot ||
    root !== workspace.root ||
    root !== context.root ||
    root === source ||
    (await lstat(root)).isSymbolicLink() ||
    record?.id !== workspace.worktreeId ||
    record.owningWorkflowRunId !== `factory-delivery:${pipeline.pipelineId}` ||
    record.createdBy !== 'factory-delivery' ||
    record.repoId !== pipeline.repoId ||
    record.headRef !== workspace.branch ||
    record.lifecycleStatus === 'deleted'
  )
    throw new Error('Publication workspace ownership mismatch.');
  const common = async (cwd: string) =>
    realpath(
      resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()),
    );
  if (
    (await common(source)) !== (await common(root)) ||
    (await git(root, ['rev-parse', '--show-toplevel'])).trim() !== root ||
    (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim() !==
      workspace.branch ||
    !(await git(source, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .includes(`worktree ${root}`)
  )
    throw new Error('Publication Git worktree identity mismatch.');
  return workspace;
}
export {
  assertTree,
  recoveredCommit,
  publicationMessage,
} from './publication-tree';
/** Deterministic, dedicated workspace. Never touches the retained checkout's
 * files, index, or HEAD. No commit and no remote operation occurs here.
 */
export async function preparePublicationWorkspace(
  pipelineInput: DeliveryPipeline,
  evidenceInput: CandidateEvidence,
  paths: RuntimePaths,
  assertAuthority: AssertPublicationAuthority,
): Promise<PublicationWorkspace> {
  const pipeline = await owned(pipelineInput, paths, assertAuthority);
  const evidence = v.parse(candidateEvidenceSchema, evidenceInput);
  v.parse(hash, pipeline.pipelineId);
  v.parse(branch, pipeline.branch);
  if (
    evidence.repoId !== pipeline.repoId ||
    evidence.attemptId !== pipeline.revision.attemptId ||
    evidence.headSha !== pipeline.revision.headSha ||
    evidence.baseSha !== pipeline.revision.baseSha ||
    evidence.treeSha !== pipeline.revision.treeSha ||
    evidence.evidenceDigest !== pipeline.revision.candidateDigest
  )
    throw new Error('Publication evidence does not match reserved revision.');
  const bound = pipeline.commits.findLast((c) =>
    sameDeliveryRevision(c.revision, pipeline.revision),
  );
  const prior = pipeline.commits.findLast(
    (c) => !sameDeliveryRevision(c.revision, pipeline.revision),
  );
  const originalHeadSha = prior?.publishedHeadSha ?? evidence.headSha;
  await assertAuthority();
  const {
    sourceRoot,
    storageRoot,
    root,
    worktreeId,
    branch: localBranch,
  } = await reserveFactoryPublicationWorkspace(
    {
      pipelineId: pipeline.pipelineId,
      repoId: pipeline.repoId,
      expectedVersion: pipeline.version,
      originalHeadSha,
    },
    paths,
  );
  if (root === evidence.root || root === sourceRoot)
    throw new Error('Publication cannot reuse the retained checkout.');
  const workspace = v.parse(publicationWorkspaceSchema, {
    pipelineId: pipeline.pipelineId,
    repoId: pipeline.repoId,
    worktreeId,
    root,
    storageRoot,
    sourceRoot,
    branch: localBranch,
    originalHeadSha,
    treeSha: evidence.treeSha,
  });
  if (
    (await object(sourceRoot, originalHeadSha, 'commit')) !== originalHeadSha ||
    (await object(sourceRoot, evidence.treeSha, 'tree')) !== evidence.treeSha
  )
    throw new Error('Missing immutable publication objects.');
  if (!(await exists(root))) {
    // A crash may have created the reserved branch before adding the worktree.
    const refs = (
      await git(sourceRoot, [
        'for-each-ref',
        '--format=%(objectname)',
        `refs/heads/${workspace.branch}`,
      ])
    ).trim();
    if (refs && refs !== originalHeadSha)
      throw new Error('Reserved branch changed before workspace creation.');
    await assertAuthority();
    const hooks = await trustedPublicationHooks(sourceRoot);
    await git(sourceRoot, [
      '-c',
      `core.hooksPath=${hooks.hooksPath}`,
      'worktree',
      'add',
      ...(refs ? [] : ['-b', workspace.branch]),
      '--',
      root,
      refs ? workspace.branch : originalHeadSha,
    ]);
  }
  await verifyWorkspace(workspace, pipeline, paths, assertAuthority);
  const recovery = await recoveredCommit(workspace);
  if (recovery) {
    if (bound && bound.publishedHeadSha !== recovery.publishedHeadSha)
      throw new Error('Bound publication commit changed.');
    await readValidatedPublicationCommitReceipt(pipeline, workspace, paths);
    return workspace;
  }
  if (bound) throw new Error('Bound publication commit is missing.');
  // Do not silently erase a dirty verification/failed-hook checkout on restart.
  const indexTree = (await git(root, ['write-tree'])).trim();
  const rawTree = await captureCandidateTree(root, storageRoot);
  const parentTree = await object(root, originalHeadSha, 'tree');
  if (indexTree === workspace.treeSha && rawTree === workspace.treeSha) {
    await assertAuthority();
    settleFactoryPublicationWorkspace(
      {
        pipelineId: pipeline.pipelineId,
        repoId: pipeline.repoId,
        expectedVersion: pipeline.version,
        phase: 'ready',
        headSha: originalHeadSha,
      },
      paths,
    );
    return workspace;
  }
  if (indexTree !== parentTree || rawTree !== parentTree)
    throw new Error('Publication checkout has uncertified modifications.');
  await assertAuthority();
  await git(root, ['read-tree', '--reset', '-u', workspace.treeSha]);
  await assertTree(workspace);
  await assertAuthority();
  settleFactoryPublicationWorkspace(
    {
      pipelineId: pipeline.pipelineId,
      repoId: pipeline.repoId,
      expectedVersion: pipeline.version,
      phase: 'ready',
      headSha: originalHeadSha,
    },
    paths,
  );
  return workspace;
}
