import * as v from 'valibot';
import { isDeepStrictEqual } from 'node:util';
import {
  publicationGrantInputSchema,
  publicationPreviewSchema,
  publicationReadinessSchema,
  publicationSetupInputSchema,
  publicationSetupResultSchema,
} from '../../../shared/factory-delivery-api';
import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { FactoryError, codingHandle, codingDigest } from '../factory';
import {
  updateFactoryConfig,
  factoryConfigSnapshotFingerprint,
} from '../config';
import {
  resolvePublicationContext,
  prepareFactoryPublication,
  PublicationContextError,
} from './publication-context';
import { assertDeliveryAuthority, localValidationContext } from './authority';
import {
  awaitsPublication,
  currentPasses,
  publicationEvidenceFingerprint,
} from './delivery-aggregate';
import { captureCandidateEvidence } from './evidence';
import { changeDelivery, requireDelivery } from './service-records';
import { factoryDeliveryDetail } from './service-operator';

export async function factoryPublicationReadiness(
  id: string,
  paths: RuntimePaths,
  capture = captureCandidateEvidence,
) {
  const pipeline = requireDelivery(id, paths);
  const blocked = (
    blocker:
      | 'validation-required'
      | 'human-intervention'
      | 'publication-setup'
      | 'authority-changed'
      | 'already-authorized',
    message: string,
  ) =>
    v.parse(publicationReadinessSchema, {
      ready: false,
      blocker,
      message,
      preview: null,
    });
  if (
    pipeline.publication ||
    pipeline.authorization.mode !== 'local-validation'
  )
    return blocked(
      'already-authorized',
      'This delivery already has publication authority.',
    );
  if (pipeline.outcome || pipeline.interventions.some((i) => !i.resolution))
    return blocked(
      'human-intervention',
      'Resolve the retained delivery intervention before publication.',
    );
  if (!awaitsPublication(pipeline))
    return blocked(
      'validation-required',
      'Current independent checks and review must pass before approving a PR.',
    );
  try {
    assertDeliveryAuthority(pipeline, paths);
    const context = localValidationContext(pipeline.revision.runId, paths);
    const evidence = await capture(codingHandle(context.run, paths));
    if (
      evidence.evidenceDigest !== pipeline.revision.candidateDigest ||
      evidence.treeSha !== pipeline.revision.treeSha
    )
      return blocked(
        'authority-changed',
        'Candidate changed after validation. Review the retained candidate.',
      );
    assertDeliveryAuthority(requireDelivery(id, paths), paths);
    if (requireDelivery(id, paths).version !== pipeline.version)
      return blocked(
        'authority-changed',
        'Delivery changed during publication preview. Refresh its evidence.',
      );
  } catch {
    return blocked(
      'authority-changed',
      'Candidate or validation authority changed. Review the plan and retained evidence.',
    );
  }
  try {
    const context = resolvePublicationContext(pipeline.repoId, paths);
    const preview = v.parse(publicationPreviewSchema, {
      pipelineId: id,
      expectedVersion: pipeline.version,
      revision: pipeline.revision,
      evidenceFingerprint: publicationEvidenceFingerprint(pipeline),
      configFingerprint: context.configFingerprint,
      target: context.target,
      publish: 'draft-pr-only',
      feedbackRepairs: true,
      merge: false,
      deploy: false,
    });
    return v.parse(publicationReadinessSchema, {
      ready: true,
      blocker: null,
      message: 'Reviewed candidate is ready for explicit draft PR approval.',
      preview,
    });
  } catch (error) {
    return blocked(
      'publication-setup',
      error instanceof PublicationContextError
        ? error.message
        : 'Publication readiness could not be verified. Check repository setup and retry.',
    );
  }
}
export async function authorizeFactoryPublication(
  id: string,
  raw: unknown,
  paths: RuntimePaths,
  capture = captureCandidateEvidence,
) {
  const input = v.parse(publicationGrantInputSchema, raw);
  let pipeline = requireDelivery(id, paths);
  if (input.preview.pipelineId !== id)
    throw new FactoryError(409, 'Publication target changed.');
  if (pipeline.publication) {
    const {
      requestId,
      requestFingerprint,
      authorizedAt: _time,
      authorizedBy: _actor,
      ...grant
    } = pipeline.publication;
    const {
      pipelineId: _id,
      expectedVersion: _version,
      publish: _publish,
      feedbackRepairs: _feedback,
      merge: _merge,
      deploy: _deploy,
      ...preview
    } = input.preview;
    if (
      requestId !== input.requestId ||
      requestFingerprint !== codingDigest(input) ||
      !isDeepStrictEqual(grant, preview)
    )
      throw new FactoryError(
        409,
        'Publication request conflicts with the existing grant.',
      );
    // Exact replay recovers the immutable decision receipt, not permission to
    // admit another effect. Execution guards still check current authority.
    return factoryDeliveryDetail(pipeline, paths);
  }
  const readiness = await factoryPublicationReadiness(id, paths, capture);
  if (!readiness.ready || !isDeepStrictEqual(readiness.preview, input.preview))
    throw new FactoryError(
      409,
      readiness.ready
        ? 'Publication evidence changed. Refresh the approval preview.'
        : readiness.message,
    );
  pipeline = requireDelivery(id, paths);
  if (pipeline.version !== input.preview.expectedVersion)
    throw new FactoryError(
      409,
      'Delivery changed during publication approval.',
    );
  assertDeliveryAuthority(pipeline, paths);
  currentPasses(pipeline);
  const context = resolvePublicationContext(pipeline.repoId, paths);
  if (context.configFingerprint !== input.preview.configFingerprint)
    throw new FactoryError(
      409,
      'Publication configuration changed during approval.',
    );
  const updated = changeDelivery(
    id,
    {
      type: 'authorize-publication',
      grant: {
        requestId: input.requestId,
        requestFingerprint: codingDigest(input),
        authorizedBy: 'local-operator',
        authorizedAt: new Date().toISOString(),
        revision: input.preview.revision,
        evidenceFingerprint: input.preview.evidenceFingerprint,
        configFingerprint: input.preview.configFingerprint,
        target: input.preview.target,
      },
    },
    paths,
  );
  return factoryDeliveryDetail(updated, paths);
}
export async function setupFactoryPublication(
  repoId: string,
  raw: unknown,
  paths: RuntimePaths,
) {
  const input = v.parse(publicationSetupInputSchema, raw);
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const repos = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos;
  const fingerprint = factoryConfigSnapshotFingerprint(config, repos);
  const entry = await prepareFactoryPublication(repoId, input, paths).catch(
    (error: unknown) => {
      if (error instanceof PublicationContextError)
        throw new FactoryError(409, error.message);
      throw error;
    },
  );
  updateFactoryConfig(
    {
      publication: [
        ...(config.factory?.publication ?? []).filter(
          (p) => p.repoId !== repoId,
        ),
        entry,
      ],
    },
    paths,
    { expectedFingerprint: fingerprint },
  );
  return v.parse(publicationSetupResultSchema, { publication: [entry] });
}
