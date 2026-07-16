import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  decideLearningCandidate,
  getLearningOperatorState,
  queueLearningReview,
  restoreSkillPatch,
  type LearningAuditEvent,
  type LearningCandidate,
  type LearningCandidateStatus,
  type LearningOperatorState,
  type LearningReviewRecord,
} from '../api';
import {
  Badge,
  Button,
  EmptyState,
  Metric,
  MiniEmpty,
  ScrollArea,
} from '../components/ui';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

const SkillPatchDiffReview = lazy(() =>
  import('../features/diff-viewer/surfaces').then((module) => ({
    default: module.SkillPatchDiffReview,
  })),
);

type LearningOperatorConfig = {
  limit: number;
  refreshSeconds: number;
};

type LearningTab = 'reviews' | 'candidates' | 'audit';
type CandidateFilter = 'all' | LearningCandidateStatus;
type CandidateTargetFilter = 'all' | 'memory' | 'skill';

const learningOperatorDefaultConfig = {
  limit: 18,
  refreshSeconds: 30,
};

export const LearningOperatorPanelPlugin = {
  id: 'learning-operator',
  title: 'Learning operator',
  kind: 'data',
  defaultConfig: learningOperatorDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(learningOperatorDefaultConfig, config),
  Component({ config }) {
    const [tab, setTab] = useState<LearningTab>('candidates');
    const [candidateFilter, setCandidateFilter] =
      useState<CandidateFilter>('all');
    const [candidateTargetFilter, setCandidateTargetFilter] =
      useState<CandidateTargetFilter>('all');
    const candidateStatus =
      candidateFilter === 'all' ? undefined : candidateFilter;
    const candidateTarget =
      candidateTargetFilter === 'all' ? undefined : candidateTargetFilter;
    const {
      data: state,
      error,
      isLoading,
    } = useQuery({
      queryKey: [
        ...queryKeys.learningState,
        { candidateStatus, candidateTarget, limit: config.limit },
      ],
      queryFn: () =>
        getLearningOperatorState({
          candidateStatus,
          candidateTarget,
          limit: config.limit,
        }),
      refetchInterval: Math.max(10, config.refreshSeconds) * 1000,
    });

    if (isLoading) {
      return (
        <EmptyState title="Learning loading" detail="Reading audit state." />
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Learning unavailable"
          detail={queryErrorMessage(error)}
          tone="alert"
        />
      );
    }

    if (!state) {
      return (
        <EmptyState
          title="Learning unavailable"
          detail="No data."
          tone="alert"
        />
      );
    }

    return (
      <LearningOperatorView
        candidateFilter={candidateFilter}
        candidateTargetFilter={candidateTargetFilter}
        limit={config.limit}
        onCandidateFilterChange={setCandidateFilter}
        onCandidateTargetFilterChange={setCandidateTargetFilter}
        onTabChange={setTab}
        state={state}
        tab={tab}
      />
    );
  },
} satisfies DisplayPlugin<LearningOperatorConfig>;

