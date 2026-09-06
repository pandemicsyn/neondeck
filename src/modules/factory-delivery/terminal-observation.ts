import * as v from 'valibot';
import {
  deliveryAuthorizationSchema,
  deliveryRevisionSchema,
  deliveryPrSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import type { observeFactoryGitHubPull } from '../github';
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const terminalObservationSchema = v.strictObject({
  kind: v.literal('terminal-pr-observation'),
  pipelineId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  revision: deliveryRevisionSchema,
  target: deliveryAuthorizationSchema.entries.target,
  repositoryId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  pr: v.strictObject({
    ...deliveryPrSchema.entries,
    url: v.pipe(deliveryPrSchema.entries.url, v.maxLength(2000)),
  }),
  headBranch: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  publishedHeadSha: deliveryRevisionSchema.entries.headSha,
  outcome: v.picklist(['merged', 'closed']),
  updatedAt: timestamp,
  observedAt: timestamp,
  mergedAt: v.nullable(timestamp),
  mergeCommitSha: v.nullable(deliveryRevisionSchema.entries.headSha),
});

export function terminalPrObservation(
  p: DeliveryPipeline,
  commit: DeliveryPipeline['commits'][number],
  repositoryId: string,
  pull: Pick<
    Awaited<ReturnType<typeof observeFactoryGitHubPull>>['pull'],
    'merged' | 'updated_at' | 'merged_at' | 'merge_commit_sha'
  >,
  observedAt: string,
) {
  return v.parse(terminalObservationSchema, {
    kind: 'terminal-pr-observation',
    pipelineId: p.pipelineId,
    revision: commit.revision,
    target: p.authorization.target,
    repositoryId,
    pr: p.pr,
    headBranch: p.branch,
    publishedHeadSha: commit.publishedHeadSha,
    outcome: pull.merged ? 'merged' : 'closed',
    updatedAt: pull.updated_at,
    observedAt,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha,
  });
}
