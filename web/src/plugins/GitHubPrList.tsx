import { useFlueClient } from '@flue/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useId, useState } from 'react';
import {
  getPrWatches,
  getGitHubPullRequests,
  getRepoRegistry,
  getWorkflowObservability,
  startPrReview,
  type GitHubPullRequest,
  type NeonCommandResult,
  type WorkflowObservability,
} from '../api';
import { SessionReferenceButton } from '../components/SessionReferenceButton';
import { StopPrWatchButton } from '../components/StopPrWatchButton';
import {
  Badge,
  EmptyState,
  Button,
  MiniEmpty,
  ScrollArea,
} from '../components/ui';
import { configEventTouchesFile, useConfigEvents } from '../lib/config-events';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import { isCompletedPrWatch } from '../lib/watch-status';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type GitHubPrListConfig = {
  limit: number;
};

const githubPrListDefaultConfig = {
  limit: 12,
};

const GitHubPrReview = lazy(() =>
  import('../features/pr-review/GitHubPrReview').then((module) => ({
    default: module.GitHubPrReview,
  })),
);

export const GitHubPrListPlugin = {
  id: 'github-pr-list',
  title: 'GitHub PR list',
  kind: 'data',
  defaultConfig: githubPrListDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(githubPrListDefaultConfig, config),
  Component({ config }) {
    const queryClient = useQueryClient();
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.githubPrs,
      queryFn: getGitHubPullRequests,
      refetchInterval: 5 * 60_000,
    });
    const { data: registry } = useQuery({
      queryKey: queryKeys.repoRegistry,
      queryFn: getRepoRegistry,
      refetchInterval: 5 * 60_000,
    });

    useConfigEvents((event) => {
      if (
        event.action === 'config_reload' ||
        configEventTouchesFile(event, 'repos.json')
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.githubPrs });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.repoRegistry,
        });
      }
    });

    const login = data?.login ? `@${data.login}` : '@you';
    const reviewTarget = readReviewPopoutTarget();
    const items = data ? data.items.slice(0, config.limit) : [];
    const repoIds = new Map(
      (registry?.repos ?? []).map((repo) => [
        `${repo.github.owner}/${repo.github.name}`,
        repo.id,
      ]),
    );
    const countLabel = data
      ? `${items.length} PR${items.length === 1 ? '' : 's'} · ${data.repos?.length ?? 0} REPOS`
      : 'OPEN PRs';

    return (
      <div className="terminal-list flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3.5 font-mono text-[11px] tracking-[0.14em]">
          <span className="flex items-center gap-2 text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            GITHUB · {login}
          </span>
          <span className="text-muted">{countLabel}</span>
        </header>
        {isLoading ? <PrSkeleton /> : null}
        {error ? (
          <EmptyState
            title="GitHub unavailable"
            detail={`${queryErrorMessage(error)}. Set GITHUB_TOKEN in .env to show authored, assigned, and review-requested PRs.`}
            tone="alert"
          />
        ) : null}
        {data && items.length === 0 ? (
          <EmptyState
            title="Inbox zero"
            detail="Authored, assigned, and review-requested PRs are clear."
          />
        ) : null}
        {data && items.length > 0 ? (
          <ScrollArea className="flex-1">
            <ul>
              {items.map((item) => (
                <PrRow
                  initialShowReview={
                    reviewTarget?.repo === item.repo &&
                    reviewTarget.number === item.number
                  }
                  item={item}
                  key={item.url}
                  repoId={repoIds.get(item.repo)}
                />
              ))}
            </ul>
          </ScrollArea>
        ) : null}
      </div>
    );
  },
} satisfies DisplayPlugin<GitHubPrListConfig>;

