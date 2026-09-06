import { PublicationPushNotAttemptedError } from './publication-nonadmission';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { sameDeliveryRevision } from './store';
import {
  sha,
  publicationPushTargetSchema,
  publicationWorkspaceFrom,
  publicationPushReceiptSchema,
  publicationCommitSchema,
  type PublicationWorkspace,
  type PublicationCommit,
  type PublicationPushTarget,
  type AssertPublicationAuthority,
} from './publication-contract';
import { git } from './publication-git-io';
import { trustedPublicationHooks } from './publication-hooks';
import { settleFactoryPublicationWorkspace } from '../worktrees';
import { readValidatedPublicationCommitReceipt } from './publication-commit-proof';
import {
  verifyWorkspace,
  readPublicationWorkspaceIdentity,
} from './publication-workspace';
function remoteRepository(url: string) {
  const scp = url.match(
    /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (scp) return scp[1];
  const parsed = new URL(url);
  if (
    parsed.hostname !== 'github.com' ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.password ||
    !['https:', 'ssh:'].includes(parsed.protocol) ||
    (parsed.protocol === 'https:'
      ? !!parsed.username
      : parsed.username !== 'git')
  )
    throw new Error('Publication requires a credential-safe GitHub remote.');
  const fullName = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
  return v.parse(
    v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)),
    fullName,
  );
}
export async function readPublicationPushTarget(
  pipeline: DeliveryPipeline,
  input: PublicationWorkspace,
  remote: string,
  paths: RuntimePaths,
  assertAuthority: AssertPublicationAuthority,
): Promise<PublicationPushTarget> {
  const workspace = await verifyWorkspace(
    input,
    pipeline,
    paths,
    assertAuthority,
  );
  return actualPushTarget(pipeline, workspace, remote);
}
async function actualPushTarget(
  pipeline: DeliveryPipeline,
  workspace: PublicationWorkspace,
  remote: string,
): Promise<PublicationPushTarget> {
  const rewrites = await git(workspace.root, [
    'config',
    '--get-regexp',
    '^url\\..*\\.(insteadof|pushinsteadof)$',
  ]).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 1)
      return '';
    throw error;
  });
  if (rewrites.trim())
    throw new Error('Publication target cannot use Git URL rewrites.');
  v.parse(publicationPushTargetSchema.entries.remote, remote);
  const fetchUrls = (
    await git(workspace.root, ['remote', 'get-url', '--all', '--', remote])
  )
    .trim()
    .split('\n');
  const pushUrls = (
    await git(workspace.root, [
      'remote',
      'get-url',
      '--push',
      '--all',
      '--',
      remote,
    ])
  )
    .trim()
    .split('\n');
  const repoFullName = `${pipeline.authorization.target.owner}/${pipeline.authorization.target.name}`;
  const url = pushUrls[0];
  if (
    !url ||
    fetchUrls.length !== 1 ||
    pushUrls.length !== 1 ||
    fetchUrls[0] !== url ||
    remoteRepository(url) !== repoFullName
  )
    throw new Error(
      'Publication remote is ambiguous or belongs to another repository.',
    );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        pipeline.repoId,
        workspace.sourceRoot,
        remote,
        url,
        repoFullName,
        pipeline.branch,
      ]),
    )
    .digest('hex');
  return v.parse(publicationPushTargetSchema, {
    remote,
    url,
    repoFullName,
    branch: pipeline.branch,
    fingerprint,
  });
}
/** Read-only snapshot validation for recovery, including source repo and rewrites. */
export async function readStoredPublicationPushTarget(
  pipeline: DeliveryPipeline,
  input: PublicationWorkspace,
  targetInput: PublicationPushTarget,
  paths: RuntimePaths,
) {
  const workspace = await readPublicationWorkspaceIdentity(
    input,
    pipeline,
    paths,
  );
  const target = v.parse(publicationPushTargetSchema, targetInput);
  const current = await actualPushTarget(pipeline, workspace, target.remote);
  if (JSON.stringify(current) !== JSON.stringify(target))
    throw new Error('Stored publication target fingerprint changed.');
  return current;
}
async function remoteHead(root: string, target: PublicationPushTarget) {
  const ref = `refs/heads/${target.branch}`;
  const output = (
    await git(root, ['ls-remote', '--refs', '--', target.url, ref])
  ).trim();
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length !== 1)
    throw new Error('Duplicate remote branch observation.');
  const fields = lines[0]?.split('\t');
  if (fields?.length !== 2 || fields[1] !== ref)
    throw new Error('Malformed remote branch observation.');
  return v.parse(sha, fields[0]);
}
/** Caller persists the commit receipt and starts a push effect first. A null
 * expectation means branch ABSENCE, never "unchecked". There is no push retry.
 */
