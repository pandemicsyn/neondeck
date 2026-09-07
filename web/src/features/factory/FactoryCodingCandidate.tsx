import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFactoryCandidateDiff } from '../../api/factory-coding';
import { PreparedDiffReview } from '../diff-viewer/surfaces';
import type { FactoryCodingRun } from '../../../../shared/factory-coding';

export function FactoryCodingCandidate({
  diff,
}: {
  diff: NonNullable<FactoryCodingRun['diff']>;
}) {
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: ['factory-candidate-diff', diff.preparedDiffId, diff.worktreeId],
    queryFn: ({ signal }) =>
      getFactoryCandidateDiff(diff.preparedDiffId, diff.worktreeId, { signal }),
    enabled: open,
  });
  return (
    <div className="factory-coding-candidate">
      <p className="factory-note">
        These are current worktree changes. They may differ from the changes
        captured when coding finished.
      </p>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide worktree changes' : 'Review retained worktree'}
      </button>
      {open && (
        <section
          className="factory-coding-diff"
          tabIndex={0}
          aria-label="Retained worktree diff"
        >
          {summary.isPending && <output>Loading candidate review…</output>}
          {summary.error && (
            <p role="alert" className="factory-error">
              Candidate review unavailable.{' '}
              <button onClick={() => void summary.refetch()}>
                Reload candidate review
              </button>
            </p>
          )}
          {summary.data && !summary.error && (
            <PreparedDiffReview diff={summary.data} readOnly />
          )}
        </section>
      )}
    </div>
  );
}
