import {
  readValidationAttention,
  saveValidationAttention,
  clearValidationAttention,
  CodingAuthorityChangedError,
} from '../factory';
import { publicCodingRun } from '../factory';
import { deliveryControlInputSchema } from '../../../shared/factory-delivery-api';
import * as v from 'valibot';
import { isDeepStrictEqual } from 'node:util';
import {
  validationGrantInputSchema,
  validationGrantPreviewSchema,
} from '../../../shared/factory-delivery-api';
import {
  deliveryRevisionSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { listCodingRuns, getCodingRun } from '../coding-runs';
import {
  codingHandle,
  FactoryError,
  getFactoryWork,
  readCodingExecutionUsage,
} from '../factory';
import { localValidationContext } from './authority';
import { captureCandidateEvidence } from './evidence';
import { listDeliveryPipelines, reserveDeliveryPipeline } from './store';
import {
  changeDelivery,
  deliveryReceipt,
  requireDelivery,
} from './service-records';
import { factoryDeliveryDetail } from './service-operator';
import {
  ValidationAdmissionError,
  validationAdmissionAttention,
} from './validation-admission';
export { factoryValidationPolicy } from '../factory';

function existingRelease(
  workItemId: string,
  releaseId: string,
  paths: RuntimePaths,
): DeliveryPipeline | undefined {
  let after = 0;
  for (;;) {
    const rows = listDeliveryPipelines(
      { after, limit: 100, workItemId },
      paths,
    );
    const existing = rows.find(
      ({ record }) => record.initialRevision.releaseId === releaseId,
    )?.record;
    if (existing || rows.length < 100) return existing;
    after = rows.at(-1)!.sequence;
  }
}
async function factoryValidationPreview(
  runId: string,
  paths: RuntimePaths,
  capture = captureCandidateEvidence,
) {
  const context = localValidationContext(runId, paths);
  const { run, target, validationPolicy } = context;
  const evidence = await capture(codingHandle(run, paths));
  const initialExecutionMs = await readCodingExecutionUsage(run, paths);
  if (initialExecutionMs === null)
    throw new ValidationAdmissionError('usage-unavailable');
  if (initialExecutionMs >= 10800000)
    throw new ValidationAdmissionError('budget-exhausted');
  // Capture can await filesystem work; fence settings/release again before returning authority.
  if (
    !isDeepStrictEqual(
      context.validationPolicy,
      localValidationContext(runId, paths).validationPolicy,
    )
  )
    throw new ValidationAdmissionError('policy-changed');
  return v.parse(validationGrantPreviewSchema, {
    workItemId: run.snapshot.workItemId,
    repoId: run.snapshot.repoId,
    revision: v.parse(deliveryRevisionSchema, {
      runId,
      attemptId: run.attemptId,
      releaseId: run.snapshot.releaseId,
      specVersion: run.snapshot.specVersion,
      specHash: run.snapshot.specHash,
      candidateDigest: evidence.evidenceDigest,
      treeSha: evidence.treeSha,
      baseSha: evidence.baseSha,
      headSha: evidence.headSha,
    }),
    target,
    configFingerprint: validationPolicy.configFingerprint,
    checkCommands: validationPolicy.checkCommands,
    validationPolicy,
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
    initialExecutionMs,
    maxAttemptMs: Math.min(2700000, context.authority.coding.wallTimeMs),
    publish: false,
    merge: false,
    deploy: false,
  });
}
async function authorizeValidation(
  raw: unknown,
  paths: RuntimePaths,
  capture: typeof captureCandidateEvidence,
  authorizedBy: string,
) {
  const input = v.parse(validationGrantInputSchema, raw);
  const preview = await factoryValidationPreview(
    input.preview.revision.runId,
    paths,
    capture,
  );
  if (!isDeepStrictEqual(input.preview, preview))
    throw new FactoryError(
      409,
      'Candidate or validation settings changed. Refresh the exact preview.',
    );
  const existing = existingRelease(
    preview.workItemId,
    preview.revision.releaseId,
    paths,
  );
  if (
    existing &&
    (existing.initialRevision.runId !== preview.revision.runId ||
      existing.authorization.mode !== 'local-validation' ||
      existing.authorization.id !== input.requestId)
  )
    throw new FactoryError(
      409,
      'This release already has a delivery grant. Open its retained validation and budget.',
    );
  const pipeline = reserveDeliveryPipeline(
    {
      workItemId: preview.workItemId,
      repoId: preview.repoId,
      initialRevision: preview.revision,
      authorization: {
        mode: 'local-validation',
        id: input.requestId,
        authorizedBy,
        authorizedAt:
          existing?.authorization.authorizedAt ?? new Date().toISOString(),
        revision: preview.revision,
        repoId: preview.repoId,
        target: preview.target,
        configFingerprint: preview.configFingerprint,
        checkCommands: preview.checkCommands,
        ...(preview.validationPolicy.workflow
          ? { workflow: preview.validationPolicy.workflow }
          : {}),
        maxRepairAttempts: preview.maxRepairAttempts,
        totalExecutionMs: preview.totalExecutionMs,
        initialExecutionMs: preview.initialExecutionMs,
      },
    },
    paths,
  );
  if (!pipeline.coordinator.candidateRef) {
    const context = localValidationContext(preview.revision.runId, paths);
    const evidence = await capture(codingHandle(context.run, paths));
    if (evidence.evidenceDigest !== pipeline.revision.candidateDigest)
      throw new FactoryError(
        409,
        'Candidate changed during validation authorization.',
      );
    changeDelivery(
      pipeline.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: {
          ...pipeline.coordinator,
          candidateRef: deliveryReceipt(pipeline.pipelineId, evidence, paths),
        },
      },
      paths,
    );
  }
  return factoryDeliveryDetail(
    requireDelivery(pipeline.pipelineId, paths),
    paths,
  );
}

