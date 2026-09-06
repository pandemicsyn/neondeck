import * as v from 'valibot';
import {
  deliveryRevisionSchema,
  deliveryCheckCommandsSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import { deliveryGrantPreviewSchema } from '../../../shared/factory-delivery-api';
import {
  parseAppConfig,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { getCodingRun } from '../coding-runs';
import {
  assertCodingAuthoritySnapshot,
  codingDigest,
  FactoryError,
  readCodingExecutionUsage,
} from '../factory';
import { resolveAgentModelSelection } from '../runtime';
import { repoGuardrails } from '../autopilot-policy';
import { resolveWorktreeVerificationChecks } from '../worktree-verification';

export function deliveryContext(runId: string, paths: RuntimePaths) {
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
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const connections = (config.factory?.github ?? []).filter(
    (c) => c.enabled && c.repoId === run.snapshot.repoId,
  );
  if (connections.length !== 1)
    throw new FactoryError(
      409,
      'Configure exactly one enabled GitHub connection for this repository.',
    );
  const connection = connections[0]!;
  const models = resolveAgentModelSelection(config);
  if (!models.prReviewConfigured)
    throw new FactoryError(
      409,
      'Configure an independent PR reviewer model before authorizing delivery.',
    );
  const resolvedChecks = resolveWorktreeVerificationChecks(
    undefined,
    authority.repo,
    [...repoGuardrails(authority.repo, config).requiredChecks],
  );
  const checks = v.safeParse(deliveryCheckCommandsSchema, resolvedChecks);
  if (!checks.success)
    throw new FactoryError(
      409,
      'Configure between 1 and 16 repository check commands, each at most 500 characters, before authorizing delivery.',
    );
  const checkCommands = checks.output;
  const target = {
    owner: connection.owner,
    name: connection.name,
    baseBranch: authority.repo.defaultBranch,
  };
  const configFingerprint = codingDigest({
    connection,
    target,
    checkCommands,
    coding: authority.coding,
    reviewer: models.prReview,
    reviewerThinking: models.prReviewThinkingLevel,
  });
  return {
    run,
    authority,
    connection,
    target,
    checkCommands,
    configFingerprint,
    reviewerModel: models.prReview,
    reviewerThinkingLevel: models.prReviewThinkingLevel,
  };
}

export async function deliveryPreview(
  runId: string,
  candidateDigest: string,
  treeSha: string,
  paths: RuntimePaths,
) {
  const context = deliveryContext(runId, paths);
  const { run, target, configFingerprint, checkCommands } = context;
  const initialExecutionMs = await readCodingExecutionUsage(run, paths);
  if (initialExecutionMs === null)
    throw new FactoryError(
      409,
      'Authenticated coding execution endpoints are unavailable. Reconcile the retained attempt before authorizing delivery.',
    );
  if (initialExecutionMs >= 10800000)
    throw new FactoryError(
      409,
      'This candidate has exhausted the three-hour delivery budget. Return to planning and release a new candidate before requesting another delivery grant.',
    );
  const revision = v.parse(deliveryRevisionSchema, {
    runId: run.runId,
    attemptId: run.attemptId,
    releaseId: run.snapshot.releaseId,
    specVersion: run.snapshot.specVersion,
    specHash: run.snapshot.specHash,
    candidateDigest,
    treeSha,
    baseSha: run.candidate!.baseSha,
    headSha: run.candidate!.headSha,
  });
  return v.parse(deliveryGrantPreviewSchema, {
    workItemId: run.snapshot.workItemId,
    repoId: run.snapshot.repoId,
    revision,
    target,
    configFingerprint,
    checkCommands,
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
    initialExecutionMs,
    maxAttemptMs: Math.min(2700000, context.authority.coding.wallTimeMs),
    publish: 'draft-pr-only',
    merge: false,
    deploy: false,
  });
}

/** Release publish:false remains unchanged; only this exact human grant adds delivery authority. */
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
  const context = deliveryContext(pipeline.revision.runId, paths);
  const grant = pipeline.authorization;
  if (
    context.configFingerprint !== grant.configFingerprint ||
    context.run.snapshot.releaseId !== grant.revision.releaseId ||
    context.run.snapshot.specHash !== grant.revision.specHash ||
    context.run.snapshot.specVersion !== grant.revision.specVersion ||
    context.run.snapshot.repoId !== grant.repoId ||
    JSON.stringify(context.target) !== JSON.stringify(grant.target)
  )
    throw new FactoryError(
      409,
      'Delivery grant is stale. Return to planning and authorize the new exact candidate.',
    );
  return context;
}
