import { useFactoryRefresh } from './useFactoryRefresh';
import { FactoryDelivery } from './FactoryDelivery';
import { useState } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { FactoryCodingRun } from '../../../../shared/factory-coding';
import {
  retryFactoryValidation,
  controlFactoryCodingRun,
  getFactoryCodingRun,
  getFactoryCodingRuns,
  getFactoryCodingState,
} from '../../api/factory-coding';
import { factoryCodingStateKey } from './FactoryCodingSetup';
import { FactoryCodingEvidence } from './FactoryCodingEvidence';
import { FactoryStageSection } from './FactoryLifecycle';

const statuses: Record<
  FactoryCodingRun['displayStatus'],
  { title: string; description: string }
> = {
  reserved: {
    title: 'Preparing workspace',
    description:
      'The exact released brief is reserved. Neon is preparing an isolated worktree.',
  },
  running: {
    title: 'Coding in progress',
    description:
      'The pinned coding CLI is working in the managed worktree. Progress is retained below.',
  },
  cancelling: {
    title: 'Stopping coding',
    description:
      'Cancellation is recorded. Ownership remains held until the process and its children are confirmed stopped.',
  },
  collecting: {
    title: 'Collecting candidate',
    description:
      'Neon is collecting the worktree changes and execution evidence.',
  },
  'needs-reconcile': {
    title: 'Ownership needs reconciliation',
    description:
      'The writer’s state is uncertain. The workspace is retained and no replacement run will start.',
  },
  'candidate-awaiting-review': {
    title: 'Coding candidate retained',
    description:
      'Coding has finished. Current checks, independent review and publication status are shown in Review result.',
  },
  failed: {
    title: 'Coding attempt failed',
    description:
      'The failed attempt and its worktree evidence are retained. No automatic retry is scheduled.',
  },
  cancelled: {
    title: 'Coding stopped',
    description:
      'Cancellation completed. Existing changes and evidence are retained.',
  },
};