function LearningOperatorView({
  candidateFilter,
  candidateTargetFilter,
  limit,
  onCandidateFilterChange,
  onCandidateTargetFilterChange,
  onTabChange,
  state,
  tab,
}: {
  candidateFilter: CandidateFilter;
  candidateTargetFilter: CandidateTargetFilter;
  limit: number;
  onCandidateFilterChange: (filter: CandidateFilter) => void;
  onCandidateTargetFilterChange: (filter: CandidateTargetFilter) => void;
  onTabChange: (tab: LearningTab) => void;
  state: LearningOperatorState;
  tab: LearningTab;
}) {
  const tabs: LearningTab[] = ['reviews', 'candidates', 'audit'];
  const tabIdPrefix = useId();
  const candidates = useMemo(() => {
    const source =
      candidateFilter === 'all'
        ? state.candidates
        : state.candidates.filter(
            (candidate) => candidate.status === candidateFilter,
          );
    return source.slice(0, limit);
  }, [candidateFilter, limit, state.candidates]);
  const audits = [...state.learningEvents, ...state.memoryEvents]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <h2 className="m-0 text-[inherit] font-[inherit] text-violet">
          LEARNING
        </h2>
        <Badge
          className={
            state.summary.pendingDecisions > 0
              ? 'border-primary text-primary'
              : ''
          }
        >
          {state.summary.pendingDecisions} pending
        </Badge>
      </header>
      <div className="border-b border-line px-3 py-2">
        <div className="grid grid-cols-4 gap-1.5 font-mono text-[10px] text-muted">
          <Metric label="reviews" value={countTotal(state.summary.reviews)} />
          <Metric label="failed" value={state.summary.failedReviews} />
          <Metric label="memory" value={state.summary.activeMemories} />
          <Metric label="PR events" value={state.summary.handledPrEvents} />
        </div>
        <div
          aria-label="Learning views"
          className="mt-2 grid grid-cols-3 gap-1"
          role="tablist"
        >
          {tabs.map((option, index) => (
            <button
              aria-controls={`${tabIdPrefix}-${option}-panel`}
              aria-selected={tab === option}
              className={tabClass(tab === option)}
              id={`${tabIdPrefix}-${option}-tab`}
              key={option}
              onClick={() => onTabChange(option)}
              onKeyDown={(event) =>
                handleLearningTabKeyDown({
                  event,
                  index,
                  onTabChange,
                  tabIdPrefix,
                  tabs,
                })
              }
              role="tab"
              tabIndex={tab === option ? 0 : -1}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div
        aria-labelledby={`${tabIdPrefix}-${tab}-tab`}
        className="flex min-h-0 flex-1 flex-col"
        id={`${tabIdPrefix}-${tab}-panel`}
        role="tabpanel"
        tabIndex={0}
      >
        {tab === 'candidates' ? (
          <>
            <CandidateFilterBar
              filter={candidateFilter}
              onFilterChange={onCandidateFilterChange}
            />
            <CandidateTargetFilterBar
              filter={candidateTargetFilter}
              onFilterChange={onCandidateTargetFilterChange}
            />
          </>
        ) : null}
        <ScrollArea className="flex-1">
          <div className="space-y-1.5 p-3">
            {tab === 'reviews' ? (
              <ReviewsTab reviews={state.reviews.slice(0, limit)} />
            ) : null}
            {tab === 'candidates' ? (
              <CandidatesTab candidates={candidates} />
            ) : null}
            {tab === 'audit' ? <AuditTab events={audits} /> : null}
          </div>
        </ScrollArea>
      </div>
      <LearningActions />
    </div>
  );
}

function CandidateFilterBar({
  filter,
  onFilterChange,
}: {
  filter: CandidateFilter;
  onFilterChange: (filter: CandidateFilter) => void;
}) {
  const filters: CandidateFilter[] = [
    'all',
    'proposed',
    'applied',
    'rejected',
    'archived',
  ];
  return (
    <fieldset
      aria-label="Candidate status"
      className="m-0 grid min-w-0 grid-cols-5 gap-1 border-0 border-b border-line px-3 py-2"
    >
      {filters.map((option) => (
        <button
          aria-pressed={filter === option}
          className={tabClass(filter === option)}
          key={option}
          onClick={() => onFilterChange(option)}
          type="button"
        >
          {option}
        </button>
      ))}
    </fieldset>
  );
}

function CandidateTargetFilterBar({
  filter,
  onFilterChange,
}: {
  filter: CandidateTargetFilter;
  onFilterChange: (filter: CandidateTargetFilter) => void;
}) {
  const filters: CandidateTargetFilter[] = ['all', 'memory', 'skill'];
  return (
    <fieldset
      aria-label="Candidate target"
      className="m-0 grid min-w-0 grid-cols-3 gap-1 border-0 border-b border-line px-3 py-2"
    >
      {filters.map((option) => (
        <button
          aria-pressed={filter === option}
          className={tabClass(filter === option)}
          key={option}
          onClick={() => onFilterChange(option)}
          type="button"
        >
          {option}
        </button>
      ))}
    </fieldset>
  );
}

function ReviewsTab({ reviews }: { reviews: LearningReviewRecord[] }) {
  if (reviews.length === 0) return <MiniEmpty label="No learning reviews." />;
  return reviews.map((review) => <ReviewRow key={review.id} review={review} />);
}

function CandidatesTab({ candidates }: { candidates: LearningCandidate[] }) {
  if (candidates.length === 0) {
    return <MiniEmpty label="No learning candidates in this filter." />;
  }
  return candidates.map((candidate) => (
    <CandidateRow candidate={candidate} key={candidate.id} />
  ));
}

function AuditTab({ events }: { events: LearningAuditEvent[] }) {
  if (events.length === 0)
    return <MiniEmpty label="No learning audit events." />;
  return events.map((event) => <AuditRow event={event} key={event.id} />);
}

function ReviewRow({ review }: { review: LearningReviewRecord }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {review.kind}:{review.id}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {review.error ?? reviewSummary(review.result)}
          </p>
        </div>
        <Badge className={statusClass(review.status)}>{review.status}</Badge>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted">
        {review.model} · {review.thinkingLevel} ·{' '}
        {relativeTime(review.startedAt)}
      </p>
    </article>
  );
}

function CandidateRow({ candidate }: { candidate: LearningCandidate }) {
  const [isViewingDiff, setIsViewingDiff] = useState(false);
  const diffPanelId = useId();
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decideLearningCandidate(candidate.id, decision, 'Dashboard decision.'),
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.learningState });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memories });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus });
    },
  });
  const restore = useMutation({
    mutationFn: () => restoreSkillPatch(candidate.id),
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.learningState });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus });
    },
  });
  const patch = skillPatchSummary(candidate.patch);
  const pending = decide.isPending || restore.isPending;

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {candidate.target}:
            {candidate.skillId ?? candidate.key ?? candidate.id}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {candidate.reason ??
              patch?.summary ??
              valuePreview(candidate.value)}
          </p>
        </div>
        <Badge className={statusClass(candidate.status)}>
          {candidate.status}
        </Badge>
      </div>
      {patch?.diff ? (
        <div className="mt-1.5">
          <Button
            aria-controls={diffPanelId}
            aria-expanded={isViewingDiff}
            className="h-6 px-2 py-0 font-mono text-[10px]"
            onClick={() => setIsViewingDiff((current) => !current)}
            type="button"
          >
            {isViewingDiff ? 'hide diff' : 'view diff'}
          </Button>
          {isViewingDiff ? (
            <div className="mt-1.5" id={diffPanelId}>
              <Suspense fallback={<MiniEmpty label="Loading diff viewer." />}>
                <SkillPatchDiffReview
                  patch={patch.diff}
                  title={candidate.skillId ?? candidate.key ?? candidate.id}
                />
              </Suspense>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {candidate.reviewId ?? candidate.id} ·{' '}
          {relativeTime(candidate.createdAt)}
        </span>
        {candidate.status === 'proposed' ? (
          <>
            <Button
              className="h-6 px-2 py-0 font-mono text-[10px]"
              disabled={pending}
              onClick={() => decide.mutate('reject')}
            >
              reject
            </Button>
            <Button
              className="h-6 border-primary px-2 py-0 font-mono text-[10px] text-primary"
              disabled={pending}
              onClick={() => decide.mutate('approve')}
            >
              apply
            </Button>
          </>
        ) : null}
        {candidate.target === 'skill' &&
        candidate.status === 'applied' &&
        patch?.restoreFromAudit ? (
          <Button
            className="h-6 border-accent px-2 py-0 font-mono text-[10px] text-accent"
            disabled={pending}
            onClick={() => restore.mutate()}
          >
            restore
          </Button>
        ) : null}
      </div>
      {decide.error || restore.error ? (
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-accent">
          {queryErrorMessage(decide.error ?? restore.error)}
        </p>
      ) : null}
    </article>
  );
}

function AuditRow({ event }: { event: LearningAuditEvent }) {
  const label = event.type ?? event.action ?? 'audit';
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">{label}</p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {event.reason ?? auditPreview(event.data ?? event.after)}
          </p>
        </div>
        <Badge>{event.source ?? event.actor ?? 'audit'}</Badge>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted">
        {event.prKey ?? event.sessionId ?? event.memoryId ?? event.id} ·{' '}
        {relativeTime(event.createdAt)}
      </p>
    </article>
  );
}

function LearningActions() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: queueLearningReview,
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.learningState });
    },
  });
  return (
    <footer className="grid grid-cols-2 gap-1 border-t border-line p-2">
      <Button
        className="h-7 px-2 py-0 font-mono text-[10px]"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate('conversation')}
      >
        review chat
      </Button>
      <Button
        className="h-7 px-2 py-0 font-mono text-[10px]"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate('pr-batch')}
      >
        review PRs
      </Button>
    </footer>
  );
}

