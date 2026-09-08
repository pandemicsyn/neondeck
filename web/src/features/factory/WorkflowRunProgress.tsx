/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Bounded logs must be keyboard-scrollable. */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
}: {
  initial: RepoWorkflowRun;
  onObserved: (run: RepoWorkflowRun) => void;
}) {
  const [cancelError, setCancelError] = useState('');
  const [cancelling, setCancelling] = useState(false);
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
      {(run.status === 'uncertain' || run.cleanup === 'retained') && (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Refreshing test status…' : 'Refresh test status'}
        </button>
      )}
      {query.error && (
        <p role="alert">
          Test progress could not refresh. The test may still be running.{' '}
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
            setCancelling(true);
            setCancelError('');
            try {
              await cancelRepoWorkflowRun(run.repoId, run.runId);
              await query.refetch();
            } catch {
              setCancelError(
                'Could not cancel the test. Refresh progress and retry.',
              );
            } finally {
              setCancelling(false);
            }
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
