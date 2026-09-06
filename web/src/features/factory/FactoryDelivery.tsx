import { useQuery } from '@tanstack/react-query';
import { getFactoryDeliveryState } from '../../api/factory-delivery';
import { FactoryDeliveryGrant } from './FactoryDeliveryGrant';
import { FactoryDeliveryDetail } from './FactoryDeliveryDetail';
export function FactoryDelivery({
  runId,
  workId,
  onDiscuss,
  releaseId,
}: {
  runId: string;
  workId: string;
  releaseId?: string;
  onDiscuss?: (evidence: string) => void;
}) {
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
    <section className="factory-delivery" aria-label="Candidate delivery">
      <div className="factory-toolbar">
        <h3>Candidate delivery</h3>
        <button
          disabled={state.isFetching}
          onClick={() => void state.refetch()}
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
      {state.data && matches.length === 0 && (
        <FactoryDeliveryGrant
          runId={runId}
          workId={workId}
          disabled={!!state.error || state.isFetching}
          onGranted={() => state.refetch()}
        />
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
          key={pipeline.pipelineId}
          id={pipeline.pipelineId}
          workId={workId}
          onDiscuss={onDiscuss}
        />
      ))}
    </section>
  );
}
