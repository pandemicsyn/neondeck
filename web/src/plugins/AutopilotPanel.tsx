import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import {
  getAutopilotState,
  getAutopilotRecoveryOptions,
  resolveAutopilotApproval,
  runAutopilotRecovery,
  type AutopilotActivity,
  type AutopilotApproval,
  type AutopilotPreparedDiff,
  type AutopilotQueueItem,
  type AutopilotRecoveryActionId,
  type AutopilotRecoveryOption,
  type AutopilotRepoPolicy,
  type AutopilotState,
  type AutopilotWatchPolicy,
} from '../api';
import { SessionReferenceButton } from '../components/SessionReferenceButton';
import {
  Badge,
  Button,
  EmptyState,
  MiniEmpty,
  ScrollArea,
} from '../components/ui';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

const PreparedDiffReview = lazy(() =>
  import('../features/diff-viewer/surfaces').then((module) => ({
    default: module.PreparedDiffReview,
  })),
);

type AutopilotPanelConfig = {
  queueLimit: number;
  policyLimit: number;
  preparedLimit: number;
  approvalLimit: number;
  checkLimit: number;
  activityLimit: number;
};

const autopilotPanelDefaultConfig = {
  queueLimit: 8,
  policyLimit: 6,
  preparedLimit: 4,
  approvalLimit: 4,
  checkLimit: 4,
  activityLimit: 8,
};

export const AutopilotPanelPlugin = {
  id: 'autopilot',
  title: 'Autopilot',
  kind: 'data',
  defaultConfig: autopilotPanelDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(autopilotPanelDefaultConfig, config),
  Component({ config }) {
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.autopilotState,
      queryFn: getAutopilotState,
      refetchInterval: 20_000,
    });

    if (isLoading) {
      return (
        <EmptyState
          title="Autopilot loading"
          detail="Reading operator state."
        />
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Autopilot unavailable"
          detail={queryErrorMessage(error)}
        />
      );
    }

    if (!data) {
      return <EmptyState title="Autopilot unavailable" detail="No data." />;
    }

    return <AutopilotView config={config} state={data} />;
  },
} satisfies DisplayPlugin<AutopilotPanelConfig>;

function AutopilotView({
  config,
  state,
}: {
  config: AutopilotPanelConfig;
  state: AutopilotState;
}) {
  const queue = state.queue.slice(0, config.queueLimit);
  const repoPolicies = state.policies.repos.slice(0, config.policyLimit);
  const watchPolicies = state.policies.watches.slice(0, config.policyLimit);
  const preparedDiffs = state.preparedDiffs.slice(0, config.preparedLimit);
  const approvals = state.pendingApprovals.slice(0, config.approvalLimit);
  const runningChecks = state.runningChecks.slice(0, config.checkLimit);
  const activity = state.recentActivity.slice(0, config.activityLimit);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-primary">AUTOPILOT</span>
        <div className="flex items-center gap-1.5">
          <Badge>{state.modeLabels[state.policies.global.mode]}</Badge>
          <Badge>{state.summary.queuedItems} queue</Badge>
        </div>
      </header>
      <NeedsAttentionBanner state={state} />
      <ScrollArea className="flex-1">
        <div className="grid gap-2 p-3 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="space-y-2">
            <SummaryStrip state={state} />
            <PanelSection
              count={state.queue.length}
              empty="No queued autopilot work."
              title="Queue"
            >
              {queue.map((item) => (
                <QueueRow item={item} key={item.id} />
              ))}
            </PanelSection>
            <PanelSection
              count={state.preparedDiffs.length}
              empty="No prepared diffs."
              title="Prepared"
            >
              {preparedDiffs.map((diff) => (
                <PreparedDiffRow diff={diff} key={diff.id} />
              ))}
            </PanelSection>
            <PanelSection
              count={state.pendingApprovals.length}
              empty="No pending push approvals."
              title="Approvals"
            >
              {approvals.map((approval) => (
                <ApprovalRow approval={approval} key={approval.id} />
              ))}
            </PanelSection>
          </section>
          <section className="space-y-2">
            <PolicyBlock
              repoPolicies={repoPolicies}
              state={state}
              watchPolicies={watchPolicies}
            />
            <PanelSection
              count={state.runningChecks.length}
              empty="No autopilot checks running."
              title="Checks"
            >
              {runningChecks.map((check) => (
                <CheckRow check={check} key={check.id} />
              ))}
            </PanelSection>
            <PanelSection
              count={state.recentActivity.length}
              empty="No autonomous activity recorded."
              title="Recent"
            >
              {activity.map((item) => (
                <ActivityRow item={item} key={item.id} />
              ))}
            </PanelSection>
            <PanelSection
              count={state.summary.placeholderAdapters.length}
              empty="No placeholder adapters."
              title="Adapters"
            >
              {state.summary.placeholderAdapters.map((adapter) => (
                <p
                  className="border border-line bg-soft px-2.5 py-2 text-[11px] leading-4 text-muted"
                  key={adapter}
                >
                  {adapter}
                </p>
              ))}
            </PanelSection>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function NeedsAttentionBanner({ state }: { state: AutopilotState }) {
  const items = [
    ['approvals', state.summary.pendingApprovals],
    ['unread', state.summary.unreadNotifications],
    ['failed checks', state.summary.failedChecks],
  ] as const;
  const total = items.reduce((sum, [, value]) => sum + value, 0);
  if (total === 0) return null;

  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-b border-accent/50 bg-soft px-3 font-mono text-[10px] leading-4 text-muted">
      <span className="text-accent">NEEDS ATTENTION</span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {items
          .filter(([, value]) => value > 0)
          .map(([label, value]) => (
            <span className="whitespace-nowrap" key={label}>
              {value} {label}
            </span>
          ))}
      </div>
    </div>
  );
}

