import * as v from 'valibot';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import {
  publicationCommitSchema,
  publicationPushTargetSchema,
  sha,
  type PublicationWorkspace,
  type PublicationCommit,
  type PublicationPushTarget,
} from './publication-contract';
import { readPublicationWorkspaceIdentity } from './publication-workspace';
import { git } from './publication-git-io';
import {
  readValidatedPublicationCommitReceipt,
  readStoredPublicationPushTarget,
} from './publication-git';

const retainedWorkspace = (
  p: DeliveryPipeline,
  raw: PublicationWorkspace,
  paths: RuntimePaths,
) => readPublicationWorkspaceIdentity(raw, p, paths);
export async function observePublicationCommit(
  p: DeliveryPipeline,
  raw: PublicationWorkspace,
  paths: RuntimePaths,
) {
  const workspace = await retainedWorkspace(p, raw, paths);
  return readValidatedPublicationCommitReceipt(p, workspace, paths);
}
export async function observePublicationPush(
  p: DeliveryPipeline,
  raw: PublicationCommit,
  rawTarget: PublicationPushTarget,
  paths: RuntimePaths,
) {
  const commit = v.parse(publicationCommitSchema, raw);
  const { publishedHeadSha: _head, ...workspace } = commit;
  await retainedWorkspace(p, workspace, paths);
  const target = await readStoredPublicationPushTarget(
    p,
    workspace,
    v.parse(publicationPushTargetSchema, rawTarget),
    paths,
  );
  const output = (
    await git(workspace.root, [
      'ls-remote',
      '--refs',
      '--',
      target.url,
      `refs/heads/${target.branch}`,
    ])
  ).trim();
  if (!output) return { remoteSha: null };
  const fields = output.split('\t');
  if (fields.length !== 2 || fields[1] !== `refs/heads/${target.branch}`)
    throw new Error('Ambiguous remote observation.');
  return { remoteSha: v.parse(sha, fields[0]) };
}
