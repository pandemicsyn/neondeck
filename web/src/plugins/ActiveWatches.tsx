import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  getPrWatches,
  configurePrAutopilot,
  controlPrAutopilot,
  type PrWatch,
} from '../api';
import { Badge, Button, ScrollArea } from '../components/ui';
import { FlueChatSessionView } from '../features/flue-chat/components/session-view';
import { configEventTouchesFile, useConfigEvents } from '../lib/config-events';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import {
  isCompletedPrWatch,
  prWatchAttentionReason,
} from '../lib/watch-status';
import type { DisplayPlugin } from '../types';
import { WorktreeDiffReview } from '../features/diff-viewer/surfaces';
import { parsePositiveIntegerConfig } from './config';

type ActiveWatchesConfig = {
  limit: number;
};

const activeWatchesDefaultConfig = {
  limit: 8,
};

export const ActiveWatchesPlugin = {
  id: 'active-watches',
  title: 'Active watches',
  kind: 'data',
  defaultConfig: activeWatchesDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(activeWatchesDefaultConfig, config),
  Component({ config }) {
    const queryClient = useQueryClient();
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.prWatches,
      queryFn: getPrWatches,
      refetchInterval: 30_000,
    });

    useConfigEvents((event) => {
      if (
        event.action === 'config_reload' ||
        configEventTouchesFile(event, 'repos.json')
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      }
    });

    const watches = activePrWatches(data?.watches ?? []);
    const visible = watches.slice(0, config.limit);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="text-primary">WATCHES</span>
          <Badge>{watches.length}</Badge>
        </header>
        <ScrollArea className="flex-1">
          <div className="space-y-2 p-3">
            {isLoading ? (
              <WatchState
                title="Loading watches"
                detail="Reading runtime state."
              />
            ) : error ? (
              <WatchState
                title="Watch API failed"
                detail={queryErrorMessage(error)}
              />
            ) : visible.length === 0 ? (
              <WatchState
                title="No active watches"
                detail="PR watches will appear here after they are created."
              />
            ) : (
              visible.map((watch) => <WatchRow key={watch.id} watch={watch} />)
            )}
          </div>
        </ScrollArea>
      </div>
    );
  },
} satisfies DisplayPlugin<ActiveWatchesConfig>;

export function activePrWatches(watches: PrWatch[]) {
  return watches.filter((watch) => !isCompletedPrWatch(watch));
}

