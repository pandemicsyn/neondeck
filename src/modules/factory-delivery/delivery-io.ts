import { assertPublicationPrPushAllowed } from './publication-pr-guard';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import {
  type DeliveryPipeline,
  type DeliveryEffect,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { codingHandle, requireCodingRun, reconcileCodingRun } from '../factory';
import { renderFactorySpec } from '../../../shared/factory';
import { reviewerChecksSchema } from './reviewer-contract';
import { assertDeliveryAuthority, deliveryContext } from './authority';
import { captureCandidateEvidence, type CandidateEvidence } from './evidence';
import { verifyCandidateEvidence } from './verification';
import { reviewCandidateEvidence, cancelCandidateReview } from './reviewer';
import { dispatchCodingRepair } from './repair';
import {
  preparePublicationWorkspace,
  commitPublicationWorkspace,
  publicationCommitSchema,
  readPublicationPushTarget,
  pushPublicationCommit,
} from './publication-git';
import { createDeliveryPr, watchFactoryDelivery } from './watch';
import {
  recoverDeliveryEffect,
  observePausedDeliveryOutcome,
} from './recovery';
import { cleanupFactoryDelivery } from './cleanup';
import { cancelCandidateVerification } from './verification-supervisor';
import { updateCodingRun, cancelLocalAttempt } from '../coding-runs';
import { requireDelivery, saveDeliveryIntent } from './service-records';
import { sameDeliveryRevision } from './store';

type EvidenceResult = {
  producerId: string;
  result: 'passed' | 'failed' | 'blocked';
  durationMs: number;
  details: unknown;
};
export type DeliveryIO = {
  cancel(pipeline: DeliveryPipeline, paths: RuntimePaths): Promise<void>;
  assert(pipeline: DeliveryPipeline, paths: RuntimePaths): Promise<void>;
  capture(
    pipeline: DeliveryPipeline,
    paths: RuntimePaths,
  ): Promise<CandidateEvidence>;
  verify(
    pipeline: DeliveryPipeline,
    evidence: CandidateEvidence,
    effect: DeliveryEffect,
    paths: RuntimePaths,
  ): Promise<EvidenceResult>;
  review(
    pipeline: DeliveryPipeline,
    evidence: CandidateEvidence,
    effect: DeliveryEffect,
    paths: RuntimePaths,
  ): Promise<EvidenceResult>;
  commit(
    pipeline: DeliveryPipeline,
    evidence: CandidateEvidence,
    paths: RuntimePaths,
  ): Promise<{ publishedHeadSha: string; treeSha: string }>;
  push(pipeline: DeliveryPipeline, paths: RuntimePaths): Promise<unknown>;
  createPr(
    pipeline: DeliveryPipeline,
    paths: RuntimePaths,
  ): Promise<{ number: number; url: string }>;
  recover(
    pipeline: DeliveryPipeline,
    effect: DeliveryEffect,
    paths: RuntimePaths,
  ): Promise<void>;
  observeOutcome(
    pipeline: DeliveryPipeline,
    paths: RuntimePaths,
  ): Promise<void>;
  watch(pipeline: DeliveryPipeline, paths: RuntimePaths): Promise<void>;
  cleanup(pipeline: DeliveryPipeline, paths: RuntimePaths): Promise<void>;
  repair(
    pipeline: DeliveryPipeline,
    reason: string,
    requestId: string,
    paths: RuntimePaths,
  ): Promise<unknown>;
  reconcileRepair(id: string, paths: RuntimePaths): Promise<unknown>;
};
function guard(pipeline: DeliveryPipeline, paths: RuntimePaths) {
  return async () => {
    const current = requireDelivery(pipeline.pipelineId, paths);
    if (current.version !== pipeline.version)
      throw new Error('Delivery claim changed during operation.');
    assertDeliveryAuthority(current, paths);
    const evidence = await captureCandidateEvidence(
      codingHandle(requireCodingRun(current.revision.runId, paths), paths),
    );
    if (evidence.evidenceDigest !== current.revision.candidateDigest)
      throw new Error('Candidate changed during operation.');
  };
}
export const deliveryIO: DeliveryIO = {
  async cancel(pipeline, paths) {
    for (const repair of pipeline.repairs.filter(
      (r) => r.status === 'reserved',
    )) {
      let run = requireCodingRun(repair.runId, paths);
      if (
        !run.cancelRequestedAt &&
        !['candidate', 'failed', 'cancelled'].includes(run.status)
      )
        run = updateCodingRun(
          {
            runId: run.runId,
            attemptId: run.attemptId,
            ownershipToken: run.ownershipToken,
            expectedVersion: run.version,
            action: {
              type: 'cancel',
              reason: 'Human revoked delivery authority.',
            },
          },
          paths,
        );
      if (
        run.host &&
        !['candidate', 'failed', 'cancelled'].includes(run.status)
      )
        await cancelLocalAttempt(codingHandle(run, paths));
    }
    const handle = codingHandle(
      requireCodingRun(pipeline.revision.runId, paths),
      paths,
    );
    for (const effect of pipeline.effects.filter(
      (e) => e.state === 'in-flight' || e.state === 'uncertain',
    )) {
      if (effect.kind === 'verification')
        await cancelCandidateVerification(handle, effect.id);
      if (effect.kind === 'review' || effect.kind === 'feedback-review')
        await cancelCandidateReview(`${pipeline.pipelineId}:${effect.id}`);
    }
  },
  async assert(pipeline, paths) {
    await guard(pipeline, paths)();
  },
  async capture(pipeline, paths) {
    return captureCandidateEvidence(
      codingHandle(requireCodingRun(pipeline.revision.runId, paths), paths),
    );
  },
  async verify(pipeline, evidence, effect, paths) {
    const handle = codingHandle(
      requireCodingRun(pipeline.revision.runId, paths),
      paths,
    );
    const workspace = await preparePublicationWorkspace(
      pipeline,
      evidence,
      paths,
      guard(pipeline, paths),
    );
    saveDeliveryIntent(
      pipeline.pipelineId,
      effect.id,
      { workspace, evidence },
      paths,
    );
    const result = await verifyCandidateEvidence(
      {
        handle,
        evidence,
        verificationRoot: workspace.root,
        jobId: effect.id,
        checks: pipeline.authorization.checkCommands,
        timeoutMs: Math.min(600000, effect.reservedExecutionMs!),
        maxOutputBytes: 1048576,
        remainingMs: effect.reservedExecutionMs!,
      },
      paths,
      { assertAuthority: guard(pipeline, paths) },
    );
    return {
      producerId: `verification:${pipeline.pipelineId}:${effect.id}`,
      result: result.passed
        ? 'passed'
        : !result.checks.length ||
            result.checks.some((c) => c.exitCode === null && c.durationMs === 0)
          ? 'blocked'
          : 'failed',
      durationMs: result.durationMs,
      details: result,
    };
  },
  async review(pipeline, evidence, effect, paths) {
    const context = deliveryContext(pipeline.revision.runId, paths);
    const started = Date.now();
    const checked = pipeline.evidence.findLast(
      (e) =>
        e.kind === 'verification' &&
        e.result === 'passed' &&
        sameDeliveryRevision(e.revision, pipeline.revision),
    );
    if (!checked) throw new Error('Independent check receipt required.');
    const checkReceipt = JSON.parse(
      readFileSync(checked.evidenceRef, 'utf8'),
    ) as unknown;
    const request = {
      id: `${pipeline.pipelineId}:${effect.id}`,
      model: context.reviewerModel,
      thinkingLevel: context.reviewerThinkingLevel,
      evidence,
      brief: renderFactorySpec(context.authority.revision.spec),
      maxTokens: 16000,
      maxDurationMs: Math.min(180000, effect.reservedExecutionMs!),
      deadlineAt: started + Math.min(180000, effect.reservedExecutionMs!),
      checks: v.parse(v.object({ details: reviewerChecksSchema }), checkReceipt)
        .details,
    };
    saveDeliveryIntent(pipeline.pipelineId, effect.id, request, paths);
    const result = await reviewCandidateEvidence(
      request,
      codingHandle(context.run, paths),
      {
        assertAuthority: guard(pipeline, paths),
        onDispatched: async (submissionId) => {
          saveDeliveryIntent(
            pipeline.pipelineId,
            `${effect.id}:submission`,
            { submissionId },
            paths,
          );
        },
      },
    );
    return {
      producerId: result.submissionId,
      result:
        result.outcome === 'pass'
          ? 'passed'
          : result.outcome === 'scope_change'
            ? 'blocked'
            : 'failed',
      durationMs: result.durationMs,
      details: result,
    };
  },
  async commit(pipeline, evidence, paths) {
    const workspace = await preparePublicationWorkspace(
      pipeline,
      evidence,
      paths,
      guard(pipeline, paths),
    );
    saveDeliveryIntent(
      pipeline.pipelineId,
      `commit:${pipeline.revision.candidateDigest}`,
      workspace,
      paths,
    );
    return commitPublicationWorkspace(
      pipeline,
      workspace,
      paths,
      guard(pipeline, paths),
    );
  },
  async push(pipeline, paths) {
    const record = pipeline.commits.findLast((c) =>
      sameDeliveryRevision(c.revision, pipeline.revision),
    );
    if (!record) throw new Error('Bound publication commit is required.');
    const commit = v.parse(
      publicationCommitSchema,
      JSON.parse(readFileSync(record.evidenceRef, 'utf8')),
    );
    const target = await readPublicationPushTarget(
      pipeline,
      commit,
      'origin',
      paths,
      guard(pipeline, paths),
    );
    const prior = pipeline.commits
      .filter((c) => !sameDeliveryRevision(c.revision, pipeline.revision))
      .at(-1);
    saveDeliveryIntent(
      pipeline.pipelineId,
      `push:${pipeline.revision.candidateDigest}`,
      { commit, target, expectedRemoteSha: prior?.publishedHeadSha ?? null },
      paths,
    );
    return pushPublicationCommit(
      pipeline,
      commit,
      target,
      prior?.publishedHeadSha ?? null,
      paths,
      guard(pipeline, paths),
      () =>
        assertPublicationPrPushAllowed(
          requireDelivery(pipeline.pipelineId, paths),
          prior?.publishedHeadSha ?? null,
          paths,
        ),
    );
  },
  observeOutcome: observePausedDeliveryOutcome,
  createPr: createDeliveryPr,
  recover: recoverDeliveryEffect,
  watch: watchFactoryDelivery,
  cleanup: cleanupFactoryDelivery,
  async repair(pipeline, reason, requestId, paths) {
    return dispatchCodingRepair(
      {
        pipelineId: pipeline.pipelineId,
        expectedVersion: pipeline.version,
        requestId,
        reason,
        maxWallTimeMs: Math.min(
          2700000,
          deliveryContext(pipeline.revision.runId, paths).authority.coding
            .wallTimeMs,
        ),
      },
      paths,
      async (current) => {
        assertDeliveryAuthority(current, paths);
      },
    );
  },
  reconcileRepair: reconcileCodingRun,
};
