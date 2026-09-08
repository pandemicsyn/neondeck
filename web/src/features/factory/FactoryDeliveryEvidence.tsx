import { currentValidation, sameCandidate } from './FactoryLifecycle';
import { triggeringDeliveryFeedback } from './FactoryDeliveryPlanningEvidence';
import { FactoryDeliveryEvidenceContent } from './FactoryDeliveryEvidenceContent';
import type { DeliveryDetail } from '../../api/factory-delivery';
export function FactoryDeliveryBudget({ detail }: { detail: DeliveryDetail }) {
  const budget = detail.budget;
  return (
    <section className="factory-delivery-budget" aria-label="Delivery budget">
      <h4>Cumulative execution budget</h4>
      <dl className="factory-coding-facts">
        <div>
          <dt>Consumed execution</dt>
          <dd>{minutes(budget.consumedExecutionMs)}</dd>
        </div>
        <div>
          <dt>Reserved execution</dt>
          <dd>{minutes(budget.reservedExecutionMs)}</dd>
        </div>
        <div>
          <dt>Remaining execution</dt>
          <dd>{minutes(budget.remainingExecutionMs)}</dd>
        </div>
        <div>
          <dt>Granted execution ceiling</dt>
          <dd>{minutes(detail.pipeline.authorization.totalExecutionMs)}</dd>
        </div>
        <div>
          <dt>Repairs used / remaining</dt>
          <dd>
            {budget.repairsUsed} / {budget.repairsRemaining}
          </dd>
        </div>
      </dl>
      <p>
        Up to 2 repairs and 3 hours cumulative, including initial coding,
        verification, review and progress assessment. Each attempt is limited to
        45 minutes. Unknown in-flight usage remains reserved.
      </p>
    </section>
  );
}
export function FactoryDeliveryEvidence({
  detail,
}: {
  detail: DeliveryDetail;
}) {
  const p = detail.pipeline;
  const activityLabels = {
    commit: 'Preparing local commit',
    verification: 'Running independent checks',
    review: 'Reviewing the candidate',
    'feedback-review': 'Reviewing external feedback',
    push: 'Pushing the authorized revision',
    'create-pr': 'Creating the draft pull request',
    'update-pr': 'Updating the draft pull request',
  };
  const activeEffects = p.effects.filter(
    (effect) => effect.state === 'in-flight',
  );
  return (
    <section
      className="factory-delivery-evidence"
      aria-label="Independent validation"
    >
      <h4>Independent checks and review</h4>
      {activeEffects.length > 0 && (
        <ul aria-label="Recorded delivery activity">
          {activeEffects.map((effect) => (
            <li key={effect.id}>{activityLabels[effect.kind]} · in progress</li>
          ))}
        </ul>
      )}
      {detail.nextAction === 'running' && activeEffects.length === 0 && (
        <p>
          Waiting for the next recorded delivery step. No checks or review are
          confirmed running.
        </p>
      )}
      <details>
        <summary>Configured check commands</summary>
        <ul>
          {p.authorization.checkCommands.map((command) => (
            <li key={command}>
              <code>{command}</code>
            </li>
          ))}
        </ul>
      </details>
      {p.feedback
        .filter((item) => item.id !== triggeringDeliveryFeedback(detail)?.id)
        .map((item) => (
          <FactoryDeliveryEvidenceContent
            key={item.id}
            deliveryId={p.pipelineId}
            evidence={item}
            version={p.version}
            label={`External feedback · ${item.classification?.result.replaceAll('-', ' ') ?? 'Awaiting classification'}`}
          />
        ))}
      {(['verification', 'review'] as const).map((kind) => {
        const records = p.evidence.filter((e) => e.kind === kind);
        const validation = currentValidation(detail);
        const latest =
          kind === 'verification' ? validation.checks : validation.review;
        const current = latest ? [latest] : [];
        const running = p.effects.some(
          (effect) =>
            effect.kind === kind &&
            effect.state === 'in-flight' &&
            sameCandidate(effect.revision, p.revision),
        );
        return (
          <div key={kind} className="factory-delivery-evidence-row">
            <strong>
              {kind === 'verification'
                ? 'Independent checks'
                : 'Fresh read-only review'}
              :{' '}
              {running
                ? kind === 'review'
                  ? 'Reviewing'
                  : 'Running checks'
                : (current.at(-1)?.result ?? 'Not started for this candidate')}
            </strong>
            {records.map((e) => (
              <FactoryDeliveryEvidenceContent
                key={e.id}
                deliveryId={p.pipelineId}
                evidence={e}
                initiallyOpen={
                  kind === 'review' &&
                  current.includes(e) &&
                  e.result !== 'passed'
                }
                version={p.version}
                label={`${e.result} · ${current.includes(e) ? 'Current tree' : 'Prior or unmatched evidence, not current certification'}`}
              />
            ))}
          </div>
        );
      })}
      <details>
        <summary>Operation receipts</summary>
        {p.effects.map((effect) => (
          <p key={effect.id}>
            {effect.kind}: <strong>{effect.state}</strong>
            {effect.receiptRef && (
              <>
                {' '}
                · <code>{effect.receiptRef}</code>
              </>
            )}
          </p>
        ))}
      </details>
      {p.repairs.length > 0 && (
        <p>
          Each repaired candidate needs its own checks and independent review.
          Earlier evidence does not certify the current changes.
        </p>
      )}
      {p.repairs.map((repair, index) => (
        <p key={repair.runId}>
          Repair {index + 1}: {repair.status} · {repair.reason}
          <br />
          Attempt: {repair.attemptId} ·{' '}
          {repair.executionMs === null
            ? `${minutes(repair.reservedExecutionMs)} reserved`
            : `${minutes(repair.executionMs)} consumed`}
        </p>
      ))}
    </section>
  );
}
function minutes(ms: number) {
  return `${Math.ceil(ms / 60000)} min`;
}