export function WatchRow({ watch }: { watch: PrWatch }) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [confirmingMode, setConfirmingMode] = useState<
    PrWatch['autopilotMode'] | null
  >(null);
  const [reviewingDiff, setReviewingDiff] = useState(false);
  const [reviewingOwner, setReviewingOwner] = useState(false);
  const queryClient = useQueryClient();
  const stopMutation = useMutation({
    mutationFn: () => controlPrAutopilot(watch.id, 'stop'),
    onSuccess() {
      setConfirmingStop(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const pollingEnabled = watch.pollingEnabled !== false;
  const pollingMutation = useMutation({
    mutationFn: () =>
      controlPrAutopilot(watch.id, pollingEnabled ? 'pause' : 'resume'),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
    },
  });
  const checkedLabel = watch.lastCheckedAt
    ? `checked ${relativeTime(watch.lastCheckedAt)}`
    : 'not checked';
  const nextPollLabel = !pollingEnabled
    ? 'polling paused'
    : watch.nextRunAt
      ? `next ${relativeTime(watch.nextRunAt)}`
      : 'next poll pending';
  const sourceLabel = watch.createdBy ? ` · ${watch.createdBy}` : '';
  const activityLabel = `activity ${relativeTime(
    watch.lastSnapshot?.updatedAt ?? watch.updatedAt,
  )}`;
  const attentionReason = prWatchAttentionReason(watch);
  const configureMutation = useMutation({
    mutationFn: (input: { mode: PrWatch['autopilotMode']; confirm: boolean }) =>
      configurePrAutopilot({
        ref: watch.id,
        mode: input.mode,
        processExisting: watch.processExisting,
        confirm: input.confirm,
      }),
    onSuccess() {
      setConfirmingMode(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const retryMutation = useMutation({
    mutationFn: () => controlPrAutopilot(watch.id, 'retry'),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
    },
  });
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-primary">
            {watch.repoFullName}#{watch.prNumber}
          </p>
          <p className="mt-1 line-clamp-2 text-[12px] leading-4 text-ink">
            {watch.title ?? 'Untitled PR'}
          </p>
          {attentionReason ? (
            <p className="mt-1 font-mono text-[10px] leading-4 text-accent">
              why · {attentionReason}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge className={statusClass(watch.status)}>{watch.status}</Badge>
          {watch.autopilotStatus !== 'watching' ? (
            <Badge className={autopilotStatusClass(watch.autopilotStatus)}>
              {watch.autopilotStatus}
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-2 font-mono text-[10px] leading-4 text-muted">
        {autopilotModeHelp(watch.autopilotMode)}
      </p>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span>mode</span>
        <select
          aria-label={`Autopilot mode for ${watch.id}`}
          className="min-h-[28px] min-w-0 flex-1 border border-line bg-field px-2 text-[10px] text-ink"
          disabled={configureMutation.isPending}
          onChange={(event) => {
            const mode = event.target.value as PrWatch['autopilotMode'];
            if (
              autopilotModeRank(mode) > autopilotModeRank(watch.autopilotMode)
            ) {
              setConfirmingMode(mode);
              return;
            }
            setConfirmingMode(null);
            configureMutation.mutate({ mode, confirm: false });
          }}
          value={watch.autopilotMode}
        >
          <option value="notify-only">Notify only · no coding</option>
          <option value="prepare-only">Prepare commit · never push</option>
          <option value="autofix-with-approval">
            Prepare commit · push after approval
          </option>
          <option value="autofix-push-when-safe">
            Autonomous judgment + delivery
          </option>
        </select>
      </div>
      {confirmingMode ? (
        <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <p className="text-accent">
            Increase Autopilot authority to {confirmingMode}?
          </p>
          <p className="mt-1 leading-4">{autopilotModeHelp(confirmingMode)}</p>
          <span className="mt-1.5 flex gap-1.5">
            <Button
              className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
              disabled={configureMutation.isPending}
              onClick={() =>
                configureMutation.mutate({
                  mode: confirmingMode,
                  confirm: true,
                })
              }
              type="button"
            >
              confirm increase
            </Button>
            <Button
              className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
              disabled={configureMutation.isPending}
              onClick={() => setConfirmingMode(null)}
              type="button"
            >
              cancel
            </Button>
          </span>
          {configureMutation.error ? (
            <p className="mt-1 text-accent">
              {queryErrorMessage(configureMutation.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 truncate">
          until {watch.desiredTerminalState} · {checkedLabel} · {nextPollLabel}
          {' · '}
          {activityLabel}
          {sourceLabel}
        </span>
        <span className="flex shrink-0 gap-1.5">
          {watch.ownerInstanceId ? (
            <Button
              aria-label={`Review owner agent for ${watch.repoFullName} pull request ${watch.prNumber}`}
              className="min-h-[28px] border-primary bg-transparent px-2 py-1 text-[10px] text-primary"
              onClick={() => setReviewingOwner((current) => !current)}
              title={`Open continuing owner ${watch.ownerInstanceId}`}
              type="button"
            >
              {reviewingOwner ? 'hide agent' : 'review agent'}
            </Button>
          ) : null}
          {watch.url ? (
            <Button
              className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted"
              onClick={() =>
                window.open(
                  watch.url ?? undefined,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
              type="button"
            >
              open
            </Button>
          ) : null}
          <Button
            className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted"
            disabled={pollingMutation.isPending}
            onClick={() => pollingMutation.mutate()}
            title={
              pollingMutation.error
                ? queryErrorMessage(pollingMutation.error)
                : undefined
            }
            type="button"
          >
            {pollingMutation.isPending
              ? pollingEnabled
                ? 'pausing'
                : 'resuming'
              : pollingEnabled
                ? 'pause'
                : 'resume'}
          </Button>
          {watch.autopilotStatus === 'blocked' ? (
            <Button
              className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate()}
              type="button"
            >
              {retryMutation.isPending ? 'retrying' : 'retry'}
            </Button>
          ) : null}
          {watch.worktreeId && watch.worktreeHeadSha ? (
            <Button
              className="min-h-[28px] border-primary bg-transparent px-2 py-1 text-[10px] text-primary"
              onClick={() => setReviewingDiff((current) => !current)}
              type="button"
            >
              {reviewingDiff ? 'hide diff' : 'review diff'}
            </Button>
          ) : null}
          <Button
            className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-accent"
            disabled={stopMutation.isPending || pollingMutation.isPending}
            onClick={() => setConfirmingStop(true)}
            type="button"
          >
            stop
          </Button>
        </span>
      </div>
      {confirmingStop ? (
        <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <div className="flex items-center justify-between gap-2">
            <span className="text-accent">Stop this Autopilot watch?</span>
            <span className="flex gap-1.5">
              <Button
                className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
                disabled={stopMutation.isPending}
                onClick={() => stopMutation.mutate()}
                type="button"
              >
                confirm
              </Button>
              <Button
                className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
                disabled={stopMutation.isPending}
                onClick={() => setConfirmingStop(false)}
                type="button"
              >
                cancel
              </Button>
            </span>
          </div>
          {stopMutation.error ? (
            <p className="mt-1 text-accent">
              {queryErrorMessage(stopMutation.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {reviewingDiff && watch.worktreeId && watch.worktreeHeadSha ? (
        <div className="mt-2 max-h-[32rem] overflow-auto border border-line bg-field">
          <WorktreeDiffReview
            base={watch.worktreeHeadSha}
            detail={`${watch.autopilotMode} · ${watch.autopilotStatus}`}
            repoId={watch.repoId}
            title={`${watch.repoFullName}#${watch.prNumber} Autopilot change`}
            worktreeId={watch.worktreeId}
          />
        </div>
      ) : null}
      {reviewingOwner && watch.ownerInstanceId ? (
        <div className="mt-2 h-[28rem] min-h-0 overflow-hidden border border-line bg-field">
          <FlueChatSessionView
            activeRecord={undefined}
            agentName="pr-autopilot-owner"
            allowCommands={false}
            key={`pr-autopilot-owner:${watch.ownerInstanceId}`}
            messageEnabled={
              watch.autopilotMode === 'autofix-with-approval' &&
              watch.autopilotStatus === 'waiting'
            }
            messageLabel={`Message owner for ${watch.repoFullName} pull request ${watch.prNumber}`}
            quickCommands={[]}
            session={{
              id: watch.ownerInstanceId,
              label: `PR owner ${watch.prNumber}`,
              placeholder:
                watch.autopilotMode === 'autofix-with-approval' &&
                watch.autopilotStatus === 'waiting'
                  ? 'approved, push — or ask for one more focused edit'
                  : 'Owner messages are available while approval mode is waiting.',
            }}
            sessionState={undefined}
          />
        </div>
      ) : null}
    </article>
  );
}

function WatchState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-32 flex-col items-center justify-center text-center">
      <div className="miami-accent mb-2 h-1 w-10" />
      <p className="text-[12px] font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-[24ch] text-[11px] leading-4 text-muted">
        {detail}
      </p>
    </div>
  );
}

function statusClass(status: string) {
  if (status === 'green') return 'border-primary text-primary';
  if (status === 'attention-needed') return 'border-accent text-accent';
  if (status === 'closed' || status === 'merged')
    return 'border-line text-muted';
  return '';
}

function autopilotStatusClass(status: PrWatch['autopilotStatus']) {
  if (status === 'blocked') return 'border-accent text-accent';
  if (status === 'working' || status === 'waiting')
    return 'border-warn text-warn';
  if (status === 'complete') return 'border-primary text-primary';
  return 'border-line text-muted';
}

function autopilotModeRank(mode: PrWatch['autopilotMode']) {
  return [
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ].indexOf(mode);
}

function autopilotModeHelp(mode: PrWatch['autopilotMode']) {
  switch (mode) {
    case 'notify-only':
      return 'Reports meaningful changes without starting a coding turn.';
    case 'prepare-only':
      return 'Codes, validates, and commits locally for your review; it cannot push or respond to the PR.';
    case 'autofix-with-approval':
      return 'Does the same work, then waits; only your direct instruction in the owner chat can authorize it to push or respond.';
    case 'autofix-push-when-safe':
      return 'Delegates semantic engineering judgment: the owner validates proportionately and may push/respond when it judges the change sound.';
  }
}
