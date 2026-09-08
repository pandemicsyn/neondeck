/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Bounded logs must be keyboard-scrollable. */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoWorkflowRun } from '../../../../shared/repo-workflow-runs';
import { cancelRepoWorkflowRun, getRepoWorkflowRun } from './workflow-api';
const statusLabels = {
  running: 'Test in progress',
  passed: 'Setup and checks passed',
  failed: 'Test failed',
  'setup-blocked': 'Setup needs attention',
  cancelled: 'Test cancelled',
  uncertain: 'Test outcome needs review',
};
const phaseLabels = {
  setup: 'Setting up repository',
  validation: 'Running checks',
  cleanup: 'Cleaning up test checkout',
  complete: 'Test complete',
};
export function WorkflowRunProgress({
  initial,
  onObserved,
  allowStatusRefresh = false,
}: {
  initial: RepoWorkflowRun;
  onObserved: (run: RepoWorkflowRun) => void;
  allowStatusRefresh?: boolean;
}) {
  const client = useQueryClient();
  const [cancelError, setCancelError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const lifetime = useRef<object | null>(null);
  useEffect(() => {
    lifetime.current = {};
    return () => {
      lifetime.current = null;
    };
  }, [initial.repoId, initial.runId]);
  const query = useQuery({
    queryKey: ['repo-workflow-run', initial.repoId, initial.runId],
    queryFn: ({ signal }) =>
      getRepoWorkflowRun(initial.repoId, initial.runId, { signal }),
    initialData: initial,
    refetchInterval: (q) => {
      const current = q.state.data;
      return current &&
        current.status !== 'running' &&
        (current.phase === 'complete' || current.cleanup === 'retained')
        ? false
        : 1000;
    },
  });
  const run = query.data;
  useEffect(() => {
    onObserved(run);
  }, [run, onObserved]);
  return (
    <section className="workflow-run" aria-label="Workflow test progress">
      <h3>{statusLabels[run.status]}</h3>
      <output>
        {phaseLabels[run.phase]} · Profile {run.profileId}
      </output>
      {run.guidance && <p>{run.guidance}</p>}
      {(allowStatusRefresh ||
        run.status === 'uncertain' ||
        run.cleanup === 'retained') && (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={async () => {
            const currentLifetime = lifetime.current;
            const result = await query.refetch();
            // Recovery may release ownership without changing terminal data.
            // A delayed response must not replace a subsequent run or refresh
            // its ownership after this instance has unmounted/changed runs.
            if (
              currentLifetime &&
              lifetime.current === currentLifetime &&
              result.isSuccess
            )
              onObserved(result.data);
          }}
        >
          {query.isFetching ? 'Refreshing test status…' : 'Refresh test status'}
        </button>
      )}
      {query.error && (
        <p role="alert">
          Test progress could not refresh. Showing the last confirmed status.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Refresh test progress
          </button>
        </p>
      )}
      {cancelError && <p role="alert">{cancelError}</p>}
      {run.status === 'running' && (
        <button
          type="button"
          disabled={cancelling}
          onClick={async () => {
            const currentLifetime = lifetime.current;
            const isCurrent = () =>
              !!currentLifetime && lifetime.current === currentLifetime;
            setCancelling(true);
            setCancelError('');
            let receipt: RepoWorkflowRun;
            try {
              receipt = await cancelRepoWorkflowRun(run.repoId, run.runId);
            } catch {
              if (isCurrent()) {
                setCancelError(
                  'Could not cancel the test. Refresh progress and retry.',
                );
                setCancelling(false);
              }
              return;
            }
            if (!isCurrent()) return;
            const key = ['repo-workflow-run', run.repoId, run.runId];
            // An older status request must not overwrite the mutation receipt.
            await client.cancelQueries({ queryKey: key, exact: true });
            if (!isCurrent()) return;
            client.setQueryData(key, receipt);
            onObserved(receipt);
            // A follow-up read failure is reported by the progress query; it
            // does not undo the confirmed receipt or imply cancel POST failed.
            await query.refetch();
            if (isCurrent()) setCancelling(false);
          }}
        >
          {cancelling ? 'Cancelling test…' : 'Cancel test'}
        </button>
      )}
      {run.logs.map((log, index) => (
        <details key={index} open={log.exitCode !== 0}>
          <summary>
            {log.phase === 'setup' ? 'Setup' : 'Checks'} · {log.command} ·{' '}
            {log.exitCode === 0
              ? 'Passed'
              : log.exitCode === null
                ? 'Stopped'
                : `Failed (exit ${log.exitCode})`}
          </summary>
          <p>
            Directory: {log.cwd} · {(log.durationMs / 1000).toFixed(1)} seconds
          </p>
          {/* Keyboard users can scroll the bounded output. */}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <pre
            tabIndex={0}
            aria-label={`${log.phase === 'setup' ? 'Setup' : 'Check'} command output`}
          >
            {log.output || 'No output.'}
          </pre>
          {log.truncated && (
            <p>Output was shortened to the retained log limit.</p>
          )}
        </details>
      ))}
      <p>
        Test checkout:{' '}
        {run.cleanup === 'complete'
          ? 'cleaned up'
          : run.cleanup === 'retained'
            ? 'retained for review'
            : 'cleanup pending'}
        .
      </p>
    </section>
  );
}