export async function pushPublicationCommit(
  pipeline: DeliveryPipeline,
  commitInput: PublicationCommit,
  targetInput: PublicationPushTarget,
  expectedRemoteSha: string | null,
  paths: RuntimePaths,
  assertAuthority: AssertPublicationAuthority,
  beforePush: () => Promise<void>,
) {
  const commit = v.parse(publicationCommitSchema, commitInput);
  const workspace = publicationWorkspaceFrom(commit);
  const target = v.parse(publicationPushTargetSchema, targetInput);
  v.parse(v.nullable(sha), expectedRemoteSha);
  await verifyWorkspace(workspace, pipeline, paths, assertAuthority);
  const receipt = pipeline.commits.find((c) =>
    sameDeliveryRevision(c.revision, pipeline.revision),
  );
  if (
    !receipt ||
    receipt.publishedHeadSha !== commit.publishedHeadSha ||
    receipt.treeSha !== workspace.treeSha
  )
    throw new Error('Publication commit must be durably bound before push.');
  if (
    (await readValidatedPublicationCommitReceipt(pipeline, workspace, paths))
      ?.publishedHeadSha !== commit.publishedHeadSha
  )
    throw new Error('Publication commit changed before push.');
  const current = await readPublicationPushTarget(
    pipeline,
    workspace,
    target.remote,
    paths,
    assertAuthority,
  );
  if (JSON.stringify(current) !== JSON.stringify(target))
    throw new Error('Publication target fingerprint changed.');
  const observed = await remoteHead(workspace.root, current);
  if (observed === commit.publishedHeadSha)
    return v.parse(publicationPushReceiptSchema, {
      publishedHeadSha: commit.publishedHeadSha,
      remoteSha: observed,
      targetFingerprint: current.fingerprint,
      alreadyPublished: true,
    });
  if (observed !== expectedRemoteSha)
    throw new Error('Publication remote branch does not match expected lease.');
  if (expectedRemoteSha !== null)
    await git(workspace.root, [
      'merge-base',
      '--is-ancestor',
      expectedRemoteSha,
      commit.publishedHeadSha,
    ]);
  const hooks = await trustedPublicationHooks(workspace.sourceRoot);
  await assertAuthority();
  try {
    await beforePush();
    await assertAuthority();
  } catch {
    throw new PublicationPushNotAttemptedError();
  }
  // Explicit URL pins the observed endpoint; lease closes the ls-remote race.
  await git(workspace.root, [
    '-c',
    `core.hooksPath=${hooks.hooksPath}`,
    'push',
    `--force-with-lease=refs/heads/${current.branch}:${expectedRemoteSha ?? ''}`,
    '--',
    current.url,
    `${commit.publishedHeadSha}:refs/heads/${current.branch}`,
  ]);
  if (
    (await trustedPublicationHooks(workspace.sourceRoot)).fingerprint !==
    hooks.fingerprint
  )
    throw new Error('Trusted publication push hooks changed.');
  const remoteSha = await remoteHead(workspace.root, current);
  if (remoteSha !== commit.publishedHeadSha)
    throw new Error('Publication push outcome is uncertain.');
  await assertAuthority();
  settleFactoryPublicationWorkspace(
    {
      pipelineId: pipeline.pipelineId,
      repoId: pipeline.repoId,
      expectedVersion: pipeline.version,
      phase: 'pushed',
      headSha: commit.publishedHeadSha,
    },
    paths,
  );
  return v.parse(publicationPushReceiptSchema, {
    publishedHeadSha: commit.publishedHeadSha,
    remoteSha,
    targetFingerprint: current.fingerprint,
    alreadyPublished: false,
  });
}