function PrRow({
  initialShowReview,
  item,
  repoId,
}: {
  initialShowReview?: boolean;
  item: GitHubPullRequest;
  repoId: string | undefined;
}) {
  const [showReview, setShowReview] = useState(Boolean(initialShowReview));
  const reviewPanelId = useId();

  return (
    <li key={item.url} className="pr-row px-3.5 py-2 last:border-b-0">
      <div className="group">
        <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10.5px] text-muted">
          <span className="truncate">{item.repo}</span>
          <span className="shrink-0">
            #{item.number} · {relativeTime(item.updatedAt)}
          </span>
        </div>
        <p className="line-clamp-2 text-[13px] font-medium leading-[1.35] text-ink group-hover:text-primary-strong">
          {item.title}
        </p>
        <div className="mt-1.5 flex items-center gap-2.5 font-mono text-[10px] text-primary">
          <span className={checkClass(item)}>● {checkLabel(item)}</span>
          <span className="text-violet">◆ {relationLabel(item)}</span>
          {item.stale ? <span className="text-accent">◇ stale</span> : null}
          {item.draft || item.labels.includes('draft') ? (
            <span className="text-muted">△ draft</span>
          ) : null}
          {!repoId ? (
            <span className="text-muted">◇ repo unregistered</span>
          ) : null}
        </div>
        {item.labels.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.labels.slice(0, 3).map((label) => (
              <Badge key={label}>{label}</Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-1.5 flex justify-end gap-1.5 font-mono text-[10px]">
          <Button
            className="min-h-[28px] shrink-0 border-line bg-transparent px-2 py-1 text-[10px] text-muted"
            aria-controls={showReview ? reviewPanelId : undefined}
            aria-expanded={showReview}
            onClick={() => setShowReview((value) => !value)}
            type="button"
          >
            {prDiffActionLabel(showReview)}
          </Button>
          <SessionReferenceButton
            kind="task"
            linkedRepoId={repoId ?? null}
            linkedTaskId={`github-pr:${item.repo}#${item.number}`}
            summary={`${item.repo}#${item.number}: ${item.title}. ${checkLabel(item)}; relation ${relationLabel(item)}.`}
            title={`PR ${item.repo}#${item.number}`}
            uiMetadata={{
              source: 'github-pr',
              repo: item.repo,
              prNumber: item.number,
              url: item.url,
              state: item.state,
              checks: item.checks?.status ?? null,
              relations: item.relations,
            }}
          />
          <NeonReviewButton item={item} />
          {isCiFixCandidate(item) ? <FixCiButton item={item} /> : null}
          <WatchPrButton item={item} />
          <a
            className="inline-flex min-h-[28px] shrink-0 items-center border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            href={item.url}
            rel="noreferrer"
            target="_blank"
          >
            open
          </a>
        </div>
        {showReview ? (
          <div className="mt-2" id={reviewPanelId}>
            <Suspense fallback={<MiniEmpty label="Loading PR review." />}>
              <GitHubPrReview pr={item} />
            </Suspense>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function readReviewPopoutTarget() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const repo = params.get('prReviewRepo')?.trim();
  const number = Number(params.get('prReviewNumber'));
  if (!repo || !Number.isInteger(number) || number < 1) return null;
  return { repo, number };
}

function NeonReviewButton({ item }: { item: GitHubPullRequest }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      startPrReview({
        ref: `${item.repo}#${item.number}`,
        origin: 'panel',
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prReviews });
    },
  });

  return (
    <Button
      className="min-h-[28px] shrink-0 border-line bg-transparent px-2 py-1 text-[10px] text-muted"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title={
        mutation.error
          ? queryErrorMessage(mutation.error)
          : mutation.data
            ? `Review workflow ${mutation.data.runId} is running. Follow it in Reviews.`
            : 'Prepare local reports and Neon-origin draft comments through the review workflow'
      }
      type="button"
    >
      {mutation.isPending
        ? 'queuing'
        : mutation.data
          ? 'queued'
          : neonReviewActionLabel()}
    </Button>
  );
}

function FixCiButton({ item }: { item: GitHubPullRequest }) {
  const flue = useFlueClient();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const run = await flue.workflows.invoke('fix-pr-ci', {
        input: {
          ref: `${item.repo}#${item.number}`,
        },
      });
      return run satisfies FixCiWorkflowAdmission;
    },
    onSuccess(run) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workflowObservability,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workflowSummaries,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.reports });
      scheduleCiFixCompletionRefresh(queryClient, run.runId);
    },
  });

  return (
    <Button
      className="min-h-[28px] shrink-0 border-line bg-transparent px-2 py-1 text-[10px] text-muted"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title={
        mutation.error
          ? queryErrorMessage(mutation.error)
          : mutation.data
            ? `Queued CI fix workflow run ${mutation.data.runId}. Reports and prepared-diff state will refresh when the run completes.`
            : 'Create a CI dossier and start a bounded local fix workflow'
      }
      type="button"
    >
      {mutation.isPending ? 'queuing' : mutation.data ? 'queued' : 'fix CI'}
    </Button>
  );
}

function scheduleCiFixCompletionRefresh(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: string,
) {
  let sawActiveRun = false;
  let done = false;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.reports });
    void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    void queryClient.invalidateQueries({ queryKey: queryKeys.kiloTasks });
    void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotState });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workflowObservability,
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workflowSummaries,
    });
  };
  const scheduleActiveFollowUp = () => {
    window.setTimeout(
      () => void observe(true),
      reviewCompletionActiveFollowUpDelay,
    );
  };
  const observe = async (forceRefresh: boolean) => {
    if (done) return;
    try {
      const workflows = await queryClient.fetchQuery({
        queryKey: queryKeys.workflowObservability,
        queryFn: getWorkflowObservability,
        staleTime: 0,
      });
      const state = reviewWorkflowRefreshDecision(
        workflows,
        runId,
        sawActiveRun,
        forceRefresh,
      );
      sawActiveRun = state.sawActiveRun;
      if (state.shouldRefresh) refresh();
      if (state.done) {
        done = true;
        return;
      }
      if (forceRefresh && state.sawActiveRun) scheduleActiveFollowUp();
    } catch {
      if (forceRefresh && !sawActiveRun) {
        refresh();
        done = true;
        return;
      }
      if (forceRefresh) scheduleActiveFollowUp();
    }
  };
  for (const delay of reviewCompletionPollDelays) {
    window.setTimeout(
      () => void observe(delay === reviewCompletionPollDelays.at(-1)),
      delay,
    );
  }
}

