import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  controlAutopilotWatch,
  getAutopilotState,
  getPrWatches,
  type PrWatch,
} from '../api';
import { SessionReferenceButton } from '../components/SessionReferenceButton';
import { Badge, Button, ScrollArea } from '../components/ui';
import { configEventTouchesFile, useConfigEvents } from '../lib/config-events';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import { prWatchAttentionReason } from '../lib/watch-status';
import type { DisplayPlugin } from '../types';
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
    const { data: autopilot } = useQuery({
      queryKey: queryKeys.autopilotState,
      queryFn: getAutopilotState,
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

    const watches = data?.watches ?? [];
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
              visible.map((watch) => (
                <WatchRow
                  admission={autopilot?.queue.find(
                    (item) =>
                      item.source === 'admission' && item.watchId === watch.id,
                  )}
                  key={watch.id}
                  mode={
                    autopilot?.policies.watches.find(
                      (policy) => policy.watchId === watch.id,
                    )?.mode
                  }
                  watch={watch}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    );
  },
} satisfies DisplayPlugin<ActiveWatchesConfig>;

function WatchRow({
  watch,
  mode,
  admission,
}: {
  watch: PrWatch;
  mode: string | undefined;
  admission: { id: string; status: string; updatedAt: string } | undefined;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const queryClient = useQueryClient();
  const removeMutation = useMutation({
    mutationFn: () =>
      controlAutopilotWatch({
        operation: 'stop',
        watchId: watch.id,
        confirm: true,
      }),
    onSuccess() {
      setConfirmingRemove(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const pollingEnabled = watch.pollingEnabled !== false;
  const pollingMutation = useMutation({
    mutationFn: () =>
      controlAutopilotWatch({
        operation: pollingEnabled ? 'pause' : 'resume',
        watchId: watch.id,
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
    },
  });
  const retryMutation = useMutation({
    mutationFn: () =>
      controlAutopilotWatch({
        operation: 'retry',
        watchId: watch.id,
        ...(admission ? { admissionId: admission.id } : {}),
      }),
    onSuccess() {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
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
  const attentionReason = prWatchAttentionReason(watch);

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
          <p className="mt-1 font-mono text-[10px] text-muted">
            autopilot · {mode ?? 'notify-only'}
            {admission
              ? ` · ${admission.status} · updated ${relativeTime(admission.updatedAt)}`
              : ' · awaiting event'}
          </p>
        </div>
        <Badge className={statusClass(watch.status)}>{watch.status}</Badge>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 truncate">
          until {watch.desiredTerminalState} · {checkedLabel} · {nextPollLabel}
          {sourceLabel}
        </span>
        <span className="flex shrink-0 gap-1.5">
          <SessionReferenceButton
            kind="watch"
            linkedRepoId={watch.repoId}
            linkedWatchId={watch.id}
            summary={`${watch.repoFullName}#${watch.prNumber} watch is ${watch.status} until ${watch.desiredTerminalState}. ${watch.title ?? 'Untitled PR'}.`}
            title={`Watch ${watch.repoFullName}#${watch.prNumber}`}
            uiMetadata={{
              source: 'pr-watch',
              repoFullName: watch.repoFullName,
              prNumber: watch.prNumber,
              status: watch.status,
              desiredTerminalState: watch.desiredTerminalState,
              url: watch.url,
            }}
          />
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
          <Button
            className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-accent"
            disabled={removeMutation.isPending || pollingMutation.isPending}
            onClick={() => setConfirmingRemove(true)}
            type="button"
          >
            stop
          </Button>
          {admission ? (
            <Button
              className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate()}
              type="button"
            >
              {retryMutation.isPending ? 'retrying' : 'retry'}
            </Button>
          ) : null}
        </span>
      </div>
      {confirmingRemove ? (
        <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <div className="flex items-center justify-between gap-2">
            <span className="text-accent">
              Stop this watch and active Autopilot work?
            </span>
            <span className="flex gap-1.5">
              <Button
                className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
                type="button"
              >
                confirm
              </Button>
              <Button
                className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
                disabled={removeMutation.isPending}
                onClick={() => setConfirmingRemove(false)}
                type="button"
              >
                cancel
              </Button>
            </span>
          </div>
          {removeMutation.error ? (
            <p className="mt-1 text-accent">
              {queryErrorMessage(removeMutation.error)}
            </p>
          ) : null}
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
