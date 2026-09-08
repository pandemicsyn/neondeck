import { useFactoryRefresh } from './useFactoryRefresh';
/* Bounded regions intentionally support keyboard scrolling. */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
import { useQuery } from '@tanstack/react-query';
import { getFactoryHealth } from '../../api/factory-diagnostics';
import type { FactoryTaskDiagnosis } from '../../../../shared/factory-diagnostics';
import './FactoryOperations.css';

export const operationsTime = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'Not recorded';
const duration = (ms: number) => {
  const seconds = Math.ceil(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
    remainder || !seconds ? `${remainder}s` : '',
  ]
    .filter(Boolean)
    .join(' ');
};
export function FactoryOperationsTask({
  task,
}: {
  task: FactoryTaskDiagnosis;
}) {
  return (
    <article className="factory-operations-row">
      <strong>{task.status}</strong>
      <p>{task.nextStep}</p>
      <dl className="factory-operations-facts">
        <div>
          <dt>Pending since</dt>
          <dd>
            {operationsTime(task.pendingSince)}
            {task.pendingAgeMs !== null &&
              ` (${duration(task.pendingAgeMs)} at snapshot)`}
          </dd>
        </div>
        <div>
          <dt>Next retry</dt>
          <dd>
            {task.nextRetryAt
              ? operationsTime(task.nextRetryAt)
              : 'Not scheduled / unknown'}
          </dd>
        </div>
      </dl>
      {task.budgets.map((budget) => (
        <p key={budget.deliveryId}>
          Delivery <code>{budget.deliveryId}</code>:{' '}
          {duration(budget.remainingExecutionMs)} execution remaining ·{' '}
          {duration(budget.reservedExecutionMs)} reserved ·{' '}
          {duration(budget.consumedExecutionMs)} consumed ·{' '}
          {budget.repairsRemaining} repairs remaining ({budget.repairsUsed}{' '}
          used)
        </p>
      ))}
      {task.unresolvedEffects.map((effect) => (
        <p
          key={JSON.stringify([
            effect.deliveryId,
            effect.connectionId,
            effect.effectId,
          ])}
        >
          Unresolved {effect.kind}: {effect.state} ·{' '}
          <code>{effect.effectId}</code>
        </p>
      ))}
      {task.truncated && (
        <p>Task diagnosis is bounded; additional records may be omitted.</p>
      )}
    </article>
  );
}
export function FactoryOperations() {
  const { refreshing, refresh } = useFactoryRefresh();
  const health = useQuery({
    queryKey: ['factory-operations-health'],
    queryFn: () => getFactoryHealth(),
    refetchInterval: 15000,
  });
  return (
    <section className="factory-operations" aria-label="Factory health">
      <details open={health.data?.status !== 'healthy' || !!health.error}>
        <summary>
          Factory health
          {health.error
            ? ' · unavailable'
            : health.data
              ? ` · ${health.data.status}`
              : ' · checking'}
        </summary>
        <div className="factory-toolbar">
          <strong>
            Factory health{health.data ? ` · ${health.data.status}` : ''}
          </strong>
          <button
            disabled={health.isPending || refreshing}
            onClick={() => void refresh(() => health.refetch())}
          >
            {health.isPending || refreshing
              ? 'Checking health…'
              : 'Refresh health'}
          </button>
        </div>
        {health.isPending && <output>Loading worker health…</output>}
        {health.error && (
          <output>
            Health unavailable.{' '}
            {health.data
              ? 'Showing the last loaded snapshot; it may be stale.'
              : 'Retry with Refresh health.'}
          </output>
        )}
        {health.data && (
          <>
            <p>{health.data.summary}</p>
            <details>
              <summary>Worker progress and waiting tasks</summary>
              <p className="factory-operations-meta">
                Snapshot {operationsTime(health.data.generatedAt)}
              </p>
              <section
                className="factory-operations-scroll"
                tabIndex={0}
                aria-label="Worker progress and waiting tasks"
              >
                {!health.data.workers.length && (
                  <p>No worker observations recorded yet.</p>
                )}
                {health.data.workers.map((worker) => (
                  <article
                    className="factory-operations-row"
                    key={worker.worker}
                  >
                    <strong>
                      {worker.worker} · {worker.status}
                    </strong>
                    <dl className="factory-operations-facts">
                      <div>
                        <dt>Last tick</dt>
                        <dd>{operationsTime(worker.lastTickAt)}</dd>
                      </div>
                      <div>
                        <dt>Last success</dt>
                        <dd>{operationsTime(worker.lastSuccessAt)}</dd>
                      </div>
                      <div>
                        <dt>Next tick</dt>
                        <dd>
                          {worker.nextTickAt
                            ? operationsTime(worker.nextTickAt)
                            : 'Not scheduled / unknown'}
                        </dd>
                      </div>
                      <div>
                        <dt>Consecutive failures</dt>
                        <dd>{worker.consecutiveFailures}</dd>
                      </div>
                    </dl>
                    {worker.diagnosticsDegraded && (
                      <p>
                        Diagnostic persistence is degraded; observations may be
                        incomplete.
                      </p>
                    )}
                    {worker.lastError && (
                      <p>
                        Last error: {worker.lastError.class} ·{' '}
                        {worker.lastError.code}
                      </p>
                    )}
                  </article>
                ))}
                {!health.data.tasks.length && (
                  <p>No task diagnoses in this snapshot.</p>
                )}
                {health.data.tasks.map((task) => (
                  <div key={task.workId}>
                    <a
                      href={`/factory?task=${encodeURIComponent(task.workId)}`}
                    >
                      Open task {task.workId}
                    </a>
                    <FactoryOperationsTask task={task} />
                  </div>
                ))}
                {health.data.truncated && (
                  <p>
                    Task diagnoses are limited. Open a task for its own
                    diagnostics.
                  </p>
                )}
              </section>
            </details>
          </>
        )}
      </details>
    </section>
  );
}
