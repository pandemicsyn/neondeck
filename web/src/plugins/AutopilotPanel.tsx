import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  getAutopilotState,
  type AutopilotActivity,
  type AutopilotApproval,
  type AutopilotPreparedDiff,
  type AutopilotQueueItem,
  type AutopilotRepoPolicy,
  type AutopilotState,
  type AutopilotWatchPolicy,
} from '../api';
import { EmptyState } from '../App';
import { Badge, ScrollArea } from '../components/ui';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

type AutopilotPanelConfig = {
  queueLimit: number;
  policyLimit: number;
  preparedLimit: number;
  approvalLimit: number;
  checkLimit: number;
  activityLimit: number;
};

export const AutopilotPanelPlugin = {
  id: 'autopilot',
  title: 'Autopilot',
  kind: 'data',
  defaultConfig: {
    queueLimit: 8,
    policyLimit: 6,
    preparedLimit: 4,
    approvalLimit: 4,
    checkLimit: 4,
    activityLimit: 8,
  },
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
        <span className="shrink-0">{item.mode}</span>
      </div>
    </article>
  );
}

function PreparedDiffRow({ diff }: { diff: AutopilotPreparedDiff }) {
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
    </article>
  );
}

function ApprovalRow({ approval }: { approval: AutopilotApproval }) {
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
