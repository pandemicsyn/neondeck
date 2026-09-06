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
        verification and review. Each attempt is limited to 45 minutes. Unknown
        in-flight usage remains reserved.
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
  return (
    <section
      className="factory-delivery-evidence"
      aria-label="Independent validation"
    >
      <h4>Independent checks and review</h4>
      <ul>
        {p.authorization.checkCommands.map((command) => (
          <li key={command}>
            <code>{command}</code>
          </li>
        ))}
      </ul>
      {p.feedback
        .filter((item) => item.id !== triggeringDeliveryFeedback(detail)?.id)
        .map((item) => (
          <FactoryDeliveryEvidenceContent
            key={item.id}
            deliveryId={p.pipelineId}
            evidenceId={item.id}
            version={p.version}
            label={`External feedback · ${item.classification?.result.replaceAll('-', ' ') ?? 'Awaiting classification'}`}
          />
        ))}
      {(['verification', 'review'] as const).map((kind) => {
        const records = p.evidence.filter((e) => e.kind === kind);
        const verification = p.evidence
          .filter(
            (e) =>
              e.kind === 'verification' &&
              JSON.stringify(e.revision) === JSON.stringify(p.revision),
          )
          .at(-1);
        const current = records.filter(
          (e) =>
            JSON.stringify(e.revision) === JSON.stringify(p.revision) &&
            (kind === 'verification' ||
              (verification &&
                e.verificationEvidenceId === verification.id &&
                e.verificationBundleDigest === verification.bundleDigest &&
                e.validationContractDigest ===
                  verification.validationContractDigest)),
        );
        return (
          <div key={kind} className="factory-delivery-evidence-row">
            <strong>
              {kind === 'verification'
                ? 'Independent checks'
                : 'Fresh read-only review'}
              : {current.at(-1)?.result ?? 'Pending, no current evidence'}
            </strong>
            {records.map((e) => (
              <FactoryDeliveryEvidenceContent
                key={e.id}
                deliveryId={p.pipelineId}
                evidenceId={e.id}
                version={p.version}
                label={`${e.result} · ${current.includes(e) ? 'Current tree' : 'Prior or unmatched evidence, not current certification'}`}
              />
            ))}
          </div>
        );
      })}
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
