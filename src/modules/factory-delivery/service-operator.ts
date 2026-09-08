import { awaitsPublication } from './delivery-aggregate';
import { sanitizeEvidenceText } from './evidence-content';
import * as v from 'valibot';
import {
  deliveryControlInputSchema,
  deliveryDetailSchema,
  deliveryStateSchema,
} from '../../../shared/factory-delivery-api';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { getPlanningState, FactoryError } from '../factory';
import { listDeliveryPipelines, deliveryBudget } from './store';
import { interveneDelivery, requireDelivery } from './service-records';

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
      : pipeline.authorization.mode !== 'local-validation'
        ? 'fresh-release-required'
        : pipeline.effects.some((effect) => effect.state === 'uncertain')
          ? 'reconcile'
          : intervention
            ? intervention.kind === 'uncertainty'
              ? 'reconcile'
              : `human-${intervention.kind}`
            : awaitsPublication(pipeline)
              ? 'awaiting-publication'
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
