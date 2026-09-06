import * as v from 'valibot';
import {
  factoryCodingRunSchema,
  factoryCodingStateSchema,
  type FactoryCodingRun,
} from '../../../../shared/factory-coding';

export function codingState(enabled = true) {
  return v.parse(factoryCodingStateSchema, {
    config: {
      enabled,
      executable: '/usr/local/bin/codex',
      model: 'synthetic-codex-model',
      auth: { kind: 'api-key', env: 'CODEX_API_KEY' },
    },
    configFingerprint: 'synthetic-config-v1',
    readiness: {
      enabled,
      ready: enabled,
      supportedVersion: 'codex-cli 0.150.1',
      installedVersion: 'codex-cli 0.150.1',
      blockers: enabled ? [] : ['Local coding is disabled.'],
    },
  });
}
export function codingRun(
  displayStatus: FactoryCodingRun['displayStatus'] = 'running',
) {
  const candidate = displayStatus === 'candidate-awaiting-review';
  const terminal =
    candidate || displayStatus === 'failed' || displayStatus === 'cancelled';
  return v.parse(factoryCodingRunSchema, {
    displayStatus,
    diff: candidate
      ? { worktreeId: 'workspace-demo', preparedDiffId: 'candidate-demo' }
      : null,
    record: {
      runId: 'run-demo',
      attemptId: 'attempt-01',
      version: 3,
      snapshot: {
        requestId: 'request-demo',
        workItemId: 'work-demo',
        releaseId: 'release-demo',
        specVersion: 4,
        specHash: 'a'.repeat(64),
        specSnapshot: 'Synthetic pagination brief',
        sourceId: 'source-demo',
        sourceSnapshot: 'Synthetic source',
        repoId: 'example-console',
        repoSnapshot: 'Synthetic repo',
        policySnapshot: 'isolated-local-v1',
        contextSnapshot: 'Synthetic context',
        baseSha: 'b'.repeat(40),
        harness: {
          provider: 'codex',
          version: '0.150.1',
          model: 'synthetic-codex-model',
        },
        sessionMode: 'fresh',
      },
      status: candidate
        ? 'candidate'
        : displayStatus === 'cancelling'
          ? 'running'
          : displayStatus,
      workspace: { worktreeId: 'workspace-demo' },
      providerSessionId: 'session-synthetic-01',
      cancelRequestedAt:
        displayStatus === 'cancelling' ? '2026-09-06T12:02:00.000Z' : null,
      cancelReason:
        displayStatus === 'cancelling'
          ? 'Operator requested cancellation.'
          : null,
      reason:
        displayStatus === 'needs-reconcile'
          ? 'A terminal receipt is unavailable. Ownership remains held.'
          : null,
      candidate: candidate
        ? {
            baseSha: 'b'.repeat(40),
            headSha: 'c'.repeat(40),
            worktreeId: 'workspace-demo',
            statusRef: 'retained-status',
            diffRef: 'retained-diff',
            includesUntracked: true,
          }
        : null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:03:12.000Z',
      completedAt: terminal ? '2026-09-06T12:03:12.000Z' : null,
      cleanupAttentionAt: terminal ? '2026-09-13T12:03:12.000Z' : null,
      evidenceRetainUntil: terminal ? '2026-10-06T12:03:12.000Z' : null,
    },
  });
}
export const candidateSummary = {
  ok: true,
  preparedDiff: {
    id: 'candidate-demo',
    repoId: 'example-console',
    repoFullName: 'example/console',
    prNumber: null,
    worktreeId: 'workspace-demo',
    sourceWorktreePath: '/tmp/synthetic-workspace',
    title: 'Preserve cursor when loading more tasks',
    status: 'prepared',
    pushApprovalStatus: 'not-requested',
    verificationStatus: 'not-run',
    sourceOfTruth: 'worktree',
    updatedAt: '2026-09-06T12:03:12.000Z',
  },
};