function SummaryStrip({ state }: { state: AutopilotState }) {
  const items = [
    ['watches', state.summary.activeWatches],
    ['prepared', state.summary.preparedDiffs],
    ['approvals', state.summary.pendingApprovals],
    ['checks', state.summary.runningChecks],
  ] as const;

  return (
    <div className="grid grid-cols-4 border border-line bg-soft font-mono">
      {items.map(([label, value]) => (
        <div
          className="border-r border-line px-2 py-2 last:border-r-0"
          key={label}
        >
          <p className="text-[10px] uppercase text-muted">{label}</p>
          <p className="mt-1 text-[15px] text-primary">{value}</p>
        </div>
      ))}
    </div>
  );
}

function PanelSection({
  children,
  count,
  empty,
  title,
}: {
  children: ReactNode;
  count: number;
  empty: string;
  title: string;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] tracking-[0.12em] text-muted">
        <span>{title.toUpperCase()}</span>
        <span>{count}</span>
      </div>
      <div className="space-y-1.5">
        {count === 0 ? (
          <p className="border border-line bg-soft px-2.5 py-2 text-[11px] text-muted">
            {empty}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function QueueRow({ item }: { item: AutopilotQueueItem }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-primary">
            {prLabel(item.repoFullName, item.prNumber)}
          </p>
          <p className="mt-1 line-clamp-1 text-[12px] text-ink">{item.title}</p>
        </div>
        <Badge className={priorityClass(item.priority)}>{item.status}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">
        {item.reason}
      </p>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{item.nextStep}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <SessionReferenceButton
            kind="task"
            label="session"
            linkedRepoId={item.repoId}
            linkedTaskId={item.id}
            summary={`${item.title}: ${item.reason} Next step: ${item.nextStep}. Mode ${item.mode}; status ${item.status}.`}
            title={`Autopilot ${item.title}`}
            uiMetadata={{
              source: 'autopilot-queue',
              itemId: item.id,
              repoFullName: item.repoFullName,
              prNumber: item.prNumber,
              worktreeId: item.worktreeId,
              runId: item.runId,
              mode: item.mode,
              status: item.status,
            }}
          />
          {item.mode}
        </span>
      </div>
    </article>
  );
}

function PreparedDiffRow({ diff }: { diff: AutopilotPreparedDiff }) {
  const [isInspecting, setIsInspecting] = useState(false);

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[11px] text-primary">
          {prLabel(diff.repoFullName, diff.prNumber)}
        </p>
        <Badge className="border-primary text-primary">{diff.status}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">
        {diff.summary}
      </p>
      <p className="mt-1 truncate font-mono text-[10px] text-muted">
        {diff.localPath}
      </p>
      <div className="mt-1.5 flex justify-end gap-1.5 font-mono text-[10px]">
        <Button
          className="min-h-[24px] px-2 py-0 font-mono text-[10px]"
          onClick={() => setIsInspecting((current) => !current)}
          type="button"
        >
          {isInspecting ? 'hide diff' : 'inspect diff'}
        </Button>
        <SessionReferenceButton
          kind="task"
          label="session"
          linkedRepoId={diff.repoId}
          linkedTaskId={diff.id}
          summary={`${diff.title}: ${diff.summary}. Prepared diff ${diff.status} in ${diff.localPath}.`}
          title={`Prepared ${diff.title}`}
          uiMetadata={{
            source: 'autopilot-prepared-diff',
            preparedDiffId: diff.id,
            repoFullName: diff.repoFullName,
            prNumber: diff.prNumber,
            worktreeId: diff.worktreeId,
            status: diff.status,
          }}
        />
      </div>
      {isInspecting ? (
        <div className="mt-2">
          <Suspense fallback={<MiniEmpty label="Loading diff viewer." />}>
            <PreparedDiffReview diff={diff} />
          </Suspense>
        </div>
      ) : null}
      <PreparedDiffRecoveryControls preparedDiffId={diff.id} />
    </article>
  );
}

function PreparedDiffRecoveryControls({
  preparedDiffId,
}: {
  preparedDiffId: string;
}) {
  const [confirmAction, setConfirmAction] = useState<AutopilotRecoveryOption>();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['autopilot-recovery-options', preparedDiffId],
    queryFn: () => getAutopilotRecoveryOptions(preparedDiffId),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: runAutopilotRecovery,
    onSuccess() {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
      void queryClient.invalidateQueries({
        queryKey: ['autopilot-recovery-options', preparedDiffId],
      });
    },
  });
  const options = (data?.options ?? []).filter((option) =>
    visibleRecoveryAction(option.id),
  );
  if (options.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {options.map((option) => (
        <Button
          className="px-2 py-1 font-mono text-[10px]"
          disabled={mutation.isPending}
          key={option.id}
          onClick={() => {
            if (option.id === 'cleanup-worktree') {
              setConfirmAction(option);
              return;
            }
            mutation.mutate({ preparedDiffId, recoveryAction: option.id });
          }}
          title={option.description}
          type="button"
        >
          {recoveryButtonLabel(option.id)}
        </Button>
      ))}
      {mutation.data ? (
        <p className="basis-full text-[10px] leading-4 text-muted">
          {mutation.data.message}
        </p>
      ) : null}
      {mutation.error ? (
        <p className="basis-full text-[10px] leading-4 text-accent">
          {queryErrorMessage(mutation.error)}
        </p>
      ) : null}
      {confirmAction ? (
        <div className="basis-full border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <div className="flex items-center justify-between gap-2">
            <span className="text-accent">Clean up this worktree?</span>
            <span className="flex gap-1.5">
              <Button
                className="min-h-[24px] border-accent bg-transparent px-1.5 py-0 text-[10px] text-accent"
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.mutate({
                    preparedDiffId,
                    recoveryAction: confirmAction.id,
                    confirm: true,
                  });
                  setConfirmAction(undefined);
                }}
                type="button"
              >
                confirm
              </Button>
              <Button
                className="min-h-[24px] bg-transparent px-1.5 py-0 text-[10px]"
                disabled={mutation.isPending}
                onClick={() => setConfirmAction(undefined)}
                type="button"
              >
                cancel
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function visibleRecoveryAction(id: AutopilotRecoveryActionId) {
  return [
    'inspect-worktree',
    'retry-after-new-commit',
    'rebase-resync-worktree',
    'retry-verify',
    'retry-push',
    'retry-comment',
    'cleanup-worktree',
  ].includes(id);
}

function recoveryButtonLabel(id: AutopilotRecoveryActionId) {
  if (id === 'inspect-worktree') return 'inspect';
  if (id === 'retry-after-new-commit') return 'new commit';
  if (id === 'rebase-resync-worktree') return 'resync';
  if (id === 'retry-verify') return 'verify';
  if (id === 'retry-push') return 'push';
  if (id === 'retry-comment') return 'comment';
  if (id === 'cleanup-worktree') return 'cleanup';
  return id;
}

function ApprovalRow({ approval }: { approval: AutopilotApproval }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      resolveAutopilotApproval(approval.id, decision),
    onSuccess() {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.executionApprovals,
      });
    },
  });

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[11px] text-primary">
          {approval.repoFullName
            ? prLabel(approval.repoFullName, approval.prNumber)
            : 'autopilot approval'}
        </p>
        <Badge className="border-accent text-accent">{approval.risk}</Badge>
      </div>
      <p className="mt-1 line-clamp-1 font-mono text-[10px] text-muted">
        {approval.command}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span>{approval.source}</span>
        <span className="flex gap-1.5">
          <Button
            className="min-h-[28px] border-primary bg-transparent px-2 py-1 text-[10px] text-primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('approve')}
            type="button"
          >
            approve
          </Button>
          <Button
            className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('deny')}
            type="button"
          >
            {approval.source === 'prepared-diff' ? 'revise' : 'deny'}
          </Button>
        </span>
      </div>
      {mutation.error ? (
        <p className="mt-1 text-[10px] leading-4 text-accent">
          {queryErrorMessage(mutation.error)}
        </p>
      ) : null}
    </article>
  );
}

