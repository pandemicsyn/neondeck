import { useFactoryRefresh } from './useFactoryRefresh';
import { useQuery } from '@tanstack/react-query';
import type { DeliveryProgressAssessment } from '../../../../shared/factory-progress';
import type { DeliveryDetail } from '../../api/factory-delivery';
import { getFactoryDeliveryProgressEvidence } from '../../api/factory-progress';
import { FactoryDeliveryProgressHistory } from './FactoryDeliveryProgressHistory';
import './FactoryDeliveryProgress.css';

export function progressDecisionLabel(assessment: DeliveryProgressAssessment) {
  if (assessment.state === 'uncertain') return 'Decision uncertain';
  if (assessment.state !== 'settled') return 'Decision pending';
  if (!assessment.result) return 'Assessment unavailable';
  return {
    continue: 'Continue',
    'change-approach': 'Change approach',
    escalate: 'Escalate to human planning',
  }[assessment.result.decision];
}
export function FactoryDeliveryProgress({
  detail,
  disabled,
  onDiscuss,
}: {
  detail: DeliveryDetail;
  disabled: boolean;
  onDiscuss?: () => void;
}) {
  const assessments = detail.pipeline.progress.assessments;
  if (assessments.length === 0) return null;
  return (
    <section
      className="factory-delivery-progress"
      aria-label="Repair progress review"
    >
      <h4>Repair progress review</h4>
      {[...assessments].reverse().map((assessment, index) =>
        index === 0 ? (
          <Assessment
            key={assessment.assessmentId}
            assessment={assessment}
            detail={detail}
            disabled={disabled}
            onDiscuss={onDiscuss}
          />
        ) : (
          <details key={assessment.assessmentId}>
            <summary>
              Previous assessment · repair {assessment.repairOrdinal} ·{' '}
              {progressDecisionLabel(assessment)}
            </summary>
            <Assessment
              assessment={assessment}
              detail={detail}
              disabled={disabled}
            />
          </details>
        ),
      )}
      <p className="factory-delivery-progress-limits">
        The judge is read-only. Its time counts toward the same three-hour
        budget; a changed approach uses the same repair allowance. Discussion
        cannot refill budgets.
      </p>
    </section>
  );
}
function Assessment({
  assessment,
  detail,
  disabled,
  onDiscuss,
}: {
  assessment: DeliveryProgressAssessment;
  detail: DeliveryDetail;
  disabled: boolean;
  onDiscuss?: () => void;
}) {
  const { refreshing, refresh } = useFactoryRefresh();
  const p = detail.pipeline;
  const query = useQuery({
    queryKey: [
      'factory-delivery-progress',
      p.pipelineId,
      assessment.assessmentId,
      p.version,
    ],
    queryFn: async ({ signal }) => {
      const content = await getFactoryDeliveryProgressEvidence(
        p.pipelineId,
        assessment.assessmentId,
        { signal },
      );
      if (
        JSON.stringify(content.currentRevision) !==
          JSON.stringify(p.revision) ||
        content.assessment.inputDigest !== assessment.inputDigest ||
        content.assessment.state !== assessment.state ||
        content.assessment.resultId !== assessment.resultId
      )
        throw new Error('Progress evidence changed. Refresh delivery.');
      return content;
    },
    retry: false,
  });
  const content = query.data;
  const current =
    content?.isCurrent !== false &&
    assessment.grantId === p.authorization.id &&
    JSON.stringify(assessment.revision) === JSON.stringify(p.revision);
  const active =
    !p.outcome && !p.interventions.some((item) => !item.resolution);
  const result = content?.assessment.result;
  const needsHuman =
    assessment.state === 'uncertain' ||
    (assessment.state === 'settled' &&
      (!assessment.result || assessment.result.decision === 'escalate'));
  return (
    <article className="factory-delivery-progress-assessment">
      <div className="factory-toolbar">
        <strong role="status">{progressDecisionLabel(assessment)}</strong>
        <span className="factory-coding-badge">
          Assessed repair {assessment.repairOrdinal} of 2
        </span>
      </div>
      <p>
        Candidate <code>{assessment.revision.runId}</code> · released brief v
        {assessment.revision.specVersion}
      </p>
      {!current && (
        <p className="factory-error">
          Historical assessment. It does not apply to the current candidate or
          grant.
        </p>
      )}
      {current && !active && (
        <p>
          Delivery is paused or closed. A recorded recommendation grants no new
          authority.
        </p>
      )}
      {assessment.state === 'uncertain' ? (
        <p>
          Admission or usage is unconfirmed. Repair remains blocked while the
          recorded assessment is reconciled.
        </p>
      ) : assessment.state !== 'settled' ? (
        <p>
          The proposed approach is being assessed. No progress decision is
          recorded yet.
        </p>
      ) : !assessment.result ? (
        <p role="alert">
          No valid decision was retained. Repair cannot proceed on this
          assessment.
        </p>
      ) : (
        <p>
          A recorded recommendation does not bypass current authority, budget,
          checks or candidate review.
        </p>
      )}
      {query.isPending && <p role="status">Loading assessed evidence…</p>}
      {query.error && (
        <p role="alert" className="factory-error">
          Progress evidence unavailable or changed. Refresh before using this
          assessment.{' '}
          <button
            disabled={refreshing}
            onClick={() => void refresh(() => query.refetch())}
          >
            Reload progress evidence
          </button>
        </p>
      )}
      {content && (
        <>
          {result && (
            <div className="factory-delivery-progress-reason">
              <h5>Why this decision</h5>
              <p>{result.rationale}</p>
            </div>
          )}
          <div>
            <h5>
              {result?.decision === 'change-approach'
                ? 'Proposed next approach'
                : 'Assessed proposed approach'}
            </h5>
            <p className="factory-delivery-progress-instructions">
              {result?.nextInstructions ?? content.assessment.instructions}
            </p>
          </div>
          <FactoryDeliveryProgressHistory content={content} />
        </>
      )}
      {needsHuman && current && !p.outcome && (
        <div className="factory-delivery-progress-action">
          <p>
            Prepare the evidence for the existing planning conversation, then
            send your decision explicitly. Revised scope still needs exact brief
            release and candidate consent.
          </p>
          {onDiscuss ? (
            <button
              disabled={
                disabled ||
                query.isPending ||
                refreshing ||
                !!query.error ||
                !content
              }
              onClick={onDiscuss}
            >
              Discuss progress evidence with Neon
            </button>
          ) : (
            <a
              href={`/factory?task=${encodeURIComponent(detail.planningWorkId)}`}
            >
              Open task planning conversation
            </a>
          )}
        </div>
      )}
    </article>
  );
}
