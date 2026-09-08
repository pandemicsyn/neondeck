import type { FactoryCodingRun } from '../../../../shared/factory-coding';
import { FactoryCodingCandidate } from './FactoryCodingCandidate';
import { useFactoryRefresh } from './useFactoryRefresh';
import { useQuery } from '@tanstack/react-query';
import { getFactoryDeliveryState } from '../../api/factory-delivery';
import { FactoryDeliveryDetail } from './FactoryDeliveryDetail';
export function FactoryDelivery({
  automaticValidation = false,
  admissionBlocked = false,
  candidateDiff,
  runId,
  workId,
  onDiscuss,
  releaseId,
}: {
  automaticValidation?: boolean;
  admissionBlocked?: boolean;
  candidateDiff?: NonNullable<FactoryCodingRun['diff']>;
  runId: string;
  workId: string;
  releaseId?: string;
  onDiscuss?: (evidence: string) => void;
}) {
  const { refreshing, refresh } = useFactoryRefresh();
  const state = useQuery({
    queryKey: ['factory-delivery-state'],
    queryFn: ({ signal }) => getFactoryDeliveryState({ signal }),
    refetchInterval: 10000,
  });
  const matches =
    state.data?.deliveries.filter(
      ({ pipeline }) =>
        pipeline.workItemId === workId &&
        ((releaseId !== undefined &&
          pipeline.initialRevision.releaseId === releaseId) ||
          pipeline.initialRevision.runId === runId ||
          pipeline.revision.runId === runId ||
          pipeline.repairs.some((repair) => repair.runId === runId)),
    ) ?? [];
  return (
    <section
      className="factory-delivery"
      aria-label="Review result"
      id="factory-review-result"
      tabIndex={-1}
    >
      <div className="factory-toolbar">
        <h3>Review result</h3>
        <button
          disabled={state.isPending || refreshing}
          onClick={() => void refresh(() => state.refetch())}
        >
          Refresh delivery
        </button>
      </div>
      {state.isPending && <output>Loading delivery authority…</output>}
      {state.error && (
        <p role="alert" className="factory-error">
          Delivery state unavailable or unsupported. Retained evidence may be
          stale; grant controls are disabled.
        </p>
      )}
      {matches.length === 0 && candidateDiff && (
        <FactoryCodingCandidate diff={candidateDiff} />
      )}
      {state.data &&
        matches.length === 0 &&
        automaticValidation &&
        !admissionBlocked && (
          <p>
            Preparing checks and independent review. This release already
            authorizes local validation and bounded repairs; waiting for the
            worker to record admission.
          </p>
        )}
      {state.data && matches.length === 0 && !automaticValidation && (
        <section aria-label="Historical workflow recovery">
          <h4>Release this plan again to use the updated workflow</h4>
          <p>
            Your plan, candidate and history are retained. Open the plan,
            withdraw the historical release, then approve the same plan with the
            automatic validation policy.
          </p>
          {onDiscuss ? (
            <button
              onClick={() =>
                onDiscuss(
                  'This historical release has no current validation policy. Review and release the existing plan again to use automatic checks and independent review. Retained work and history remain available.',
                )
              }
            >
              Review plan for updated workflow
            </button>
          ) : (
            <a href={`/factory?task=${encodeURIComponent(workId)}`}>
              Open retained plan
            </a>
          )}
        </section>
      )}
      {matches.length > 0 &&
        matches[0].pipeline.initialRevision.runId !== runId && (
          <p>
            This release already has a delivery. Repair descendants retain its
            grant and cumulative budget.{' '}
            <a
              href={`#factory-delivery-${encodeURIComponent(matches[0].pipeline.pipelineId)}`}
            >
              Inspect existing delivery
            </a>
          </p>
        )}
      {matches.map(({ pipeline }) => (
        <FactoryDeliveryDetail
          candidateDiff={candidateDiff}
          key={pipeline.pipelineId}
          id={pipeline.pipelineId}
          workId={workId}
          onDiscuss={onDiscuss}
        />
      ))}
    </section>
  );
}
