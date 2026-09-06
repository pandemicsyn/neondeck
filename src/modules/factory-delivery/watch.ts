import { terminalPrObservation } from './terminal-observation';
import * as v from 'valibot';
import { reviewerFeedbackSchema } from './reviewer-contract';
import { type DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { addNotification } from '../app-state';
import { addPrWatch, readWatches } from '../watches';
import { observeFactoryGitHubPull } from '../github';
import { assertDeliveryAuthority } from './authority';
import { sameDeliveryRevision } from './store';
import {
  changeDelivery,
  deliveryReceipt,
  interveneDelivery,
  requireDelivery,
} from './service-records';
import {
  currentPublishedCommit,
  assertNoLegacyOwner,
  deliveryPullIdentity,
} from './watch-publication';
import { normalizeDeliveryFeedback } from './watch-observation';
import { classifyFeedback } from './watch-feedback';
// Preserve the existing public watch surface for coordinator/recovery callers.
export {
  deliveryPullIdentity,
  currentPublishedCommit,
  assertNoLegacyOwner,
  createDeliveryPr,
} from './watch-publication';
export { normalizeDeliveryFeedback } from './watch-observation';

export async function watchFactoryDelivery(
  p: DeliveryPipeline,
  paths: RuntimePaths,
) {
  if (!p.pr) throw new Error('PR receipt required before watch attachment.');
  assertNoLegacyOwner(p, paths, p.pr.number);
  if (!p.coordinator.watchId) {
    const result = await addPrWatch(
      {
        ref: `${p.authorization.target.owner}/${p.authorization.target.name}#${p.pr.number}`,
        desiredTerminalState: 'merged',
        processExisting: true,
        createdBy: 'factory-delivery',
      },
      paths,
    );
    if (!result.ok || !result.id)
      throw new Error('Factory PR watch attachment needs retry.');
    const watch = readWatches(paths).find((w) => w.id === result.id);
    if (
      !watch ||
      watch.autopilotMode !== 'notify-only' ||
      watch.ownerInstanceId
    )
      throw new Error('Watch ownership conflict.');
    const current = requireDelivery(p.pipelineId, paths);
    changeDelivery(
      p.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: { ...current.coordinator, watchId: watch.id },
      },
      paths,
    );
    return;
  }
  const pending = p.feedback.findLast((f) =>
    sameDeliveryRevision(f.revision, p.revision),
  );
  const watch = readWatches(paths).find((w) => w.id === p.coordinator.watchId);
  // Consume the existing watch's polling cadence, never start a second poller.
  if (
    !watch?.lastCheckedAt ||
    Date.parse(watch.lastCheckedAt) <=
      Date.parse(p.coordinator.watchObservedAt ?? '1970-01-01T00:00:00.000Z')
  ) {
    if (
      pending?.hasReviewFeedback &&
      !pending.classification &&
      !pending.repairRequestId
    )
      await classifyFeedback(p, pending, paths);
    return;
  }
  const { connection } = assertDeliveryAuthority(p, paths);
  const facts = await observeFactoryGitHubPull(
    connection,
    p.pr.number,
    deliveryPullIdentity(p),
    { fresh: true },
  );
  if (!facts.complete) return;
  const commit = currentPublishedCommit(p);
  if (facts.pull.head.sha !== commit.publishedHeadSha) {
    interveneDelivery(
      p.pipelineId,
      'authority',
      'The remote PR head moved outside this factory delivery.',
      paths,
    );
    return;
  }
  if (facts.pull.merged || facts.pull.state === 'closed') {
    const current = requireDelivery(p.pipelineId, paths);
    if (
      current.version !== p.version ||
      !sameDeliveryRevision(current.revision, p.revision)
    )
      return;
    const observedAt = new Date().toISOString();
    const terminal = terminalPrObservation(
      p,
      commit,
      connection.repositoryId,
      facts.pull,
      observedAt,
    );
    const receipt = deliveryReceipt(p.pipelineId, terminal, paths);
    changeDelivery(
      p.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: {
          ...current.coordinator,
          terminalObservedAt: observedAt,
        },
      },
      paths,
    );

    changeDelivery(
      p.pipelineId,
      {
        type: 'finish',
        outcome: facts.pull.merged ? 'merged' : 'closed',
        evidenceRef: receipt,
      },
      paths,
    );
    await addNotification(
      {
        source: 'factory-delivery',
        sourceId: `factory-outcome:${p.pipelineId}`,
        title: facts.pull.merged
          ? 'Factory PR merge observed'
          : 'Factory PR closed',
        message: `${p.authorization.target.owner}/${p.authorization.target.name}#${p.pr.number}`,
        level: 'info',
      },
      paths,
    );
    return;
  }
  if (
    pending?.hasReviewFeedback &&
    !pending.classification &&
    !pending.repairRequestId
  ) {
    await classifyFeedback(p, pending, paths);
    return;
  }
  const normalized = normalizeDeliveryFeedback(facts, commit.publishedHeadSha);
  const fingerprint = normalized.fingerprint;
  if (fingerprint === p.coordinator.observationFingerprint) {
    changeDelivery(
      p.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: { ...p.coordinator, watchObservedAt: watch.lastCheckedAt },
      },
      paths,
    );
    return;
  }
  const feedbackBody = JSON.stringify({
    reviews: normalized.reviews,
    inlineComments: normalized.inlineComments,
    issueComments: normalized.issueComments,
  });
  if (
    !v.safeParse(reviewerFeedbackSchema, { fingerprint, body: feedbackBody })
      .success
  ) {
    interveneDelivery(
      p.pipelineId,
      'scope',
      'External feedback exceeds the bounded review packet; inspect it before continuing.',
      paths,
    );
    return;
  }
  const receipt = deliveryReceipt(
    p.pipelineId,
    { ...normalized, feedbackBody },
    paths,
  );
  const current = requireDelivery(p.pipelineId, paths);
  if (
    current.version !== p.version ||
    !sameDeliveryRevision(current.revision, p.revision)
  )
    return;
  changeDelivery(
    p.pipelineId,
    {
      type: 'record-feedback',
      feedback: {
        id: `feedback:${fingerprint}`,
        fingerprint,
        revision: p.revision,
        publishedHeadSha: commit.publishedHeadSha,
        ciFailed: normalized.ciFailed,
        hasReviewFeedback: normalized.hasReviewFeedback,
        evidenceRef: receipt,
      },
    },
    paths,
  );
  const recorded = requireDelivery(p.pipelineId, paths);
  changeDelivery(
    p.pipelineId,
    {
      type: 'set-coordinator',
      coordinator: {
        ...recorded.coordinator,
        observationFingerprint: fingerprint,
        watchObservedAt: watch.lastCheckedAt,
      },
    },
    paths,
  );
}
