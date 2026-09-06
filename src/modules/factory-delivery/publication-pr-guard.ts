import * as v from 'valibot';
import {
  deliveryPipelineSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import { githubConnectionSchema } from '../../../shared/factory-github';
import type { RuntimePaths } from '../../runtime-home';
import { readFactoryGitHubPull } from '../github';
import { assertDeliveryAuthority } from './authority';
import { sameDeliveryRevision } from './store';
import { deliveryPullIdentity } from './watch-publication';

const priorHeadSchema = v.nullable(
  v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
);

/**
 * Mutation gate only: call immediately before a repaired push, never for
 * read-only recovery. This fresh observation is not provider CAS: the Git
 * branch lease still guards the head, and GitHub can change other PR facts
 * after this GET. A first publication has no bound PR and uses that lease.
 */
export async function assertPublicationPrPushAllowed(
  input: DeliveryPipeline,
  expectedPriorPublishedSha: string | null,
  paths: RuntimePaths,
): Promise<void> {
  const pipeline = v.parse(deliveryPipelineSchema, input);
  const expectedHead = v.parse(priorHeadSchema, expectedPriorPublishedSha);
  if (pipeline.pr === null) return;

  const prior = pipeline.commits.findLast(
    (commit) => !sameDeliveryRevision(commit.revision, pipeline.revision),
  );
  if (expectedHead === null || prior?.publishedHeadSha !== expectedHead)
    throw new Error('Repair push requires the bound prior published head.');

  const { connection: configuredConnection, authority } =
    assertDeliveryAuthority(pipeline, paths);
  const connection = v.parse(githubConnectionSchema, configuredConnection);
  const target = pipeline.authorization.target;
  if (
    !connection.enabled ||
    connection.repoId !== pipeline.repoId ||
    pipeline.authorization.repoId !== pipeline.repoId ||
    authority.repo.id !== pipeline.repoId ||
    connection.owner !== target.owner ||
    connection.name !== target.name ||
    authority.repo.github?.owner !== target.owner ||
    authority.repo.github?.name !== target.name
  )
    throw new Error('Repair push source repository configuration changed.');

  // The reader strictly validates number, canonical URL, both repository IDs,
  // exact head/base refs and the single durable marker. Errors fail closed.
  const pull = await readFactoryGitHubPull(
    connection,
    pipeline.pr.number,
    deliveryPullIdentity(pipeline),
    { fresh: true },
  );
  if (
    pull.html_url !== pipeline.pr.url ||
    pull.state !== 'open' ||
    !pull.draft ||
    pull.merged ||
    pull.merged_at !== null ||
    pull.head.sha !== expectedHead
  )
    throw new Error(
      'Repair push requires the exact open draft PR and prior head.',
    );
}