function PolicyBlock({
  repoPolicies,
  state,
  watchPolicies,
}: {
  repoPolicies: AutopilotRepoPolicy[];
  state: AutopilotState;
  watchPolicies: AutopilotWatchPolicy[];
}) {
  return (
    <section className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
            POLICY
          </p>
          <p className="mt-1 text-[12px] text-ink">
            {state.modeLabels[state.policies.global.mode]}
          </p>
        </div>
        <Badge>{state.policies.global.limits.maxFilesChanged} files</Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
        {repoPolicies.map((policy) => (
          <PolicyPill
            key={policy.repoId}
            label={policy.repoFullName}
            mode={policy.mode}
          />
        ))}
        {watchPolicies.map((policy) => (
          <PolicyPill
            key={policy.watchId}
            label={`${policy.repoFullName}#${policy.prNumber}`}
            mode={policy.mode}
          />
        ))}
      </div>
    </section>
  );
}

function PolicyPill({ label, mode }: { label: string; mode: string }) {
  return (
    <div className="min-w-0 border border-line bg-panel px-2 py-1">
      <p className="truncate font-mono text-[10px] text-primary">{label}</p>
      <p className="mt-0.5 truncate text-[10px] text-muted">{mode}</p>
    </div>
  );
}

function CheckRow({
  check,
}: {
  check: AutopilotState['runningChecks'][number];
}) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[11px] text-primary">
          {check.workflow}
        </p>
        <Badge className="border-primary text-primary">running</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">
        {check.lastMessage}
      </p>
    </article>
  );
}

function ActivityRow({ item }: { item: AutopilotActivity }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[11px] text-primary">
          {item.repoFullName
            ? prLabel(item.repoFullName, item.prNumber)
            : item.title}
        </p>
        <Badge
          className={
            item.level === 'attention' ? 'border-accent text-accent' : ''
          }
        >
          {item.type}
        </Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">
        {item.message}
      </p>
      <div className="mt-1.5 flex justify-end font-mono text-[10px]">
        <SessionReferenceButton
          kind="task"
          label="session"
          linkedRepoId={item.repoId}
          linkedTaskId={item.id}
          summary={`${item.title}: ${item.message}`}
          title={`Activity ${item.title}`}
          uiMetadata={{
            source: 'autopilot-activity',
            activityId: item.id,
            type: item.type,
            repoFullName: item.repoFullName,
            prNumber: item.prNumber,
            level: item.level,
          }}
        />
      </div>
    </article>
  );
}

function priorityClass(priority: string) {
  if (priority === 'urgent' || priority === 'high') {
    return 'border-accent text-accent';
  }
  if (priority === 'normal') return 'border-primary text-primary';
  return '';
}

function prLabel(repo: string, prNumber: number | null) {
  return prNumber ? `${repo}#${prNumber}` : repo;
}
