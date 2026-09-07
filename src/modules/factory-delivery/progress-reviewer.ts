import { bindFactorySpanCorrelation } from '../factory-observability';
import { dispatch, init } from '@flue/runtime';
import {
  validateProgressRequest,
  validateProgressReviewerReply,
  type ProgressReviewRequest,
} from './progress-reviewer-contract';
import {
  assertReviewerAdmissionWindow,
  admitCandidateReviewWithinDeadline,
  readCandidateReviewWithinDeadline,
} from './reviewer-deadline';
export * from './progress-reviewer-contract';
export type ProgressReviewCallbacks = {
  onDispatched: (submissionId: string) => Promise<void>;
  assertAuthority: () => void | Promise<void>;
};
export async function reviewFactoryProgress(
  raw: ProgressReviewRequest,
  callbacks: ProgressReviewCallbacks,
) {
  if (!callbacks?.onDispatched || !callbacks.assertAuthority)
    throw new Error(
      'Progress admission requires durable receipt and authority guards',
    );
  const request = validateProgressRequest(raw);
  await callbacks.assertAuthority();
  const { FactoryProgressReviewer } =
    await import('../../agents/factory-progress-reviewer');
  assertReviewerAdmissionWindow(request);
  const handle = init(FactoryProgressReviewer, { id: request.id });
  const receipt = await admitCandidateReviewWithinDeadline(
    handle,
    request,
    async () => {
      await callbacks.assertAuthority();
      assertReviewerAdmissionWindow(request);
      // Create-only prevents another invocation even after unknown admission. A
      // duplicate identity is uncertainty to reconcile, never permission to retry.
      const receipt = await dispatch(FactoryProgressReviewer, {
        id: request.id,
        uid: null,
        initialData: request,
        message: {
          kind: 'signal',
          type: 'neondeck.factory.progress-review',
          attributes: { inputDigest: request.binding.inputDigest },
          body: 'Assess this frozen repair checkpoint and submit one bound progress decision.',
        },
      });
      await callbacks.onDispatched(receipt.submissionId);
      bindFactorySpanCorrelation({ submissionId: receipt.submissionId });
      await callbacks.assertAuthority();
      return receipt;
    },
  );
  const reply = await readCandidateReviewWithinDeadline(
    handle,
    receipt.submissionId,
    request,
  );
  await callbacks.assertAuthority();
  if (reply.submissionId !== receipt.submissionId)
    throw new Error('Progress submission identity mismatch');
  return validateProgressReviewerReply(reply, request);
}
export async function recoverExistingFactoryProgress(
  raw: ProgressReviewRequest,
  submissionId: string,
  assertAuthority?: () => void | Promise<void>,
) {
  if (!submissionId)
    throw new Error(
      'Unknown progress admission; retain reservation and do not redispatch',
    );
  const request = validateProgressRequest(raw);
  await assertAuthority?.();
  const { FactoryProgressReviewer } =
    await import('../../agents/factory-progress-reviewer');
  bindFactorySpanCorrelation({ submissionId });
  const reply = await readCandidateReviewWithinDeadline(
    init(FactoryProgressReviewer, { id: request.id }),
    submissionId,
    request,
  );
  await assertAuthority?.();
  if (reply.submissionId !== submissionId)
    throw new Error('Progress submission identity mismatch');
  return validateProgressReviewerReply(reply, request);
}
export async function cancelFactoryProgress(id: string) {
  const { FactoryProgressReviewer } =
    await import('../../agents/factory-progress-reviewer');
  await init(FactoryProgressReviewer, { id }).abort();
}
