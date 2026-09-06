import * as v from 'valibot';
import { captureCandidateTree } from './evidence';
import { git, object } from './publication-git-io';
import {
  publicationCommitSchema,
  type PublicationWorkspace,
} from './publication-contract';
export async function assertTree(workspace: PublicationWorkspace) {
  if (
    (await captureCandidateTree(workspace.root, workspace.storageRoot)) !==
      workspace.treeSha ||
    (await git(workspace.root, ['write-tree'])).trim() !== workspace.treeSha
  )
    throw new Error(
      'Publication tree changed, including hook or verification mutations.',
    );
}
export async function recoveredCommit(workspace: PublicationWorkspace) {
  const head = await object(workspace.root, 'HEAD', 'commit');
  if (head === workspace.originalHeadSha) return null;
  const parents = (
    await git(workspace.root, ['show', '-s', '--format=%P', head])
  ).trim();
  if (
    parents !== workspace.originalHeadSha ||
    (await object(workspace.root, head, 'tree')) !== workspace.treeSha
  )
    throw new Error('Publication branch conflicts with expected parent/tree.');
  const message = (
    await git(workspace.root, ['show', '-s', '--format=%B', head])
  ).trim();
  if (message !== publicationMessage(workspace))
    throw new Error('Publication commit provenance mismatch.');
  await assertTree(workspace);
  return v.parse(publicationCommitSchema, {
    ...workspace,
    publishedHeadSha: head,
  });
}

export function publicationMessage(workspace: PublicationWorkspace) {
  return `Factory publication ${workspace.pipelineId}\n\nCertified-tree: ${workspace.treeSha}`;
}