const reviewCompletionPollDelays = [15_000, 45_000, 90_000, 150_000, 210_000];
const reviewCompletionActiveFollowUpDelay = 60_000;

export function isCiFixCandidate(item: GitHubPullRequest) {
  return item.checks?.status === 'failure' || item.checkError !== undefined;
}

export function prDiffActionLabel(showing: boolean) {
  return showing ? 'hide diff' : 'view diff';
}

export function neonReviewActionLabel() {
  return 'run review';
}

export function reviewWorkflowCompletionState(
  workflows: WorkflowObservability,
  runId: string,
  sawActiveRun: boolean,
) {
  const active = workflows.activeRuns.some((run) => run.runId === runId);
  const terminal = [
    ...workflows.recentFailures,
    ...workflows.recentData,
    ...workflows.recentEvents,
  ].some((event) => event.runId === runId && event.eventType === 'run_end');
  return {
    terminal,
    sawActiveRun: sawActiveRun || active,
    shouldRefresh: terminal || (sawActiveRun && !active),
  };
}

export function reviewWorkflowRefreshDecision(
  workflows: WorkflowObservability,
  runId: string,
  sawActiveRun: boolean,
  forceRefresh: boolean,
) {
  const state = reviewWorkflowCompletionState(workflows, runId, sawActiveRun);
  const shouldFallbackRefresh = forceRefresh && !state.sawActiveRun;
  return {
    ...state,
    shouldRefresh: state.shouldRefresh || shouldFallbackRefresh,
    done: state.terminal || state.shouldRefresh || shouldFallbackRefresh,
  };
}

function WatchPrButton({ item }: { item: GitHubPullRequest }) {
  const flue = useFlueClient();
  const queryClient = useQueryClient();
  const watchId = `${item.repo}#${item.number}`;
  const { data: watchData } = useQuery({
    queryKey: queryKeys.prWatches,
    queryFn: getPrWatches,
    refetchInterval: 30_000,
  });
  const existingWatch = watchData?.watches.find(
    (watch) =>
      watch.id.toLowerCase() === watchId.toLowerCase() ||
      (watch.repoFullName.toLowerCase() === item.repo.toLowerCase() &&
        watch.prNumber === item.number),
  );
  const activeExistingWatch =
    existingWatch &&
    !isCompletedPrWatch(existingWatch) &&
    !isTerminalWatchStatus(existingWatch.status)
      ? existingWatch
      : undefined;
  const mutation = useMutation({
    mutationFn: async () => {
      const run = await flue.workflows.invoke('command-run', {
        input: {
          command: `/watch-pr ${watchId}`,
          surface: 'dashboard',
        },
        wait: 'result',
      });
      const result = {
        ...(run.result as NeonCommandResult),
        flueRunId: run.runId,
      };
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workflowObservability,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const watched = Boolean(activeExistingWatch || mutation.data);

  if (activeExistingWatch) {
    return (
      <StopPrWatchButton label="stop watch" watchId={activeExistingWatch.id} />
    );
  }

  return (
    <Button
      className="min-h-[28px] shrink-0 border-line bg-transparent px-2 py-1 text-[10px] text-muted"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title={
        mutation.error
          ? queryErrorMessage(mutation.error)
          : existingWatch
            ? `Re-watch ${existingWatch.id}`
            : mutation.data
              ? `${mutation.data.message} · run ${mutation.data.flueRunId}`
              : 'Watch this PR until checks are green'
      }
      type="button"
    >
      {mutation.isPending ? 'watching' : watched ? 'watched' : 'watch'}
    </Button>
  );
}

export function isTerminalWatchStatus(status: string | null | undefined) {
  return status === 'closed' || status === 'merged' || status === 'green';
}

type FixCiWorkflowAdmission = {
  runId: string;
};

function PrSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="border border-line bg-soft p-2">
          <div className="h-3 w-4/5 bg-line" />
          <div className="mt-2 h-2 w-3/5 bg-line" />
        </div>
      ))}
    </div>
  );
}

function checkLabel(item: GitHubPullRequest) {
  if (item.checkError) return 'checks unknown';
  if (!item.checks) return 'checks unknown';
  if (item.checks.status === 'success') return 'checks pass';
  if (item.checks.status === 'failure') return `${item.checks.failed} failed`;
  if (item.checks.status === 'pending') return `${item.checks.pending} pending`;
  return 'no checks';
}

function checkClass(item: GitHubPullRequest) {
  if (item.checks?.status === 'failure') return 'text-accent';
  if (item.checks?.status === 'pending') return 'text-violet';
  if (item.checks?.status === 'success') return 'text-primary';
  return 'text-muted';
}

function relationLabel(item: GitHubPullRequest) {
  if (item.relations.includes('review-requested')) return 'review requested';
  if (item.relations.includes('assigned')) return 'assigned';
  if (item.relations.includes('authored')) return 'authored';
  return `${item.comments || 0} comments`;
}