export function FactoryCoding({
  workId,
  automaticValidationReleaseIds = [],
  currentReleaseId,
  currentNavigation = 0,
  eligible,
  onDiscussDelivery,
}: {
  workId: string;
  eligible: boolean;
  automaticValidationReleaseIds?: string[];
  currentReleaseId?: string;
  currentNavigation?: number;
  onDiscussDelivery?: (evidence: string) => void;
}) {
  const client = useQueryClient();
  const { refreshing, refresh } = useFactoryRefresh();
  const [selection, setSelection] = useState<{
    id: string | null;
    navigation: number;
  }>({ id: null, navigation: currentNavigation });
  const selected =
    selection.navigation === currentNavigation ? selection.id : null;
  const setSelected = (id: string) =>
    setSelection({ id, navigation: currentNavigation });
  const state = useQuery({
    queryKey: factoryCodingStateKey,
    queryFn: ({ signal }) => getFactoryCodingState({ signal }),
    refetchInterval: 15000,
  });
  const runs = useInfiniteQuery({
    queryKey: ['factory-coding-runs', workId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      getFactoryCodingRuns(workId, pageParam, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const matching = items.filter(
    (item) => item.run.record.snapshot.workItemId === workId,
  );
  const attention = runs.data?.pages[0]?.attention;
  const selectedId =
    selected ??
    (currentReleaseId
      ? matching.find(
          (item) => item.run.record.snapshot.releaseId === currentReleaseId,
        )?.run.record.runId
      : matching[0]?.run.record.runId);
  const selectionOutsidePage =
    selected !== null &&
    !matching.some((item) => item.run.record.runId === selected);
  return (
    <section
      className="factory-coding"
      aria-label="Task coding"
      id="factory-code"
      tabIndex={-1}
    >
      <div className="factory-toolbar">
        <h3>Coding</h3>
        <button
          disabled={
            runs.isPending ||
            state.isPending ||
            refreshing ||
            runs.isFetchingNextPage
          }
          onClick={() =>
            void refresh(() =>
              Promise.all([
                runs.refetch(),
                state.refetch(),
                selectedId
                  ? client.invalidateQueries({
                      queryKey: ['factory-coding-run', selectedId],
                    })
                  : Promise.resolve(),
              ]),
            )
          }
        >
          {refreshing ? 'Refreshing coding…' : 'Refresh coding'}
        </button>
      </div>
      {runs.isPending && <output>Loading coding attempts…</output>}
      {runs.error && (
        <p className="factory-error" role="alert">
          Coding history unavailable or unsupported.{' '}
          {runs.data
            ? 'Showing retained history; controls require a fresh run read.'
            : 'Refresh coding to try again.'}
        </p>
      )}
      {attention && (
        <div className="factory-error" role="alert">
          <strong>Coding could not start</strong>
          <p>{attention.reason}</p>
        </div>
      )}
      {!runs.isPending && !runs.error && !attention && !selectedId && (
        <p>
          {!eligible
            ? 'Review and release the current brief before it can enter coding.'
            : state.error
              ? 'Coding readiness is unavailable. Refresh readiness in Factory setup.'
              : !state.data
                ? 'Checking coding readiness…'
                : !state.data.config.enabled
                  ? 'This brief is released. Local coding is disabled; open Factory setup to allow automatic dispatch.'
                  : !state.data.readiness.ready
                    ? 'This brief is released. Resolve the requirements in Factory setup.'
                    : 'This brief is released and awaiting automatic dispatch. A single writer handles eligible work.'}
          {eligible &&
            (state.error ||
              (state.data &&
                (!state.data.config.enabled ||
                  !state.data.readiness.ready))) && (
              <>
                {' '}
                <a
                  href="#factory-setup"
                  onClick={() => {
                    const setup = document.getElementById('factory-setup');
                    if (setup instanceof HTMLDetailsElement) setup.open = true;
                  }}
                >
                  Open Factory setup
                </a>
              </>
            )}
        </p>
      )}
      {(matching.length > 1 ||
        selectionOutsidePage ||
        (!selectedId && matching.length > 0)) && (
        <label className="factory-coding-attempt-picker">
          Recorded attempt
          <select
            value={selectedId ?? ''}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!selectedId && (
              <option value="" disabled>
                Choose a retained coding attempt
              </option>
            )}
            {selectionOutsidePage && (
              <option value={selected ?? undefined}>
                Selected attempt · {selected}
              </option>
            )}
            {matching.map(({ run }) => (
              <option key={run.record.runId} value={run.record.runId}>
                {statuses[run.displayStatus].title} · v
                {run.record.snapshot.specVersion} · {run.record.attemptId}
              </option>
            ))}
          </select>
        </label>
      )}
      {runs.hasNextPage && (
        <button
          disabled={runs.isFetchingNextPage || refreshing}
          onClick={() => void runs.fetchNextPage()}
        >
          {runs.isFetchingNextPage ? 'Loading attempts…' : 'Load more attempts'}
        </button>
      )}
      {selectedId && (
        <FactoryCodingRunDetail
          automaticValidationReleaseIds={automaticValidationReleaseIds}
          key={selectedId}
          id={selectedId}
          workId={workId}
          onDiscussDelivery={onDiscussDelivery}
        />
      )}
    </section>
  );
}

function FactoryCodingRunDetail({
  automaticValidationReleaseIds,
  id,
  workId,
  onDiscussDelivery,
}: {
  automaticValidationReleaseIds: string[];
  id: string;
  workId: string;
  onDiscussDelivery?: (evidence: string) => void;
}) {
  const client = useQueryClient();
  const run = useQuery({
    queryKey: ['factory-coding-run', id],
    queryFn: async ({ signal }) => {
      const result = await getFactoryCodingRun(id, { signal });
      if (result.record.snapshot.workItemId !== workId)
        throw new Error('Run belongs to a different task.');
      return result;
    },
    refetchInterval: 5000,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function control(action: 'cancel' | 'reconcile') {
    if (pending || !run.data || run.error) return;
    setPending(true);
    setError('');
    try {
      await controlFactoryCodingRun(id, action, run.data.record.version);
      await client.invalidateQueries({ queryKey: ['factory-coding-run', id] });
      await client.invalidateQueries({
        queryKey: ['factory-coding-runs', workId],
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The run could not be updated.',
      );
      await run.refetch();
    } finally {
      setPending(false);
    }
  }
  async function retryValidation() {
    if (pending || !run.data || run.error) return;
    setPending(true);
    setError('');
    try {
      await retryFactoryValidation(id, run.data.record.version);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Validation admission retry failed.',
      );
    } finally {
      await run.refetch();
      await client.invalidateQueries({
        queryKey: ['factory-coding-runs', workId],
      });
      await client.invalidateQueries({ queryKey: ['factory-delivery-state'] });
      setPending(false);
    }
  }
  if (run.isPending) return <output>Loading coding run…</output>;
  if (!run.data)
    return (
      <p role="alert" className="factory-error">
        Coding run unavailable or unsupported.{' '}
        <button onClick={() => void run.refetch()}>Reload run</button>
      </p>
    );
  const { record, displayStatus } = run.data;
  const status = statuses[displayStatus];
  const active = ['reserved', 'running', 'collecting'].includes(displayStatus);
  return (
    <div className="factory-coding-run">
      <FactoryStageSection
        title={
          record.candidate
            ? `Completed coding · ${elapsed(record.createdAt, record.completedAt)}`
            : 'Coding activity'
        }
        current={!record.candidate || !!run.error || !!error}
      >
        <div className="factory-toolbar">
          <h3>{status.title}</h3>
          <span className="factory-coding-badge">
            Spec v{record.snapshot.specVersion}
          </span>
          {active && (
            <button
              disabled={pending || !!run.error}
              onClick={() => void control('cancel')}
            >
              {pending ? 'Requesting stop…' : 'Stop coding'}
            </button>
          )}
          {displayStatus === 'needs-reconcile' && (
            <button
              disabled={pending || !!run.error}
              onClick={() => void control('reconcile')}
            >
              {pending ? 'Reconciling…' : 'Reconcile ownership'}
            </button>
          )}
        </div>
        <output className="factory-coding-status">{status.description}</output>
        {run.error && (
          <p role="alert" className="factory-error">
            Run refresh failed. Displayed evidence may be stale; controls are
            disabled.{' '}
            <button onClick={() => void run.refetch()}>Reload run</button>
          </p>
        )}
        {error && (
          <p role="alert" className="factory-error">
            {error} Review the refreshed state before another action.
          </p>
        )}
        {(record.reason || record.cancelReason) && (
          <p className="factory-coding-reason">
            {record.reason ?? record.cancelReason}
          </p>
        )}
        <p>Elapsed: {elapsed(record.createdAt, record.completedAt)}</p>
        <details>
          <summary>Coding attempt details</summary>
          <dl className="factory-coding-facts">
            <div>
              <dt>Attempt</dt>
              <dd>{record.attemptId}</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd>{elapsed(record.createdAt, record.completedAt)}</dd>
            </div>
            <div>
              <dt>Pinned coding CLI</dt>
              <dd>
                {record.snapshot.harness.provider} ·{' '}
                {record.snapshot.harness.version}
              </dd>
            </div>
            <div>
              <dt>Pinned model</dt>
              <dd>{record.snapshot.harness.model}</dd>
            </div>
            <div>
              <dt>Provider session</dt>
              <dd>{record.providerSessionId ?? 'Not recorded yet'}</dd>
            </div>
            <div>
              <dt>Pinned base</dt>
              <dd>
                <code>{record.snapshot.baseSha}</code>
              </dd>
            </div>
            {record.candidate && (
              <div>
                <dt>Collected head</dt>
                <dd>
                  <code>{record.candidate.headSha}</code>
                </dd>
              </div>
            )}
          </dl>
        </details>
        {record.cleanupAttentionAt && (
          <p className="factory-note">
            Work retained. Cleanup attention: {date(record.cleanupAttentionAt)}.{' '}
            {record.evidenceRetainUntil && (
              <>Evidence retention: {date(record.evidenceRetainUntil)}.</>
            )}
          </p>
        )}
        <details className="factory-coding-evidence">
          <summary>Captured attempt provenance</summary>
          <dl className="factory-coding-facts">
            <div>
              <dt>Run</dt>
              <dd>{record.runId}</dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>{record.snapshot.releaseId}</dd>
            </div>
            <div>
              <dt>Specification hash</dt>
              <dd>{record.snapshot.specHash}</dd>
            </div>
            <div>
              <dt>Harness version</dt>
              <dd>{record.snapshot.harness.version}</dd>
            </div>
            {record.candidate && (
              <>
                <div>
                  <dt>Captured status evidence</dt>
                  <dd>{record.candidate.statusRef}</dd>
                </div>
                <div>
                  <dt>Captured diff evidence</dt>
                  <dd>{record.candidate.diffRef}</dd>
                </div>
              </>
            )}
            <div>
              <dt>Last recorded update</dt>
              <dd>{date(record.updatedAt)}</dd>
            </div>
          </dl>
        </details>
        <p className="factory-note">
          This attempt retains its admitted CLI and model. Changing coding
          settings does not change this run or its grant. Each attempt starts a
          fresh session.
        </p>
        <FactoryCodingEvidence id={id} />
      </FactoryStageSection>
      {run.data.validationAdmission && (
        <section
          className="factory-error"
          aria-label="Validation admission needs attention"
          id="factory-validation-attention"
          tabIndex={-1}
        >
          <h4>Validation could not start</h4>
          <p>{run.data.validationAdmission.message}</p>
          {run.data.validationAdmission.nextAction === 'retry-validation' ? (
            <button
              disabled={pending || !!run.error}
              onClick={() => void retryValidation()}
            >
              {pending
                ? 'Retrying validation admission…'
                : 'Retry validation admission'}
            </button>
          ) : onDiscussDelivery ? (
            <button
              onClick={() =>
                onDiscussDelivery(
                  `Validation admission needs a plan review: ${run.data!.validationAdmission!.message}`,
                )
              }
            >
              Review validation policy with Neon
            </button>
          ) : (
            <a href={`/factory?task=${encodeURIComponent(workId)}`}>
              Open task planning
            </a>
          )}
        </section>
      )}
      {record.candidate && !run.data.diff && (
        <p>
          The candidate is retained, but its prepared diff is not available yet.
          Reload coding to inspect the result.
        </p>
      )}
      {record.candidate && (
        <FactoryDelivery
          admissionBlocked={!!run.data.validationAdmission}
          automaticValidation={automaticValidationReleaseIds.includes(
            record.snapshot.releaseId,
          )}
          candidateDiff={run.data.diff ?? undefined}
          runId={id}
          workId={workId}
          onDiscuss={onDiscussDelivery}
          releaseId={record.snapshot.releaseId}
        />
      )}
    </div>
  );
}
function elapsed(start: string, end: string | null) {
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return 'Unavailable';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s${end ? ' total' : ''}`;
}
function date(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString()
    : 'Unavailable';
}
