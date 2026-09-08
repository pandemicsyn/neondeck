import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getFactoryReviewedDiff,
  type DeliveryDetail,
} from '../../api/factory-delivery';
import { currentValidation, sameCandidate } from './FactoryLifecycle';
import { MultiFileView } from '../diff-viewer/MultiFileView';
import { splitUnifiedPatchFiles } from '../diff-viewer/helpers';
import { useFactoryRefresh } from './useFactoryRefresh';

export function useFactoryReviewedDiff(detail: DeliveryDetail) {
  const { pipeline: p } = detail;
  return useQuery({
    queryKey: ['factory-reviewed-diff', p.pipelineId, p.version],
    queryFn: ({ signal }) => getFactoryReviewedDiff(p.pipelineId, { signal }),
    enabled: !!currentValidation(detail).checks,
    retry: false,
  });
}
export function FactoryReviewedDiff({ detail }: { detail: DeliveryDetail }) {
  const reviewed = useFactoryReviewedDiff(detail);
  const { refreshing, refresh } = useFactoryRefresh();
  const current =
    reviewed.data &&
    reviewed.data.diff !== null &&
    sameCandidate(reviewed.data.revision, detail.pipeline.revision);
  const view = useMemo(
    () => reviewedDiffView(current ? reviewed.data!.diff : null),
    [current, reviewed.data],
  );
  if (!currentValidation(detail).checks) return null;
  return (
    <section aria-label="Reviewed candidate diff">
      {reviewed.isPending && (
        <output>Loading the immutable reviewed diff…</output>
      )}
      {reviewed.error && (
        <p className="factory-error" role="alert">
          Reviewed changes are unavailable. {reviewed.error.message}
        </p>
      )}
      {reviewed.data && !current && (
        <p className="factory-error">
          {reviewed.data.unavailableReason ??
            'The reviewed diff does not match this candidate. Reload current evidence before approving.'}
        </p>
      )}
      {current && !reviewed.error && (
        <div
          className="factory-coding-diff"
          aria-label="Immutable reviewed changes"
        >
          {view.kind === 'raw' ? (
            <>
              <p>
                Some file paths need the complete text view. All retained
                changes are shown below.
              </p>
              <pre
                tabIndex={0}
                role="region"
                aria-label="Complete reviewed diff"
              >
                {view.patch}
              </pre>
            </>
          ) : view.kind !== 'unavailable' ? (
            <MultiFileView
              key={reviewed.data!.revision.treeSha}
              files={view.files}
              title="Reviewed candidate changes"
              detail="Retained revision bound to checks and review"
              emptyLabel="No changes in the retained reviewed diff."
            />
          ) : null}
        </div>
      )}
      {(reviewed.error || (reviewed.data && !current)) && (
        <button
          disabled={refreshing}
          onClick={() => void refresh(() => reviewed.refetch())}
        >
          {refreshing
            ? 'Reloading reviewed changes…'
            : 'Reload reviewed changes'}
        </button>
      )}
    </section>
  );
}

/** Fall back to the full immutable text if file splitting cannot account for every Git header. */
export function reviewedDiffView(patch: string | null) {
  if (patch === null) return { kind: 'unavailable' as const };
  const files = splitUnifiedPatchFiles(patch);
  const headers = [...patch.matchAll(/^diff --git /gm)];
  const complete =
    files.every((file) => file.patch !== null) &&
    headers.length === files.length &&
    (patch.trim() === '' ||
      (headers[0]?.index === 0 &&
        files
          .map((file) => file.patch)
          .join('')
          .trimEnd() === patch.trimEnd()));
  return complete
    ? { kind: 'files' as const, files }
    : { kind: 'raw' as const, patch };
}
