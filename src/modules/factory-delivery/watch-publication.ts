import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { readWatches } from '../watches';
import {
  lookupFactoryGitHubPull,
  createFactoryGitHubDraftPull,
} from '../github';
import { assertDeliveryAuthority } from './authority';
import { getFactoryDeliveryOwnership, sameDeliveryRevision } from './store';
import { requireDelivery } from './service-records';

export const deliveryPullIdentity = (p: DeliveryPipeline) => ({
  head: p.branch,
  base: p.authorization.target.baseBranch,
  marker: `<!-- neon-factory-pr:${p.pipelineId} -->`,
});
export function currentPublishedCommit(p: DeliveryPipeline) {
  const commit = p.commits.findLast((c) =>
    sameDeliveryRevision(c.revision, p.revision),
  );
  if (!commit) throw new Error('Published tree mapping missing.');
  return commit;
}
export function assertNoLegacyOwner(
  p: DeliveryPipeline,
  paths: RuntimePaths,
  number?: number,
) {
  const target = p.authorization.target;
  const conflict = readWatches(paths).find(
    (w) =>
      (w.repoId === p.repoId ||
        (w.githubOwner.toLowerCase() === target.owner.toLowerCase() &&
          w.githubName.toLowerCase() === target.name.toLowerCase())) &&
      (number === undefined || w.prNumber === number) &&
      (w.ownerInstanceId !== null ||
        w.worktreeId !== null ||
        ['working', 'waiting'].includes(w.autopilotStatus)),
  );
  if (conflict)
    throw new Error('An existing legacy owner holds this publication target.');
}
export async function createDeliveryPr(
  p: DeliveryPipeline,
  paths: RuntimePaths,
) {
  const { connection, authority } = assertDeliveryAuthority(p, paths);
  if (
    !p.effects.some(
      (e) =>
        e.kind === 'create-pr' &&
        e.state === 'in-flight' &&
        sameDeliveryRevision(e.revision, p.revision),
    ) ||
    getFactoryDeliveryOwnership({ repoId: p.repoId, branch: p.branch }, paths)
      ?.pipelineId !== p.pipelineId
  )
    throw new Error('Durable publication claim required.');
  assertNoLegacyOwner(p, paths);
  const identity = deliveryPullIdentity(p);
  const found = await lookupFactoryGitHubPull(connection, identity, {
    fresh: true,
  });
  if (found.status === 'incomplete') throw new Error('PR lookup incomplete.');
  if (found.status === 'found') {
    if (
      found.pull.state !== 'open' ||
      !found.pull.draft ||
      found.pull.head.sha !== currentPublishedCommit(p).publishedHeadSha
    )
      throw new Error('Existing PR is not the exact draft revision.');
    assertNoLegacyOwner(p, paths, found.pull.number);
    return { number: found.pull.number, url: found.pull.html_url };
  }
  const current = requireDelivery(p.pipelineId, paths);
  if (current.version !== p.version)
    throw new Error('Publication claim changed.');
  assertDeliveryAuthority(current, paths);
  assertNoLegacyOwner(current, paths);
  const pull = await createFactoryGitHubDraftPull(connection, {
    ...identity,
    title: authority.current.work.title,
    body: [
      `Scope: ${authority.current.work.title}`,
      `Initial publication evidence — independent repository checks passed: ${p.authorization.checkCommands.join(', ')}. A separate reviewer assessed the certified tree.`,
      `Initially certified tree: ${p.revision.treeSha}. Initial published commit: ${currentPublishedCommit(p).publishedHeadSha}.`,
      `This section records only the initial publication. Authorized repairs may update the PR head; current checks and certification are available in Neon. External CI and human review remain required; no merge or deployment has been performed.`,
    ].join('\n\n'),
  });
  if (pull.head.sha !== currentPublishedCommit(p).publishedHeadSha)
    throw new Error('Created PR head changed.');
  return { number: pull.number, url: pull.html_url };
}
