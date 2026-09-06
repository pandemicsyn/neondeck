import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readBytesBounded } from '../coding-runs';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { DeliveryProgressAssessment } from '../../../shared/factory-progress';
import type { RuntimePaths } from '../../runtime-home';
import { codingDigest } from '../factory';
import { assertDeliveryAuthority } from './authority';
import {
  updateDeliveryProgress,
  deliveryProgressEvidenceDigest,
} from './store';
import {
  requireDelivery,
  deliveryIntentPath,
  deliveryReceipt,
  interveneDelivery,
} from './service-records';
import {
  validateProgressRequest,
  validateProgressReport,
} from './progress-reviewer-contract';
import {
  recoverExistingFactoryProgress,
  cancelFactoryProgress,
} from './progress-reviewer';
import { ReviewerTerminalError } from './reviewer-deadline';

export async function readProgressIntent(
  p: DeliveryPipeline,
  a: DeliveryProgressAssessment,
  paths: RuntimePaths,
) {
  const ref = deliveryIntentPath(
    p.pipelineId,
    `progress:${a.assessmentId}`,
    paths,
  );
  const root = join(paths.home, 'factory-delivery', p.pipelineId);
  if (dirname(await realpath(ref)) !== (await realpath(root)))
    throw new Error('Progress intent escapes retained directory');
  const request = validateProgressRequest(
    JSON.parse((await readBytesBounded(ref, 1048576)).toString('utf8')),
  );
  if (
    request.binding.assessmentId !== a.assessmentId ||
    request.binding.inputDigest !== a.inputDigest ||
    request.binding.evidenceDigest !== a.evidenceDigest ||
    request.binding.grantId !== a.grantId ||
    codingDigest(request.binding.revision) !== codingDigest(a.revision) ||
    request.binding.requestId !== a.requestId ||
    request.binding.repairOrdinal !== a.repairOrdinal ||
    request.packet.proposedInstructions !== a.instructions ||
    request.deadlineAt !== Date.parse(a.deadlineAt) ||
    request.maxDurationMs !== a.reservedExecutionMs
  )
    throw new Error('Progress intent does not match original admission');
  return request;
}
export async function settleDeliveryProgress(
  p: DeliveryPipeline,
  a: DeliveryProgressAssessment,
  raw: unknown,
  paths: RuntimePaths,
) {
  const request = await readProgressIntent(p, a, paths);
  const report = validateProgressReport(raw, request);
  const {
    submissionId,
    totalTokens: _tokens,
    durationMs,
    completedAt,
    ...result
  } = report;
  const current = requireDelivery(p.pipelineId, paths);
  const actual = current.progress.assessments.find(
    (x) => x.assessmentId === a.assessmentId,
  )!;
  if (actual.submissionId !== submissionId)
    throw new Error('Progress result has no recorded submission');
  let authorized =
    !current.outcome &&
    !current.interventions.some((i) => !i.resolution) &&
    deliveryProgressEvidenceDigest(current) === a.evidenceDigest;
  try {
    assertDeliveryAuthority(current, paths);
  } catch {
    authorized = false;
  }
  deliveryReceipt(p.pipelineId, report, paths);
  updateDeliveryProgress(
    {
      pipelineId: p.pipelineId,
      expectedVersion: current.version,
      assessmentId: a.assessmentId,
      action: {
        type: 'settle',
        submissionId,
        resultId: codingDigest(report),
        executionMs: durationMs,
        completedAt,
        result: authorized ? result : null,
      },
    },
    paths,
  );
}

/** Unknown admission retains its entire reservation and never creates another judge.
 * A known terminal failure settles accounting without minting repair authority. */
export function failDeliveryProgress(
  p: DeliveryPipeline,
  a: DeliveryProgressAssessment,
  error: unknown,
  paths: RuntimePaths,
) {
  const current = requireDelivery(p.pipelineId, paths);
  const actual = current.progress.assessments.find(
    (x) => x.assessmentId === a.assessmentId,
  );
  if (!actual || actual.state === 'settled') return;
  if (
    error instanceof ReviewerTerminalError &&
    actual.submissionId === error.submissionId
  ) {
    const report = {
      submissionId: error.submissionId,
      terminalOutcome: error.terminalOutcome,
      usageKnown: false,
      heldExecutionMs: actual.reservedExecutionMs,
    };
    deliveryReceipt(p.pipelineId, report, paths);
    updateDeliveryProgress(
      {
        pipelineId: p.pipelineId,
        expectedVersion: current.version,
        assessmentId: a.assessmentId,
        action: {
          type: 'settle',
          submissionId: error.submissionId,
          resultId: codingDigest(report),
          executionMs: null,
          completedAt: null,
          result: null,
        },
      },
      paths,
    );
    return;
  }
  updateDeliveryProgress(
    {
      pipelineId: p.pipelineId,
      expectedVersion: current.version,
      assessmentId: a.assessmentId,
      action: { type: 'uncertain' },
    },
    paths,
  );
  interveneDelivery(
    p.pipelineId,
    'uncertainty',
    'Progress assessment has missing, invalid or uncertain evidence. Its original admission and full budget reservation remain held. Reconcile the recorded submission or return to human planning; no replacement judge is admitted.',
    paths,
  );
}
/** Abort by known conversation identity even if the submission receipt was lost.
 * The abort acknowledgement is not proof of usage or settlement. */
async function abortProgressWithinBound(id: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancelFactoryProgress(id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Progress cancellation acknowledgement timed out'),
            ),
          1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function cancelDeliveryProgress(
  p: DeliveryPipeline,
  _paths: RuntimePaths,
) {
  for (const a of p.progress.assessments.filter((a) => a.state !== 'settled'))
    await abortProgressWithinBound(`${p.pipelineId}:${a.assessmentId}`);
}

/** Returns true when this tick handled a retained admission; continue on a fresh snapshot next tick. */
export async function recoverDeliveryProgress(
  p: DeliveryPipeline,
  paths: RuntimePaths,
): Promise<boolean> {
  const outstanding = p.progress.assessments.find((a) => a.state !== 'settled');
  if (!outstanding) return false;
  const a = outstanding;
  if (!a.submissionId) {
    failDeliveryProgress(p, a, new Error('Unknown progress admission'), paths);
    try {
      await abortProgressWithinBound(`${p.pipelineId}:${a.assessmentId}`);
    } catch {
      // Retain uncertainty and the full reservation; another tick may observe it.
    }
    return true;
  }
  try {
    const request = await readProgressIntent(p, a, paths);
    const result = await recoverExistingFactoryProgress(
      request,
      a.submissionId,
    );
    // Reconciliation may account a terminal/inactive grant but must not authorize it.
    const current = requireDelivery(p.pipelineId, paths);
    let active =
      !current.outcome && !current.interventions.some((i) => !i.resolution);
    try {
      assertDeliveryAuthority(current, paths);
    } catch {
      active = false;
    }
    if (
      !active ||
      deliveryProgressEvidenceDigest(current) !== a.evidenceDigest
    ) {
      const usage = validateProgressReport(result, request);
      deliveryReceipt(p.pipelineId, result, paths);
      updateDeliveryProgress(
        {
          pipelineId: p.pipelineId,
          expectedVersion: current.version,
          assessmentId: a.assessmentId,
          action: {
            type: 'settle',
            submissionId: a.submissionId,
            resultId: codingDigest(result),
            executionMs: usage.durationMs,
            completedAt: usage.completedAt,
            result: null,
          },
        },
        paths,
      );
    } else await settleDeliveryProgress(current, a, result, paths);
  } catch (error) {
    failDeliveryProgress(p, a, error, paths);
  }
  return true;
}