function tabClass(active: boolean) {
  return active
    ? 'border border-primary bg-soft px-1.5 py-1 font-mono text-[10px] text-primary'
    : 'border border-line bg-soft px-1.5 py-1 font-mono text-[10px] text-muted hover:border-primary hover:text-primary';
}

function handleLearningTabKeyDown({
  event,
  index,
  onTabChange,
  tabIdPrefix,
  tabs,
}: {
  event: KeyboardEvent<HTMLButtonElement>;
  index: number;
  onTabChange: (tab: LearningTab) => void;
  tabIdPrefix: string;
  tabs: LearningTab[];
}) {
  let nextIndex: number | undefined;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (index + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (index - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1;
  }
  if (nextIndex === undefined) return;
  const nextTab = tabs[nextIndex];
  if (!nextTab) return;
  event.preventDefault();
  onTabChange(nextTab);
  document.getElementById(`${tabIdPrefix}-${nextTab}-tab`)?.focus();
}

function statusClass(status: string) {
  if (status === 'failed' || status === 'rejected') {
    return 'border-accent text-accent';
  }
  if (status === 'completed' || status === 'applied') {
    return 'border-primary text-primary';
  }
  if (status === 'proposed' || status === 'running') {
    return 'border-violet text-violet';
  }
  return '';
}

function skillPatchSummary(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as {
    summary?: string | null;
    diff?: string | null;
    restoreFromAudit?: boolean;
  };
}

function reviewSummary(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return valuePreview(value);
  }
  const record = value as Record<string, unknown>;
  return valuePreview(record.summary ?? record.message ?? record);
}

function auditPreview(value: unknown) {
  return valuePreview(value) || 'No audit detail.';
}

function valuePreview(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function countTotal(counts: Record<string, number>) {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}
