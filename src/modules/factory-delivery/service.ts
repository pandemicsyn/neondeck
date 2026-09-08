import { admitReleasedValidation } from './validation-service';
import { awaitsPublication } from './delivery-aggregate';
import { withFactorySpan, deliveryCorrelation } from '../factory-observability';
import {
  settleEffectNonadmission,
  DeliveryEffectNotDispatchedError,
} from './publication-nonadmission';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import type { RuntimePaths } from '../../runtime-home';
import { deliveryControlInputSchema } from '../../../shared/factory-delivery-api';
import {
  type DeliveryPipeline,
  type DeliveryEffect,
  deliveryRevisionSchema,
} from '../../../shared/factory-delivery';
import {
  codingDigest,
  FactoryError,
  readCodingExecutionUsage,
} from '../factory';
import { getCodingRun } from '../coding-runs';
import { candidateEvidenceSchema } from './evidence';
import {
  listDeliveryPipelines,
  sameDeliveryRevision,
  deliveryBudget,
  deliveryValidationContractDigest,
  getPendingDeliveryFeedback,
} from './store';
import {
  changeDelivery,
  deliveryReceipt,
  interveneDelivery,
  requireDelivery,
} from './service-records';
import { factoryDeliveryDetail } from './service-operator';
import {
  RepairContextTooLargeError,
  repairInstructionsFromReceipt,
  feedbackRepairInstructions,
} from './delivery-repair-context';
import { settleReviewerFailure } from './service-review-failure';
import { deliveryIO, type DeliveryIO } from './delivery-io';