/** Resume only releases that explicitly approved this policy. Existing pipeline owns all retries. */
async function admitReleasedRun(runId: string, paths: RuntimePaths) {
  const run = getCodingRun(runId, paths);
  if (
    !run ||
    run.status !== 'candidate' ||
    !run.deadProof ||
    !run.candidate ||
    !run.workspace
  )
    return;
  if (
    existingRelease(run.snapshot.workItemId, run.snapshot.releaseId, paths) ||
    readValidationAttention(run.runId, paths)
  )
    return;
  const release = getFactoryWork(run.snapshot.workItemId, paths).releases.find(
    (r) => r.id === run.snapshot.releaseId,
  );
  if (!release?.validationPolicy || release.withdrawnAt) return;
  let stage: 'authority' | 'preview' | 'authorization' = 'authority';
  try {
    const context = localValidationContext(run.runId, paths);
    if (!isDeepStrictEqual(release.validationPolicy, context.validationPolicy))
      throw new ValidationAdmissionError('policy-changed');
    stage = 'preview';
    const preview = await factoryValidationPreview(run.runId, paths);
    stage = 'authorization';
    await authorizeValidation(
      { requestId: `release-validation:${release.id}`, confirm: true, preview },
      paths,
      captureCandidateEvidence,
      release.actor,
    );
  } catch (error) {
    const current = getCodingRun(runId, paths);
    if (
      !current ||
      current.status !== 'candidate' ||
      readValidationAttention(runId, paths)
    )
      return;
    saveValidationAttention(
      runId,
      validationAdmissionAttention(
        error instanceof CodingAuthorityChangedError
          ? new ValidationAdmissionError('policy-changed')
          : error,
        stage,
      ),
      paths,
    );
  }
}
export async function admitReleasedValidation(paths: RuntimePaths) {
  let after = 0;
  for (;;) {
    const rows = listCodingRuns({ after, limit: 100 }, paths);
    for (const { record: run } of rows)
      await admitReleasedRun(run.runId, paths);
    if (rows.length < 100) return;
    after = rows.at(-1)!.sequence;
  }
}
export async function retryReleasedValidation(
  runId: string,
  raw: unknown,
  paths: RuntimePaths,
) {
  const input = v.parse(deliveryControlInputSchema, raw);
  const run = getCodingRun(runId, paths);
  if (
    !run ||
    run.version !== input.expectedVersion ||
    run.status !== 'candidate'
  )
    throw new FactoryError(
      409,
      'Candidate changed. Refresh before retrying validation.',
    );
  const release = getFactoryWork(run.snapshot.workItemId, paths).releases.find(
    (r) => r.id === run.snapshot.releaseId,
  );
  if (!release?.validationPolicy || release.withdrawnAt)
    throw new FactoryError(
      409,
      'This release does not authorize automatic validation.',
    );
  // Revalidate the current exact release before clearing its retained blocker.
  localValidationContext(runId, paths);
  const attention = readValidationAttention(runId, paths);
  if (
    attention?.nextAction !== 'retry-validation' &&
    attention?.nextAction !== 'inspect-diagnostics'
  )
    throw new FactoryError(
      409,
      'This validation blocker requires plan review before retry.',
    );
  clearValidationAttention(runId, paths);
  await admitReleasedRun(runId, paths);
  return publicCodingRun(getCodingRun(runId, paths)!, paths);
}
