import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import {
  type PublicationWorkspace,
  type PublicationCommit,
  type AssertPublicationAuthority,
} from './publication-contract';
import { git } from './publication-git-io';
import { commitConfiguration } from './publication-hooks';
import {
  beginPublicationCommit,
  writePublicationCommitSuccess,
  readValidatedPublicationCommitReceipt,
} from './publication-commit-proof';
import { settleFactoryPublicationWorkspace } from '../worktrees';
import {
  verifyWorkspace,
  recoveredCommit,
  assertTree,
  publicationMessage,
} from './publication-workspace';
/** Normal commit, with configured identity/signing and repository hooks. Hook
 * failure is not retried here. Tree/parent drift fails closed, even after commit.
 */
export async function commitPublicationWorkspace(
  pipeline: DeliveryPipeline,
  input: PublicationWorkspace,
  paths: RuntimePaths,
  assertAuthority: AssertPublicationAuthority,
): Promise<PublicationCommit> {
  const workspace = await verifyWorkspace(
    input,
    pipeline,
    paths,
    assertAuthority,
  );
  const config = await commitConfiguration(workspace);
  const previous = await beginPublicationCommit(
    pipeline,
    workspace,
    paths,
    config,
  );
  if (previous) {
    const recovery = await readValidatedPublicationCommitReceipt(
      pipeline,
      workspace,
      paths,
    );
    if (!recovery) throw new Error('Publication commit outcome is uncertain.');
    return recovery;
  }
  await assertTree(workspace);
  await assertAuthority();
  await git(workspace.root, [
    '-c',
    `core.hooksPath=${config.hooksPath}`,
    'commit',
    '--allow-empty',
    '-m',
    publicationMessage(workspace),
  ]);
  if ((await commitConfiguration(workspace)).fingerprint !== config.fingerprint)
    throw new Error('Repository commit configuration changed.');
  const result = await recoveredCommit(workspace);
  if (!result) throw new Error('Git did not create the publication commit.');
  await assertAuthor(workspace.root, result.publishedHeadSha, config);
  await writePublicationCommitSuccess(pipeline, result, paths, config);
  await assertAuthority();
  settleFactoryPublicationWorkspace(
    {
      pipelineId: pipeline.pipelineId,
      repoId: pipeline.repoId,
      expectedVersion: pipeline.version,
      phase: 'committed',
      headSha: result.publishedHeadSha,
    },
    paths,
  );
  return result;
}
async function assertAuthor(
  root: string,
  sha: string,
  config: { name: string; email: string },
) {
  const author = (
    await git(root, ['show', '-s', '--format=%an%n%ae', sha])
  ).trim();
  if (author !== `${config.name}\n${config.email}`)
    throw new Error('Publication commit author mismatch.');
}