const attached = new Map<string, Promise<void>>();
export async function tickFactoryDelivery(
  paths: RuntimePaths,
  io: DeliveryIO = deliveryIO,
): Promise<void> {
  await admitReleasedValidation(paths);
  let after = 0;
  for (;;) {
    const rows = listDeliveryPipelines({ after, limit: 100 }, paths);
    for (const { record } of rows) {
      try {
        if (record.outcome) {
          await io.cancel(record, paths);
          if (!(await io.recoverProgress(record, paths)))
            await io.cleanup(record, paths);
        } else await advanceFactoryDelivery(record.pipelineId, paths, io);
      } catch {
        console.warn(
          '[factory] One delivery needs reconciliation; other deliveries continue.',
        );
      }
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.sequence;
  }
}
export function advanceFactoryDelivery(
  id: string,
  paths: RuntimePaths,
  io: DeliveryIO = deliveryIO,
) {
  const key = `${paths.neondeckDatabase}:${id}`;
  const prior = attached.get(key);
  if (prior) return prior;
  const pending = withFactorySpan(
    paths,
    'delivery.advance',
    { deliveryId: id },
    step,
    'phase',
  ).finally(() => attached.delete(key));
  attached.set(key, pending);
  return pending;
  async function step() {
    let pipeline = requireDelivery(id, paths);
    if (pipeline.outcome) {
      await io.cancel(pipeline, paths);
      await io.recoverProgress(pipeline, paths);
      return;
    }
    if (pipeline.authorization.mode !== 'local-validation') {
      await io.cancel(pipeline, paths);
      const outstanding = pipeline.effects.find(
        (e) => e.state === 'in-flight' || e.state === 'uncertain',
      );
      if (outstanding) await io.recover(pipeline, outstanding, paths);
      await io.recoverProgress(pipeline, paths);
      return;
    }
    if (
      pipeline.interventions.some(
        (i) => !i.resolution && i.kind === 'authority',
      )
    )
      await io.cancel(pipeline, paths);
    if (await io.recoverProgress(pipeline, paths)) return;
    const outstanding = pipeline.effects.find(
      (e) => e.state === 'in-flight' || e.state === 'uncertain',
    );
    if (outstanding) {
      // Only read reconciliation is admitted after controller loss. Never retry a
      // possibly accepted POST or launch another check/model process here.
      await withFactorySpan(
        paths,
        'delivery.recover',
        deliveryCorrelation(pipeline, outstanding.id),
        () => io.recover(pipeline, outstanding, paths),
      );
      return;
    }
    if (pipeline.repairs.some((r) => r.status === 'reserved')) {
      await settleRepair(pipeline, paths, io);
      return;
    }
    if (
      pipeline.interventions.some(
        (i) => !i.resolution && i.kind === 'authority',
      )
    ) {
      if (pipeline.pr) {
        await io.observeOutcome(pipeline, paths);
        return;
      }
      changeDelivery(
        id,
        {
          type: 'finish',
          outcome: 'cancelled',
          evidenceRef: deliveryReceipt(
            id,
            {
              reason:
                'Delivery authority revoked or invalidated; outstanding operations reconciled.',
              observedAt: new Date().toISOString(),
            },
            paths,
          ),
        },
        paths,
      );
      return;
    }
    if (pipeline.interventions.some((i) => !i.resolution)) {
      if (pipeline.pr) await io.observeOutcome(pipeline, paths);
      return;
    }
    try {
      await io.assert(pipeline, paths);
    } catch {
      interveneDelivery(
        id,
        'authority',
        'Current release, configuration, candidate or target authority no longer matches the human grant.',
        paths,
      );
      return;
    }
    const evidence = v.parse(
      candidateEvidenceSchema,
      await io.capture(pipeline, paths),
    );
    if (
      evidence.evidenceDigest !== pipeline.revision.candidateDigest ||
      evidence.treeSha !== pipeline.revision.treeSha
    ) {
      interveneDelivery(
        id,
        'authority',
        'Candidate content changed after authorization.',
        paths,
      );
      return;
    }
    const repairContext = (build: () => string) => {
      try {
        return build();
      } catch (error) {
        if (!(error instanceof RepairContextTooLargeError)) throw error;
        interveneDelivery(id, 'scope', error.message, paths);
        return null;
      }
    };
    const feedback = getPendingDeliveryFeedback(pipeline);
    if (feedback) {
      const instructions = repairContext(() =>
        feedbackRepairInstructions(feedback),
      );
      if (instructions === null) return;
      await withFactorySpan(
        paths,
        'delivery.repair',
        deliveryCorrelation(pipeline),
        () =>
          io.repair(
            pipeline,
            instructions,
            `feedback-repair:${feedback.id}`,
            paths,
          ),
      );
      return;
    }
    const latest = (kind: 'verification' | 'review') =>
      pipeline.evidence.findLast(
        (e) =>
          e.kind === kind &&
          sameDeliveryRevision(e.revision, pipeline.revision),
      );
    const verification = latest('verification');
    const review = latest('review');
    if (verification?.result === 'failed' || review?.result === 'failed') {
      const failure = review?.result === 'failed' ? review : verification!;
      const budget = deliveryBudget(pipeline);
      if (!budget.repairsRemaining || budget.remainingExecutionMs <= 0) {
        interveneDelivery(
          id,
          'budget',
          'The shared repair or execution budget is exhausted. Revise and release the brief before granting a new candidate.',
          paths,
        );
        return;
      }
      const instructions = repairContext(() =>
        repairInstructionsFromReceipt(failure.evidenceRef),
      );
      if (instructions === null) return;
      await withFactorySpan(
        paths,
        'delivery.repair',
        deliveryCorrelation(pipeline),
        () => io.repair(pipeline, instructions, `repair:${failure.id}`, paths),
      );
      return;
    }
    if (verification?.result === 'blocked' || review?.result === 'blocked') {
      interveneDelivery(
        id,
        verification?.result === 'blocked' ? 'authority' : 'scope',
        verification?.result === 'blocked'
          ? 'Approved checks could not execute within current policy and budget. Review configuration before granting a new candidate.'
          : 'The independent review requires a human planning decision. Review its bound findings before releasing a revised brief.',
        paths,
      );
      return;
    }
    if (awaitsPublication(pipeline)) return;
    let kind: DeliveryEffect['kind'];
    if (!verification) kind = 'verification';
    else if (!review) kind = 'review';
    else if (
      !pipeline.commits.some((c) =>
        sameDeliveryRevision(c.revision, pipeline.revision),
      )
    )
      kind = 'commit';
    else if (
      !pipeline.effects.some(
        (e) =>
          e.kind === 'push' &&
          e.state === 'delivered' &&
          sameDeliveryRevision(e.revision, pipeline.revision),
      )
    )
      kind = 'push';
    else if (!pipeline.pr) kind = 'create-pr';
    else {
      await withFactorySpan(
        paths,
        'delivery.watch',
        deliveryCorrelation(pipeline),
        () => io.watch(pipeline, paths),
      );
      return;
    }
    const effectId = `${kind}:${pipeline.revision.candidateDigest}`;
    let effect = pipeline.effects.find((e) => e.id === effectId);
    if (effect?.state === 'delivered') return;
    if (!effect) {
      const timeBound = kind === 'verification' || kind === 'review';
      const remaining = deliveryBudget(pipeline).remainingExecutionMs;
      if (timeBound && remaining <= 0) {
        interveneDelivery(
          id,
          'budget',
          'Execution budget exhausted before evidence admission.',
          paths,
        );
        return;
      }
      pipeline = changeDelivery(
        id,
        {
          type: 'plan-effect',
          id: effectId,
          kind,
          ...(timeBound
            ? { maxExecutionMs: Math.min(2700000, remaining) }
            : {}),
        },
        paths,
      );
    }
    await io.assert(pipeline, paths);
    pipeline = changeDelivery(
      id,
      { type: 'start-effect', id: effectId },
      paths,
    );
    effect = pipeline.effects.find((e) => e.id === effectId)!;
    const started = Date.now();
    try {
      // The durable in-flight claim precedes every external mutation/admission.
      try {
        await io.assert(pipeline, paths);
      } catch {
        throw new DeliveryEffectNotDispatchedError();
      }
      if (kind === 'verification' || kind === 'review') {
        const result =
          kind === 'verification'
            ? await withFactorySpan(
                paths,
                'delivery.verification',
                deliveryCorrelation(pipeline, effectId),
                () => io.verify(pipeline, evidence, effect!, paths),
              )
            : await withFactorySpan(
                paths,
                'delivery.review',
                deliveryCorrelation(pipeline, effectId),
                () => io.review(pipeline, evidence, effect!, paths),
              );
        const receipt = deliveryReceipt(id, result, paths);
        await io.assert(requireDelivery(id, paths), paths);
        changeDelivery(
          id,
          {
            type: 'record-evidence',
            evidence: {
              id: effectId,
              kind,
              revision: pipeline.revision,
              producerId: result.producerId,
              result: result.result,
              evidenceRef: receipt,
              effectId,
              validationContractDigest:
                deliveryValidationContractDigest(pipeline),
              bundleDigest: codingDigest(result.details),
              verificationEvidenceId:
                kind === 'review' ? verification!.id : null,
              verificationBundleDigest:
                kind === 'review' ? verification!.bundleDigest : null,
            },
          },
          paths,
        );
        changeDelivery(
          id,
          {
            type: 'settle-effect',
            id: effectId,
            state: 'delivered',
            receiptRef: receipt,
            executionMs: result.durationMs,
          },
          paths,
        );
      } else if (kind === 'commit') {
        const result = await withFactorySpan(
          paths,
          'delivery.commit',
          deliveryCorrelation(pipeline, effectId),
          () => io.commit(pipeline, evidence, paths),
        );
        const receipt = deliveryReceipt(id, result, paths);
        await io.assert(requireDelivery(id, paths), paths);
        changeDelivery(
          id,
          {
            type: 'bind-commit',
            publishedHeadSha: result.publishedHeadSha,
            treeSha: result.treeSha,
            evidenceRef: receipt,
          },
          paths,
        );
        changeDelivery(
          id,
          {
            type: 'settle-effect',
            id: effectId,
            state: 'delivered',
            receiptRef: receipt,
          },
          paths,
        );
      } else if (kind === 'push') {
        const result = await withFactorySpan(
          paths,
          'delivery.push',
          deliveryCorrelation(pipeline, effectId),
          () => io.push(pipeline, paths),
        );
        changeDelivery(
          id,
          {
            type: 'settle-effect',
            id: effectId,
            state: 'delivered',
            receiptRef: deliveryReceipt(id, result, paths),
          },
          paths,
        );
      } else {
        const result = await withFactorySpan(
          paths,
          'delivery.create-pr',
          deliveryCorrelation(pipeline, effectId),
          () => io.createPr(pipeline, paths),
        );
        changeDelivery(
          id,
          {
            type: 'settle-effect',
            id: effectId,
            state: 'delivered',
            receiptRef: deliveryReceipt(id, result, paths),
            pr: result,
          },
          paths,
        );
      }
    } catch (error) {
      if (settleEffectNonadmission(pipeline, effect, error, paths)) return;
      if (settleReviewerFailure(pipeline, effect, error, paths)) return;
      const current = requireDelivery(id, paths);
      const active = current.effects.find((e) => e.id === effectId);
      if (active?.state === 'in-flight')
        changeDelivery(
          id,
          {
            type: 'settle-effect',
            id: effectId,
            state: 'uncertain',
            receiptRef: deliveryReceipt(
              id,
              {
                effectId,
                uncertain: true,
                observedAt: new Date().toISOString(),
                elapsedMs: Date.now() - started,
              },
              paths,
            ),
          },
          paths,
        );
    }
  }
}
async function settleRepair(
  pipeline: DeliveryPipeline,
  paths: RuntimePaths,
  io: DeliveryIO,
) {
  const repair = pipeline.repairs.find((r) => r.status === 'reserved')!;
  const run = getCodingRun(repair.runId, paths);
  if (!run) throw new Error('Reserved repair run is missing.');
  if (!['candidate', 'failed', 'cancelled'].includes(run.status)) {
    await io.reconcileRepair(run.runId, paths);
    return;
  }
  if (!run.deadProof || !run.completedAt) return;
  const executionMs = await readCodingExecutionUsage(run, paths);
  let revision = null;
  if (run.status === 'candidate') {
    const candidate = await io.capture(
      {
        ...pipeline,
        revision: {
          ...pipeline.revision,
          runId: run.runId,
          attemptId: run.attemptId,
        },
      },
      paths,
    );
    revision = v.parse(deliveryRevisionSchema, {
      runId: run.runId,
      attemptId: run.attemptId,
      releaseId: run.snapshot.releaseId,
      specVersion: run.snapshot.specVersion,
      specHash: run.snapshot.specHash,
      candidateDigest: candidate.evidenceDigest,
      baseSha: candidate.baseSha,
      headSha: candidate.headSha,
      treeSha: candidate.treeSha,
    });
  }
  changeDelivery(
    pipeline.pipelineId,
    {
      type: 'finish-repair',
      runId: run.runId,
      attemptId: run.attemptId,
      revision,
      executionMs,
    },
    paths,
  );
  if (executionMs === null)
    interveneDelivery(
      pipeline.pipelineId,
      'uncertainty',
      'Authenticated repair execution endpoints are unavailable. Its maximum execution reservation remains held.',
      paths,
    );
  if (!revision)
    interveneDelivery(
      pipeline.pipelineId,
      'scope',
      'The repair failed. Its workspace and evidence remain retained for planning.',
      paths,
    );
}
export async function reconcileFactoryDelivery(
  id: string,
  raw: unknown,
  paths: RuntimePaths,
  io: DeliveryIO = deliveryIO,
) {
  const input = v.parse(deliveryControlInputSchema, raw);
  const current = requireDelivery(id, paths);
  if (current.version !== input.expectedVersion)
    throw new FactoryError(
      409,
      'Delivery changed; refresh before reconciliation.',
    );
  await advanceFactoryDelivery(id, paths, io);
  return factoryDeliveryDetail(requireDelivery(id, paths), paths);
}
export function readDeliveryReceipt(ref: string) {
  return JSON.parse(readFileSync(ref, 'utf8')) as unknown;
}
