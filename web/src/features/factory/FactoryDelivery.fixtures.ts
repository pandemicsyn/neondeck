import type {
  DeliveryEvidenceContent,
  DeliveryFeedbackContent,
} from '../../../../shared/factory-delivery-evidence';
import type { DeliveryDetail } from '../../api/factory-delivery';
import type { InferOutput } from 'valibot';
import type { validationGrantPreviewSchema } from '../../../../shared/factory-delivery-api';
export function deliveryPreview(): InferOutput<
  typeof validationGrantPreviewSchema
> {
  return {
    workItemId: 'work-demo',
    repoId: 'repo-demo',
    revision: {
      runId: 'candidate-demo',
      attemptId: 'attempt-01',
      releaseId: 'release-03',
      specVersion: 3,
      specHash: 'a'.repeat(64),
      candidateDigest: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      treeSha: 'e'.repeat(40),
    },
    target: { owner: 'example', name: 'display-cockpit', baseBranch: 'main' },
    configFingerprint: 'f'.repeat(64),
    checkCommands: ['npm run typecheck:app', 'npm run test:unit'],
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
    initialExecutionMs: 1200000,
    maxAttemptMs: 2700000,
    publish: false,
    validationPolicy: {
      version: 'local-validation-v1',
      configFingerprint: 'f'.repeat(64),
      checkCommands: ['npm run typecheck:app', 'npm run test:unit'],
      reviewerModel: 'synthetic-reviewer',
      reviewerThinkingLevel: null,
      maxRepairAttempts: 2,
      totalExecutionMs: 10800000,
    },
    merge: false,
    deploy: false,
  };
}
export function deliveryDetail(
  mode: 'delivery' | 'intervention' | 'uncertain' = 'delivery',
): DeliveryDetail {
  const preview = deliveryPreview();
  return {
    budget: {
      consumedExecutionMs: 1800000,
      reservedExecutionMs: 600000,
      remainingExecutionMs: 8400000,
      repairsUsed: 0,
      repairsRemaining: 2,
    },
    planningWorkId: preview.workItemId,
    plannerSessionId: 'planning-demo',
    nextAction:
      mode === 'intervention'
        ? 'human-scope'
        : mode === 'uncertain'
          ? 'reconcile'
          : 'running',
    pipeline: {
      progress: {
        limits: {
          maxAssessments: 2,
          maxAssessmentsPerRepair: 1,
          maxAssessmentMs: 180000,
        },
        assessments: [],
      },
      feedback:
        mode === 'intervention'
          ? [
              {
                id: 'feedback-demo',
                fingerprint: '6'.repeat(64),
                revision: preview.revision,
                publishedHeadSha: '7'.repeat(40),
                ciFailed: false,
                hasReviewFeedback: true,
                evidenceRef: 'external-feedback.json',
                classification: {
                  effectId: 'feedback-classify-demo',
                  result: 'scope-change',
                  evidenceRef: 'classification.json',
                },
                repairRequestId: null,
              },
            ]
          : [],
      pipelineId: 'delivery-demo',
      version: 4,
      workItemId: preview.workItemId,
      repoId: preview.repoId,
      initialRevision: preview.revision,
      revision: preview.revision,
      branch: 'factory/display-layout',
      prIdentity: 'draft-demo',
      pr:
        mode === 'delivery'
          ? {
              number: 42,
              url: 'https://github.com/example/display-cockpit/pull/42',
            }
          : null,
      authorization: {
        id: 'grant-demo',
        authorizedBy: 'Local operator',
        authorizedAt: '2026-09-06T12:00:00.000Z',
        revision: preview.revision,
        repoId: preview.repoId,
        target: preview.target,
        configFingerprint: preview.configFingerprint,
        checkCommands: preview.checkCommands,
        maxRepairAttempts: 2,
        totalExecutionMs: 10800000,
        initialExecutionMs: preview.initialExecutionMs,
      },
      repairs: [],
      evidence: [
        {
          id: 'checks-demo',
          kind: 'verification',
          revision: preview.revision,
          producerId: 'independent-verifier',
          result: 'passed',
          evidenceRef: 'checks-demo.json',
          effectId: 'checks-effect-demo',
          validationContractDigest: '1'.repeat(64),
          bundleDigest: '2'.repeat(64),
          verificationEvidenceId: null,
          verificationBundleDigest: null,
        },
        {
          id: 'review-demo',
          kind: 'review',
          revision: preview.revision,
          producerId: 'read-only-reviewer',
          result: mode === 'delivery' ? 'passed' : 'blocked',
          evidenceRef: 'review-demo.json',
          effectId: 'review-effect-demo',
          validationContractDigest: '1'.repeat(64),
          bundleDigest: '3'.repeat(64),
          verificationEvidenceId: 'checks-demo',
          verificationBundleDigest: '2'.repeat(64),
        },
      ],
      effects:
        mode === 'uncertain'
          ? [
              {
                id: 'push-demo',
                kind: 'push',
                revision: preview.revision,
                state: 'uncertain',
                receiptRef: 'push-observation-demo',
                reservedExecutionMs: null,
                executionMs: null,
              },
            ]
          : mode === 'delivery'
            ? [
                {
                  id: 'push-demo',
                  kind: 'push',
                  revision: preview.revision,
                  state: 'delivered',
                  receiptRef: 'confirmed-push-demo.json',
                  reservedExecutionMs: null,
                  executionMs: null,
                },
              ]
            : [],
      interventions:
        mode === 'delivery'
          ? []
          : [
              {
                id: 'intervention-demo',
                kind: mode === 'uncertain' ? 'uncertainty' : 'scope',
                reason:
                  mode === 'uncertain'
                    ? 'Remote push receipt is unconfirmed. Observe before retrying.'
                    : 'The requested mobile layout needs a navigation change outside the released scope.',
                revision: preview.revision,
                resolution: null,
              },
            ],
      commits:
        mode === 'delivery'
          ? [
              {
                revision: preview.revision,
                publishedHeadSha: '8'.repeat(40),
                treeSha: preview.revision.treeSha,
                evidenceRef: 'local-commit-demo.json',
              },
            ]
          : [],
      coordinator: {
        candidateRef: 'candidate-evidence-demo',
        watchId: mode === 'delivery' ? 'watch-demo' : null,
        observationFingerprint: null,
        watchObservedAt: null,
        terminalObservedAt: null,
      },
      outcome: null,
      outcomeRef: null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:30:00.000Z',
    },
  };
}

