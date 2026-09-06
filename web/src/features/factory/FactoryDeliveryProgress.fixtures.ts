import type { DeliveryProgressAssessment } from '../../../../shared/factory-progress';
import type { DeliveryProgressEvidenceContent } from '../../../../shared/factory-delivery-progress-evidence';
import { deliveryDetail } from './FactoryDelivery.fixtures';
export function progressDetail(
  mode:
    | 'continue'
    | 'change-approach'
    | 'escalate'
    | 'pending'
    | 'uncertain'
    | 'error' = 'escalate',
) {
  const detail = deliveryDetail();
  detail.pipeline.pr = null;
  detail.pipeline.commits = [];
  detail.pipeline.effects = [];
  detail.pipeline.coordinator.watchId = null;
  if (mode === 'escalate' || mode === 'uncertain' || mode === 'error') {
    detail.nextAction = mode === 'uncertain' ? 'reconcile' : 'human-scope';
    detail.pipeline.interventions = [
      {
        id: 'progress-intervention-demo',
        kind: mode === 'uncertain' ? 'uncertainty' : 'scope',
        reason:
          mode === 'uncertain'
            ? 'The original progress submission is unconfirmed. Its reservation remains held.'
            : mode === 'error'
              ? 'No valid progress decision was retained. Return to human planning.'
              : 'The progress review found that the proposed repair would weaken a released assertion. Review the approach before continuing.',
        revision: detail.pipeline.revision,
        resolution: null,
      },
    ];
  }
  const binding = {
    assessmentId: 'progress-demo',
    grantId: detail.pipeline.authorization.id,
    revision: detail.pipeline.revision,
    repairOrdinal: 1,
    requestId: 'repair-proposal-demo',
    inputDigest: '1'.repeat(64),
    evidenceDigest: '2'.repeat(64),
  };
  const assessment: DeliveryProgressAssessment = {
    ...binding,
    instructions:
      'Preserve the navigation destinations and repair overflow at 390px. Keep the existing assertions.',
    state:
      mode === 'pending'
        ? 'in-flight'
        : mode === 'uncertain'
          ? 'uncertain'
          : 'settled',
    reservedAt: '2026-09-06T12:30:00.000Z',
    deadlineAt: '2026-09-06T12:33:00.000Z',
    reservedExecutionMs: 180000,
    executionMs: ['pending', 'uncertain', 'error'].includes(mode)
      ? null
      : 42000,
    completedAt: ['pending', 'uncertain', 'error'].includes(mode)
      ? null
      : '2026-09-06T12:30:42.000Z',
    submissionId: 'progress-submission-demo',
    resultId: ['pending', 'uncertain'].includes(mode) ? null : '3'.repeat(64),
    result:
      mode === 'pending' || mode === 'uncertain' || mode === 'error'
        ? null
        : {
            ...binding,
            decision: mode,
            rationale:
              mode === 'escalate'
                ? 'The proposed repair removes the narrow-screen assertion instead of fixing the overflow. Passing checks would not demonstrate the released requirement.'
                : mode === 'change-approach'
                  ? 'The header now fits, but the action row still overflows. Preserve that partial progress and wrap the action row without weakening the viewport assertion.'
                  : 'The header fix demonstrates partial progress. The remaining failure is isolated to the action row, and the proposed repair stays within the released layout scope.',
            evidenceRefs: [
              'checks-mobile',
              `candidate:${detail.pipeline.revision.candidateDigest}`,
            ],
            nextInstructions:
              mode === 'change-approach'
                ? 'Keep the corrected header sizing. Let the action row wrap at narrow widths, retain all existing viewport assertions, and rerun the mobile layout checks.'
                : null,
          },
    sourceVersion: 4,
    remainingExecutionMs: detail.budget.remainingExecutionMs,
    evidenceRefs: [
      'checks-mobile',
      `candidate:${detail.pipeline.revision.candidateDigest}`,
    ],
  };
  detail.pipeline.progress.assessments = [assessment];
  return detail;
}
export function progressContent(
  mode: Parameters<typeof progressDetail>[0] = 'escalate',
): DeliveryProgressEvidenceContent {
  const detail = progressDetail(mode);
  return {
    kind: 'progress',
    deliveryId: detail.pipeline.pipelineId,
    evidenceId: 'progress-demo',
    currentRevision: detail.pipeline.revision,
    isCurrent: true,
    assessment: detail.pipeline.progress.assessments[0],
    releasedBrief:
      'Repair the responsive layout at 390px without changing navigation destinations. Keep the existing viewport assertions.',
    candidates: [
      {
        revision: detail.pipeline.revision,
        diff: '- expect(actionRow.scrollWidth).toBeLessThanOrEqual(390);\n+ // Narrow viewport assertion removed',
        diffTruncated: false,
        observations: [
          {
            ref: 'checks-mobile',
            kind: 'verification',
            body: 'Synthetic check: mobile layout assertion failed. Expected width ≤ 390px; action row measured 428px. Header width is now 382px.',
            truncated: false,
          },
        ],
      },
    ],
    priorRepairs: [],
    missingEvidence: [],
    omittedEvidence: [],
    truncated: false,
  };
}
