import { sanitizeEvidenceText } from './evidence-content';
import { isDeepStrictEqual } from 'node:util';
import * as v from 'valibot';
import {
  deliveryControlInputSchema,
  deliveryDetailSchema,
  deliveryGrantInputSchema,
  deliveryStateSchema,
} from '../../../shared/factory-delivery-api';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { codingHandle, getPlanningState, FactoryError } from '../factory';
import { captureCandidateEvidence } from './evidence';
import { deliveryContext, deliveryPreview } from './authority';
import {
  listDeliveryPipelines,
  reserveDeliveryPipeline,
  deliveryBudget,
} from './store';
import {
  changeDelivery,
  deliveryReceipt,
  interveneDelivery,
  requireDelivery,
} from './service-records';

export function factoryDeliveryDetail(
  input: DeliveryPipeline | string,
  paths: RuntimePaths,
) {
  const pipeline =
    typeof input === 'string' ? requireDelivery(input, paths) : input;
  const intervention = pipeline.interventions.find((i) => !i.resolution);
  return v.parse(deliveryDetailSchema, {
    pipeline: {
      ...pipeline,
      progress: {
        ...pipeline.progress,
        assessments: pipeline.progress.assessments.map((assessment) => ({
          ...assessment,
          instructions: sanitizeEvidenceText(
            assessment.instructions,
            paths,
            20000,
          ).text,
          evidenceRefs: assessment.evidenceRefs.map(
            (ref) => sanitizeEvidenceText(ref, paths, 500).text,
          ),
          result: assessment.result
            ? {
                ...assessment.result,
                rationale: sanitizeEvidenceText(
                  assessment.result.rationale,
                  paths,
                  4000,
                ).text,
                evidenceRefs: assessment.result.evidenceRefs.map(
                  (ref) => sanitizeEvidenceText(ref, paths, 500).text,
                ),
                nextInstructions:
                  assessment.result.nextInstructions === null
                    ? null
                    : sanitizeEvidenceText(
                        assessment.result.nextInstructions,
                        paths,
                        20000,
                      ).text,
              }
            : null,
        })),
      },
    },
    budget: deliveryBudget(pipeline),
    plannerSessionId: getPlanningState(pipeline.workItemId, paths).sessionId,
    planningWorkId: pipeline.workItemId,
    nextAction: pipeline.outcome
      ? 'complete'
      : pipeline.effects.some((effect) => effect.state === 'uncertain')
        ? 'reconcile'
        : intervention
          ? intervention.kind === 'uncertainty'
            ? 'reconcile'
            : `human-${intervention.kind}`
          : 'running',
  });
}
export function factoryDeliveryList(input: unknown, paths: RuntimePaths) {
  return listDeliveryPipelines(input, paths).map(({ record }) =>
    factoryDeliveryDetail(record, paths),
  );
}
export function factoryDeliveryState(paths: RuntimePaths) {
  const deliveries = [];
  let after = 0;
  for (;;) {
    const rows = listDeliveryPipelines({ after, limit: 100 }, paths);
    deliveries.push(
      ...rows.map((row) => factoryDeliveryDetail(row.record, paths)),
    );
    if (rows.length < 100) break;
    after = rows.at(-1)!.sequence;
  }
  return v.parse(deliveryStateSchema, { deliveries });
}
export async function factoryDeliveryPreview(
  runId: string,
  paths: RuntimePaths,
  capture = captureCandidateEvidence,
) {
  const { run } = deliveryContext(runId, paths);
  const evidence = await capture(codingHandle(run, paths));
  return deliveryPreview(
    runId,
    evidence.evidenceDigest,
    evidence.treeSha,
    paths,
  );
}
export async function authorizeFactoryDelivery(
  raw: unknown,
  paths: RuntimePaths,
  capture = captureCandidateEvidence,
) {
  const input = v.parse(deliveryGrantInputSchema, raw);
  const { run } = deliveryContext(input.preview.revision.runId, paths);
  const evidence = await capture(codingHandle(run, paths));
  const preview = await deliveryPreview(
    run.runId,
    evidence.evidenceDigest,
    evidence.treeSha,
    paths,
  );
  if (!isDeepStrictEqual(preview, input.preview))
    throw new FactoryError(
      409,
      'Candidate or delivery authority changed. Refresh the exact grant preview.',
    );
  let existing: DeliveryPipeline | undefined;
  let after = 0;
  for (;;) {
    const rows = listDeliveryPipelines(
      { after, limit: 100, workItemId: preview.workItemId },
      paths,
    );
    existing = rows
      .map((r) => r.record)
      .find((r) => r.initialRevision.releaseId === preview.revision.releaseId);
    if (existing || rows.length < 100) break;
    after = rows.at(-1)!.sequence;
  }
  if (existing && existing.initialRevision.runId !== run.runId)
    throw new FactoryError(
      409,
      `This release already belongs to delivery ${existing.pipelineId}. Open that delivery; a repair candidate cannot reset its grant or budget.`,
    );
  const authorization = {
    id: input.requestId,
    authorizedBy: 'local-operator',
    authorizedAt:
      existing?.authorization.authorizedAt ?? new Date().toISOString(),
    revision: preview.revision,
    repoId: preview.repoId,
    target: preview.target,
    configFingerprint: preview.configFingerprint,
    checkCommands: preview.checkCommands,
    maxRepairAttempts: preview.maxRepairAttempts,
    totalExecutionMs: preview.totalExecutionMs,
    initialExecutionMs: preview.initialExecutionMs,
  };
  const pipeline = reserveDeliveryPipeline(
    {
      workItemId: preview.workItemId,
      repoId: preview.repoId,
      initialRevision: preview.revision,
      authorization,
    },
    paths,
  );
  if (!pipeline.coordinator.candidateRef) {
    const candidateRef = deliveryReceipt(pipeline.pipelineId, evidence, paths);
    changeDelivery(
      pipeline.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: { ...pipeline.coordinator, candidateRef },
      },
      paths,
    );
  }
  return factoryDeliveryDetail(
    requireDelivery(pipeline.pipelineId, paths),
    paths,
  );
}
export async function revokeFactoryDelivery(
  id: string,
  raw: unknown,
  paths: RuntimePaths,
) {
  const input = v.parse(deliveryControlInputSchema, raw);
  const current = requireDelivery(id, paths);
  if (current.version !== input.expectedVersion)
    throw new FactoryError(409, 'Delivery changed. Refresh before revoking.');
  const revoked = interveneDelivery(
    id,
    'authority',
    `Human revoked delivery: ${input.reason}`,
    paths,
  );
  const { deliveryIO } = await import('./delivery-io');
  await deliveryIO.cancel(revoked, paths);
  return factoryDeliveryDetail(requireDelivery(id, paths), paths);
}
