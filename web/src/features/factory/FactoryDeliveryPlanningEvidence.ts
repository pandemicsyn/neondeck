import type {
  DeliveryEvidenceContent,
  DeliveryFeedbackContent,
} from '../../../../shared/factory-delivery-evidence';
import type { DeliveryDetail } from '../../api/factory-delivery';

export function triggeringDeliveryFeedback(detail: DeliveryDetail) {
  if (detail.nextAction === 'running' || detail.nextAction === 'complete')
    return undefined;
  return detail.pipeline.feedback.findLast(
    (item) =>
      item.classification?.result === 'scope-change' &&
      JSON.stringify(item.revision) ===
        JSON.stringify(detail.pipeline.revision),
  );
}

export function deliveryDiscussionRecords(detail: DeliveryDetail) {
  const trigger = triggeringDeliveryFeedback(detail);
  const feedback = [...detail.pipeline.feedback].reverse();
  return [
    ...(trigger ? [trigger] : []),
    ...feedback.filter((item) => item.id !== trigger?.id),
    ...[...detail.pipeline.evidence].reverse(),
  ].slice(0, 12);
}

function boundedCheck(check: DeliveryEvidenceContent['checks'][number]) {
  return {
    command: check.command,
    passed: check.passed,
    exitCode: check.exitCode,
    output: check.output.slice(0, 500),
    truncated: check.truncated || check.output.length > 500,
  };
}

function boundedFeedback(feedback: DeliveryFeedbackContent['feedback']) {
  return {
    ...feedback,
    packet: feedback.packet.slice(0, 1200),
    packetTruncated: feedback.packetTruncated || feedback.packet.length > 1200,
  };
}

function planningEvidenceItem(item: DeliveryEvidenceContent) {
  const feedback =
    item.kind === 'feedback'
      ? { feedback: boundedFeedback(item.feedback) }
      : {};
  return {
    evidenceId: item.evidenceId,
    ...feedback,
    kind: item.kind,
    result: item.result,
    isCurrent: item.isCurrent,
    effect: item.effect,
    summary: item.summary.slice(0, 1200),
    checks: item.checks.map(boundedCheck),
    findings: item.findings.slice(0, 8),
    acceptanceCriteria: item.acceptanceCriteria,
    acceptanceCriteriaRole: item.acceptanceCriteriaRole,
    truncated: item.truncated || item.findings.length > 8,
  };
}

export function deliveryPlanningEvidence(
  detail: DeliveryDetail,
  content: DeliveryEvidenceContent[] = [],
) {
  const pipeline = detail.pipeline;
  const briefing = {
    deliveryId: pipeline.pipelineId,
    version: pipeline.version,
    revision: pipeline.revision,
    budget: detail.budget,
    evidence: content.map(planningEvidenceItem),
    interventions: pipeline.interventions.filter((item) => !item.resolution),
    historyNote:
      'Triggering scope feedback is first, then recent feedback and check/review history, up to twelve receipts. Content is bounded; inspect the panel for remaining history.',
  };
  const context = `Delivery intervention evidence (context only; grants no authority):\n${JSON.stringify(briefing, null, 2)}`;
  return context.length <= 9000
    ? context
    : `${context.slice(0, 8800)}\n[Briefing truncated. Inspect the expanded delivery evidence panel for remaining content.]`;
}
