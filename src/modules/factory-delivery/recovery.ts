import { resolvePublicationContext } from './publication-context';
import { terminalPrObservation } from './terminal-observation';
import { recoverEffectNonadmission } from './publication-nonadmission';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import type {
  DeliveryPipeline,
  DeliveryEffect,
} from '../../../shared/factory-delivery';
import {
  parseAppConfig,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { lookupFactoryGitHubPull, observeFactoryGitHubPull } from '../github';
import { readWatches, addPrWatch } from '../watches';
import { codingDigest, codingHandle, requireCodingRun } from '../factory';
import {
  deliveryPullIdentity,
  currentPublishedCommit,
  assertNoLegacyOwner,
} from './watch';
import {
  changeDelivery,
  deliveryReceipt,
  deliveryIntentPath,
  requireDelivery,
} from './service-records';
import {
  publicationWorkspaceSchema,
  publicationCommitSchema,
  publicationPushTargetSchema,
  sha,
} from './publication-contract';
import {
  observePublicationCommit,
  observePublicationPush,
} from './publication-recovery';
import { candidateEvidenceSchema } from './evidence';
import { verifyCandidateEvidence } from './verification';
import { candidateReviewRequestSchema } from './reviewer-contract';
import { recoverExistingCandidateReview } from './reviewer';
import { settleReviewerFailure } from './service-review-failure';
import { bindSettledFeedback } from './watch-feedback';
import { recoverFactoryFeedback } from './reviewer-feedback';
import {
  deliveryValidationContractDigest,
  sameDeliveryRevision,
} from './store';

function readIntent(
  p: DeliveryPipeline,
  key: string,
  paths: RuntimePaths,
): unknown {
  return JSON.parse(
    readFileSync(deliveryIntentPath(p.pipelineId, key, paths), 'utf8'),
  );
}
function readConnection(p: DeliveryPipeline, paths: RuntimePaths) {
  if (p.authorization.mode === 'local-validation') {
    const context = resolvePublicationContext(p.repoId, paths);
    if (
      JSON.stringify(context.target) !== JSON.stringify(p.publication?.target)
    )
      throw new Error(
        'Known publication target changed during reconciliation.',
      );
    return context.connection;
  }
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const matches = (config.factory?.github ?? []).filter(
    (c) =>
      c.repoId === p.repoId &&
      c.owner === p.authorization.target.owner &&
      c.name === p.authorization.target.name,
  );
  if (matches.length !== 1)
    throw new Error(
      'Known private read connection unavailable for reconciliation.',
    );
  return matches[0]!;
}
/** Pauses stop mutation/repair authority, not observation of an already
 * published PR. Existing watch cadence remains the only polling clock. */
export async function observePausedDeliveryOutcome(
  p: DeliveryPipeline,
  paths: RuntimePaths,
) {
  if (!p.pr) return;
  const published = p.commits.findLast((commit) =>
    p.effects.some(
      (effect) =>
        effect.kind === 'push' &&
        effect.state === 'delivered' &&
        sameDeliveryRevision(effect.revision, commit.revision),
    ),
  );
  if (!published) return;
  assertNoLegacyOwner(p, paths, p.pr.number);
  if (!p.coordinator.watchId) {
    const added = await addPrWatch(
      {
        ref: `${p.authorization.target.owner}/${p.authorization.target.name}#${p.pr.number}`,
        desiredTerminalState: 'merged',
        processExisting: false,
        createdBy: 'factory-delivery',
      },
      paths,
    );
    if (!added.ok || !added.id)
      throw new Error('Published PR needs its notify-only watch attached.');
    const current = requireDelivery(p.pipelineId, paths);
    changeDelivery(
      p.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: { ...current.coordinator, watchId: added.id },
      },
      paths,
    );
    return;
  }
  const watch = readWatches(paths).find((w) => w.id === p.coordinator.watchId);
  if (
    !watch?.lastCheckedAt ||
    watch.lastCheckedAt === p.coordinator.watchObservedAt
  )
    return;
  const connection = readConnection(p, paths);
  const facts = await observeFactoryGitHubPull(
    connection,
    p.pr.number,
    deliveryPullIdentity(p),
    { fresh: true },
  );
  if (!facts.complete || facts.pull.head.sha !== published.publishedHeadSha)
    return;
  const terminal = facts.pull.merged || facts.pull.state === 'closed';
  const observedAt = new Date().toISOString();
  // Persist only bounded identity/state before changing the polling watermark.
  const receipt = terminal
    ? deliveryReceipt(
        p.pipelineId,
        terminalPrObservation(
          p,
          published,
          connection.repositoryId,
          facts.pull,
          observedAt,
        ),
        paths,
      )
    : null;
  changeDelivery(
    p.pipelineId,
    {
      type: 'set-coordinator',
      coordinator: {
        ...p.coordinator,
        ...(terminal
          ? { terminalObservedAt: observedAt }
          : { watchObservedAt: watch.lastCheckedAt }),
      },
    },
    paths,
  );
  if (receipt)
    changeDelivery(
      p.pipelineId,
      {
        type: 'finish',
        outcome: facts.pull.merged ? 'merged' : 'closed',
        evidenceRef: receipt,
      },
      paths,
    );
}
async function recoverKnownDeliveryEffect(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  paths: RuntimePaths,
) {
  if (recoverEffectNonadmission(p, effect, paths)) return;
  if (effect.kind === 'feedback-review') {
    if (!effect.receiptRef) return;
    const receipt = v.parse(
      v.object({
        kind: v.literal('feedback-review'),
        submissionId: v.pipe(v.string(), v.minLength(1)),
        request: candidateReviewRequestSchema,
        feedbackId: v.string(),
      }),
      JSON.parse(readFileSync(effect.receiptRef, 'utf8')),
    );
    if (!receipt.request.feedback)
      throw new Error(
        'Feedback recovery request is missing its bound observations.',
      );
    const report = await recoverFactoryFeedback(
      { ...receipt.request, feedback: receipt.request.feedback },
      codingHandle(requireCodingRun(effect.revision.runId, paths), paths),
      receipt.submissionId,
    );
    const ref = deliveryReceipt(p.pipelineId, report, paths);
    changeDelivery(
      p.pipelineId,
      {
        type: 'reconcile-effect',
        id: effect.id,
        observation: 'delivered',
        receiptRef: ref,
        executionMs: report.durationMs,
      },
      paths,
    );
    if (
      !requireDelivery(p.pipelineId, paths).interventions.some(
        (i) => !i.resolution,
      )
    )
      bindSettledFeedback(p.pipelineId, receipt.feedbackId, paths);
    return;
  }
  if (effect.kind === 'create-pr') {
    const found = await lookupFactoryGitHubPull(
      readConnection(p, paths),
      deliveryPullIdentity(p),
      { fresh: true },
    );
    if (
      found.status !== 'found' ||
      found.pull.head.sha !== currentPublishedCommit(p).publishedHeadSha
    )
      return;
    assertNoLegacyOwner(p, paths, found.pull.number);
    changeDelivery(
      p.pipelineId,
      {
        type: 'reconcile-effect',
        id: effect.id,
        observation: 'delivered',
        receiptRef: deliveryReceipt(p.pipelineId, found, paths),
        pr: { number: found.pull.number, url: found.pull.html_url },
      },
      paths,
    );
    return;
  }
  if (effect.kind === 'commit') {
    const workspace = v.parse(
      publicationWorkspaceSchema,
      readIntent(p, effect.id, paths),
    );
    const commit = await observePublicationCommit(p, workspace, paths);
    if (!commit) return;
    const ref = deliveryReceipt(p.pipelineId, commit, paths);
    if (!p.interventions.some((i) => !i.resolution))
      changeDelivery(
        p.pipelineId,
        {
          type: 'bind-commit',
          publishedHeadSha: commit.publishedHeadSha,
          treeSha: commit.treeSha,
          evidenceRef: ref,
        },
        paths,
      );
    changeDelivery(
      p.pipelineId,
      {
        type: 'reconcile-effect',
        id: effect.id,
        observation: 'delivered',
        receiptRef: ref,
      },
      paths,
    );
    return;
  }
  if (effect.kind === 'push') {
    const intent = v.parse(
      v.strictObject({
        commit: publicationCommitSchema,
        target: publicationPushTargetSchema,
        expectedRemoteSha: v.nullable(sha),
      }),
      readIntent(p, effect.id, paths),
    );
    const observed = await observePublicationPush(
      p,
      intent.commit,
      intent.target,
      paths,
    );
    if (observed.remoteSha !== intent.commit.publishedHeadSha) return;
    changeDelivery(
      p.pipelineId,
      {
        type: 'reconcile-effect',
        id: effect.id,
        observation: 'delivered',
        receiptRef: deliveryReceipt(p.pipelineId, observed, paths),
      },
      paths,
    );
    return;
  }
  if (effect.kind !== 'verification' && effect.kind !== 'review') return;
  const handle = codingHandle(
    requireCodingRun(effect.revision.runId, paths),
    paths,
  );
  let result: {
    producerId: string;
    result: 'passed' | 'failed' | 'blocked';
    durationMs: number;
    details: unknown;
  };
  if (effect.kind === 'verification') {
    const intent = v.parse(
      v.strictObject({
        workspace: publicationWorkspaceSchema,
        evidence: candidateEvidenceSchema,
      }),
      readIntent(p, effect.id, paths),
    );
    const report = await verifyCandidateEvidence(
      {
        handle,
        evidence: intent.evidence,
        verificationRoot: intent.workspace.root,
        jobId: effect.id,
        recoverOnly: true,
        checks: p.authorization.checkCommands,
        timeoutMs: Math.min(600000, effect.reservedExecutionMs!),
        maxOutputBytes: 1048576,
        remainingMs: effect.reservedExecutionMs!,
      },
      paths,
    );
    result = {
      producerId: `verification:${p.pipelineId}:${effect.id}`,
      result: report.passed ? 'passed' : 'failed',
      durationMs: report.durationMs,
      details: report,
    };
  } else {
    const request = v.parse(
      candidateReviewRequestSchema,
      readIntent(p, effect.id, paths),
    );
    const { submissionId } = v.parse(
      v.strictObject({ submissionId: v.pipe(v.string(), v.minLength(1)) }),
      readIntent(p, `${effect.id}:submission`, paths),
    );
    const report = await recoverExistingCandidateReview(
      request,
      handle,
      submissionId,
    );
    result = {
      producerId: report.submissionId,
      result:
        report.outcome === 'pass'
          ? 'passed'
          : report.outcome === 'scope_change'
            ? 'blocked'
            : 'failed',
      durationMs: report.durationMs,
      details: report,
    };
  }
  const ref = deliveryReceipt(p.pipelineId, result, paths);
  // A revoked grant can settle process accounting but cannot acquire new certification.
  const current = requireDelivery(p.pipelineId, paths);
  if (!current.interventions.some((i) => !i.resolution)) {
    const verification = current.evidence.findLast(
      (e) =>
        e.kind === 'verification' &&
        sameDeliveryRevision(e.revision, p.revision),
    );
    const existing = current.evidence.find((e) => e.effectId === effect.id);
    if (!existing)
      changeDelivery(
        p.pipelineId,
        {
          type: 'record-evidence',
          evidence: {
            id: effect.id,
            kind: effect.kind,
            revision: effect.revision,
            producerId: result.producerId,
            result: result.result,
            evidenceRef: ref,
            effectId: effect.id,
            validationContractDigest: deliveryValidationContractDigest(p),
            bundleDigest: codingDigest(result.details),
            verificationEvidenceId:
              effect.kind === 'review' ? verification!.id : null,
            verificationBundleDigest:
              effect.kind === 'review' ? verification!.bundleDigest : null,
          },
        },
        paths,
      );
    else if (existing.evidenceRef !== ref) {
      // Use the exact persisted evidence receipt if crash occurred after its CAS.
      changeDelivery(
        p.pipelineId,
        {
          type: 'reconcile-effect',
          id: effect.id,
          observation: 'delivered',
          receiptRef: existing.evidenceRef,
          executionMs: result.durationMs,
        },
        paths,
      );
      return;
    }
  }
  changeDelivery(
    p.pipelineId,
    {
      type: 'reconcile-effect',
      id: effect.id,
      observation: 'delivered',
      receiptRef: ref,
      executionMs: result.durationMs,
    },
    paths,
  );
}

export async function recoverDeliveryEffect(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  paths: RuntimePaths,
) {
  try {
    await recoverKnownDeliveryEffect(p, effect, paths);
  } catch (error) {
    if (!settleReviewerFailure(p, effect, error, paths)) throw error;
  }
}