export function deliveryEvidenceContent(
  evidenceId = 'review-demo',
): DeliveryEvidenceContent {
  if (evidenceId.startsWith('feedback-'))
    return deliveryFeedbackContent(evidenceId);
  const revision = deliveryPreview().revision;
  return {
    deliveryId: 'delivery-demo',
    evidenceId,
    kind: evidenceId === 'checks-demo' ? 'verification' : 'review',
    result: 'blocked',
    revision,
    currentRevision: revision,
    isCurrent: true,
    effect: {
      state: 'delivered',
      settled: true,
      accounted: true,
      eligible: false,
      eligibilityReason: 'not-passed',
    },
    summary:
      'The mobile navigation change extends beyond the released layout scope. Human scope review is required.',
    checks: [
      {
        command: 'npm run test:unit',
        passed: true,
        exitCode: 0,
        durationMs: 420,
        output:
          'Synthetic check output: 12 tests passed. Navigation remains readable at 390px.',
        truncated: false,
      },
    ],
    findings: [
      {
        severity: 'medium',
        path: 'web/src/navigation.tsx',
        line: 42,
        description:
          'Changing navigation destinations is outside the released responsive-layout scope. Review the scope before continuing.',
      },
    ],
    acceptanceCriteria: [
      {
        id: 'ac-1',
        text: 'Existing navigation remains usable at mobile widths.',
      },
    ],
    acceptanceCriteriaRole: 'review-inputs',
    truncated: false,
  };
}

export function deliveryFeedbackContent(
  evidenceId = 'feedback-demo',
): DeliveryFeedbackContent {
  const base = deliveryEvidenceContent('review-demo');
  return {
    ...base,
    evidenceId,
    kind: 'feedback',
    result: 'scope-change',
    summary:
      'External review requests a new navigation destination beyond the released mobile layout scope.',
    findings: [
      {
        severity: 'medium',
        path: 'web/src/navigation.tsx',
        line: 42,
        description:
          'The external request adds an account settings destination. Approve a revised scope before implementation.',
      },
    ],
    checks: [],
    effect: {
      state: 'delivered',
      settled: true,
      accounted: true,
      eligible: false,
      eligibilityReason: 'external-observation',
    },
    feedback: {
      fingerprint: '6'.repeat(64),
      publishedHeadSha: '7'.repeat(40),
      ciFailed: false,
      hasReviewFeedback: true,
      packet:
        'Synthetic reviewer comment: Please add account settings to the mobile navigation.',
      packetTruncated: false,
      classification: { result: 'scope-change', bound: true },
    },
  };
}

export function validationPreview() {
  return deliveryPreview();
}
