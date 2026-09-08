import { isDeepStrictEqual } from 'node:util';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { getCodingRun } from '../coding-runs';
import { assertCodingAuthoritySnapshot, FactoryError } from '../factory';
import { resolvePublicationContext } from './publication-context';
import { assertPublicationAuthorized } from './delivery-aggregate';

export function localValidationContext(runId: string, paths: RuntimePaths) {
  const run = getCodingRun(runId, paths);
  if (
    !run ||
    run.status !== 'candidate' ||
    !run.candidate ||
    !run.deadProof ||
    !run.workspace
  )
    throw new FactoryError(
      409,
      'A settled candidate with verified writer death is required.',
    );
  const authority = assertCodingAuthoritySnapshot(run.snapshot, paths);
  // Current settings govern new releases; this run retains its approved contract.
  const validationPolicy = authority.release.validationPolicy;
  if (!validationPolicy)
    throw new FactoryError(
      409,
      'A fresh release with the current validation policy is required. Retained work remains available.',
    );
  return {
    run,
    authority,
    validationPolicy,
    target: {
      ...authority.repo.github,
      baseBranch: authority.repo.defaultBranch,
    },
    checkCommands: validationPolicy.checkCommands,
    configFingerprint: validationPolicy.configFingerprint,
    reviewerModel: validationPolicy.reviewerModel,
    reviewerThinkingLevel: validationPolicy.reviewerThinkingLevel ?? undefined,
  };
}
export function pipelineValidationContext(
  pipeline: DeliveryPipeline,
  paths: RuntimePaths,
) {
  if (pipeline.authorization.mode !== 'local-validation')
    throw new FactoryError(
      409,
      'This historical delivery requires a fresh release. Retained evidence is available.',
    );
  return localValidationContext(pipeline.revision.runId, paths);
}
export function assertDeliveryAuthority(
  pipeline: DeliveryPipeline,
  paths: RuntimePaths,
) {
  if (
    pipeline.outcome ||
    pipeline.interventions.some((i) => i.resolution === null)
  )
    throw new FactoryError(
      409,
      'Delivery is terminal or requires a human intervention.',
    );
  const context = pipelineValidationContext(pipeline, paths);
  const grant = pipeline.authorization;
  if (
    context.configFingerprint !== grant.configFingerprint ||
    context.run.snapshot.releaseId !== grant.revision.releaseId ||
    context.run.snapshot.specHash !== grant.revision.specHash ||
    context.run.snapshot.specVersion !== grant.revision.specVersion ||
    context.run.snapshot.repoId !== grant.repoId ||
    !isDeepStrictEqual(context.target, grant.target)
  )
    throw new FactoryError(
      409,
      'Validation authority changed. Review the plan and release it again.',
    );
  if (!pipeline.publication) return { ...context, connection: null };
  assertPublicationAuthorized(pipeline);
  const publication = resolvePublicationContext(pipeline.repoId, paths);
  if (
    publication.configFingerprint !== pipeline.publication.configFingerprint ||
    !isDeepStrictEqual(publication.target, pipeline.publication.target)
  )
    throw new FactoryError(
      409,
      'Publication configuration changed after approval.',
    );
  return { ...context, connection: publication.connection };
}
