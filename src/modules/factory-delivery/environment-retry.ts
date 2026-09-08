import { readFactoryPublicationWorkspace } from '../worktrees';
import { assertVerificationCheckout } from './verification';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { CandidateEvidence } from './evidence';
import * as v from 'valibot';
import { deliveryControlInputSchema } from '../../../shared/factory-delivery-api';
import type { RuntimePaths } from '../../runtime-home';
import { FactoryError, factoryValidationPolicy } from '../factory';
import { isDeepStrictEqual } from 'node:util';
import { assertDeliveryAuthority } from './authority';
import { requireDelivery, changeDelivery } from './service-records';
import { factoryDeliveryDetail } from './service-operator';
import { captureCandidateEvidence } from './evidence';
import { codingHandle, requireCodingRun } from '../factory';
import { deliveryBudget } from './store';

export async function retryFactoryEnvironmentSetup(
  id: string,
  raw: unknown,
  paths: RuntimePaths,
  dependencies = {
    checkout: async (
      pipeline: DeliveryPipeline,
      evidence: CandidateEvidence,
      runtime: RuntimePaths,
    ) => {
      const workspace = await readFactoryPublicationWorkspace(
        { pipelineId: pipeline.pipelineId, repoId: pipeline.repoId },
        runtime,
      );
      if (!workspace.record)
        throw new Error('Missing owned verification checkout.');
      await assertVerificationCheckout(
        workspace.root,
        evidence,
        codingHandle(
          requireCodingRun(pipeline.revision.runId, runtime),
          runtime,
        ).directory,
      );
    },
    policy: factoryValidationPolicy,
    detail: factoryDeliveryDetail,
    assert: assertDeliveryAuthority,
    capture: async (runId: string, runtime: RuntimePaths) =>
      captureCandidateEvidence(
        codingHandle(requireCodingRun(runId, runtime), runtime),
      ),
  },
) {
  const input = v.parse(deliveryControlInputSchema, raw);
  const current = requireDelivery(id, paths);
  const intervention = current.interventions.find(
    (i) => i.kind === 'environment' && !i.resolution,
  );
  if (
    current.version !== input.expectedVersion ||
    !intervention ||
    current.outcome ||
    current.effects.some(
      (e) => e.state === 'in-flight' || e.state === 'uncertain',
    ) ||
    current.interventions.some((i) => !i.resolution && i !== intervention) ||
    deliveryBudget(current).remainingExecutionMs <= 0
  )
    throw new FactoryError(
      409,
      'Environment retry requires a settled setup blocker and remaining approved budget.',
    );
  const policy = dependencies.policy(
    current.repoId,
    paths,
    current.authorization.workflow?.id,
  );
  if (
    !isDeepStrictEqual(policy.workflow, current.authorization.workflow) ||
    policy.configFingerprint !== current.authorization.configFingerprint
  )
    throw new FactoryError(
      409,
      'Workflow or configuration changed. Review and release the plan again.',
    );
  dependencies.assert(
    {
      ...current,
      interventions: current.interventions.filter((i) => i !== intervention),
    },
    paths,
  );
  const evidence = await dependencies.capture(current.revision.runId, paths);
  if (
    evidence.evidenceDigest !== current.revision.candidateDigest ||
    requireDelivery(id, paths).version !== current.version
  )
    throw new FactoryError(
      409,
      'Candidate or delivery changed before environment retry.',
    );
  try {
    await dependencies.checkout(current, evidence, paths);
  } catch {
    throw new FactoryError(
      409,
      'The retained setup checkout changed or its ownership could not be verified. Inspect setup diagnostics before retry; no candidate or checkout was reset.',
    );
  }
  if (requireDelivery(id, paths).version !== current.version)
    throw new FactoryError(409, 'Delivery changed before environment retry.');
  changeDelivery(
    id,
    {
      type: 'resolve-intervention',
      id: intervention.id,
      resolution: `Explicit environment retry: ${input.reason}`,
    },
    paths,
  );
  return dependencies.detail(id, paths);
}
