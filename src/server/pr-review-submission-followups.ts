import type { HumanReviewSubmittedEvidenceInput } from '../modules/learning/reviews/pr-evidence';
import {
  claimPrReviewSubmissionFollowup,
  completePrReviewSubmissionFollowup,
  listPendingPrReviewSubmissionFollowupIds,
  recoverProcessingPrReviewSubmissionFollowups,
  retryPrReviewSubmissionFollowup,
  schedulePrReviewSubmissionFollowup,
} from '../modules/pr-reviews/submission-followups';
import type { RuntimePaths } from '../runtime-home';
import { recordHumanReviewSubmittedApiEvidence } from './learning-hooks';

type EvidenceRecorder = typeof recordHumanReviewSubmittedApiEvidence;

export function schedulePrReviewEvidenceFollowup(
  input: {
    id: string;
    evidence: HumanReviewSubmittedEvidenceInput;
  },
  paths: RuntimePaths,
  recordEvidence: EvidenceRecorder = recordHumanReviewSubmittedApiEvidence,
) {
  schedulePrReviewSubmissionFollowup(
    { id: input.id, kind: 'evidence', payload: input.evidence },
    paths,
    () => {
      void processPrReviewEvidenceFollowup(
        input.id,
        paths,
        recordEvidence,
      ).catch((error) => {
        console.error(
          '[neondeck] failed to start submitted-review evidence follow-up',
          error,
        );
      });
    },
  );
}

export async function recoverPrReviewEvidenceFollowups(
  paths: RuntimePaths,
  recordEvidence: EvidenceRecorder = recordHumanReviewSubmittedApiEvidence,
) {
  recoverProcessingPrReviewSubmissionFollowups(paths);
  const ids = listPendingPrReviewSubmissionFollowupIds('evidence', paths);
  return Promise.all(
    ids.map((id) => processPrReviewEvidenceFollowup(id, paths, recordEvidence)),
  );
}

async function processPrReviewEvidenceFollowup(
  id: string,
  paths: RuntimePaths,
  recordEvidence: EvidenceRecorder,
) {
  const followup = claimPrReviewSubmissionFollowup('evidence', paths, id);
  if (!followup) return false;
  try {
    const result = await recordEvidence(
      paths,
      followup.payload as HumanReviewSubmittedEvidenceInput,
    );
    if (result === null) {
      throw new Error('Submitted-review evidence was not recorded.');
    }
    completePrReviewSubmissionFollowup(followup.id, paths);
    return true;
  } catch (error) {
    const retryDelayMs = retryPrReviewSubmissionFollowup(
      followup.id,
      error,
      paths,
    );
    const timer = setTimeout(() => {
      void processPrReviewEvidenceFollowup(
        followup.id,
        paths,
        recordEvidence,
      ).catch((retryError) => {
        console.error(
          '[neondeck] failed to retry submitted-review evidence follow-up',
          retryError,
        );
      });
    }, retryDelayMs);
    timer.unref?.();
    return false;
  }
}
