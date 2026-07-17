import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  getBriefingState,
  rotateBriefingSession,
  runBriefing,
  switchChatSession,
  updateBriefingProfile,
} from '../api';
import {
  Badge,
  Button,
  EmptyState,
  ScrollArea,
  Textarea,
} from '../components/ui';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type BriefingPanelConfig = { actionLimit: number };
const defaultConfig = { actionLimit: 5 };

export const BriefingPanelPlugin = {
  id: 'briefing-panel',
  title: 'Briefing',
  kind: 'data',
  defaultConfig,
  parseConfig: (config) => parsePositiveIntegerConfig(defaultConfig, config),
  Component() {
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);
    const [instructions, setInstructions] = useState('');
    const [schedule, setSchedule] = useState('');
    const [timezone, setTimezone] = useState('');
    const [enabled, setEnabled] = useState(true);
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.briefings,
      queryFn: getBriefingState,
      refetchInterval: 10_000,
    });

    useEffect(() => {
      if (!data?.profile || editing) return;
      setInstructions(data.profile.instructions);
      setSchedule(data.profile.schedule);
      setTimezone(data.profile.timezone);
      setEnabled(data.profile.enabled);
    }, [data?.profile, editing]);

    const saveMutation = useMutation({
      mutationFn: () =>
        updateBriefingProfile({ instructions, schedule, timezone, enabled }),
      async onSuccess(result) {
        if (!result.ok) throw new Error(result.message);
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: queryKeys.briefings });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.scheduledTasks,
        });
      },
    });
    const runMutation = useMutation({
      mutationFn: () =>
        runBriefing({ profileId: 'morning', trigger: 'dashboard' }),
      async onSuccess(result) {
        if (!result.ok) throw new Error(result.message);
        await queryClient.invalidateQueries({ queryKey: queryKeys.briefings });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
      },
    });
    const openMutation = useMutation({
      async mutationFn() {
        const sessionId = data?.profile.sessionId ?? data?.latestRun?.sessionId;
        if (!sessionId)
          throw new Error('Run the briefing once to create its conversation.');
        return switchChatSession(sessionId);
      },
      onSuccess(result) {
        if (!result.ok) throw new Error(result.message);
        if (result.state) {
          queryClient.setQueryData(queryKeys.neonSession, result.state);
        }
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
        focusChatPanel();
      },
    });
    const rotateMutation = useMutation({
      mutationFn: () => rotateBriefingSession(),
      async onSuccess(result) {
        if (!result.ok) throw new Error(result.message);
        await queryClient.invalidateQueries({ queryKey: queryKeys.briefings });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
      },
    });

    if (isLoading) {
      return (
        <EmptyState
          title="Briefing loading"
          detail="Reading profile and run state."
        />
      );
    }
    if (error || !data) {
      return (
        <EmptyState
          title="Briefing unavailable"
          detail={queryErrorMessage(error ?? 'No briefing state returned.')}
          tone="alert"
        />
      );
    }

    const latest = data.latestRun;
    const mutationError =
      saveMutation.error ??
      runMutation.error ??
      openMutation.error ??
      rotateMutation.error;
    const briefingStale = data.sessionStaleReasons.length > 0;

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="text-primary">MORNING BRIEFING</span>
          <div className="flex items-center gap-1.5">
            {data.unreadCount > 0 ? (
              <Badge className="border-primary text-primary">
                {data.unreadCount} unread
              </Badge>
            ) : null}
            <Badge>
              {latest?.status ??
                (data.profile.enabled ? 'scheduled' : 'paused')}
            </Badge>
          </div>
        </header>
        <ScrollArea className="flex-1">
          <div className="space-y-3 p-3">
            <div className="flex items-start justify-between gap-3 border-b border-line pb-2.5">
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-ink">
                  {data.profile.name}
                </p>
                <p className="mt-1 text-[10.5px] leading-4 text-muted">
                  {data.profile.enabled
                    ? `${data.profile.schedule} · ${data.profile.timezone}`
                    : 'Automatic runs are paused.'}
                </p>
                <p className="mt-1 text-[10.5px] leading-4 text-muted">
                  {latest
                    ? `${latest.status} · ${relativeTime(latest.updatedAt)}`
                    : 'No conversational briefing has run yet.'}
                </p>
              </div>
              {latest ? <Badge>{latest.trigger}</Badge> : null}
            </div>

            {editing ? (
              <form
                className="max-w-[75ch] space-y-2.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveMutation.mutate();
                }}
              >
                <label
                  className="block font-mono text-[10px] text-muted"
                  htmlFor="briefing-instructions"
                >
                  Instructions
                  <Textarea
                    id="briefing-instructions"
                    className="mt-1 min-h-24 w-full border border-line bg-field px-2 py-1.5 font-sans text-[11px] leading-4 text-ink"
                    onChange={(event) => setInstructions(event.target.value)}
                    value={instructions}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label
                    className="font-mono text-[10px] text-muted"
                    htmlFor="briefing-schedule"
                  >
                    Cron schedule
                    <input
                      id="briefing-schedule"
                      className="mt-1 h-7 w-full border border-line bg-field px-2 text-[11px] text-ink outline-none focus:border-primary"
                      onChange={(event) => setSchedule(event.target.value)}
                      value={schedule}
                    />
                  </label>
                  <label
                    className="font-mono text-[10px] text-muted"
                    htmlFor="briefing-timezone"
                  >
                    Timezone
                    <input
                      id="briefing-timezone"
                      className="mt-1 h-7 w-full border border-line bg-field px-2 text-[11px] text-ink outline-none focus:border-primary"
                      onChange={(event) => setTimezone(event.target.value)}
                      value={timezone}
                    />
                  </label>
                </div>
                <label className="flex items-center gap-2 font-mono text-[10px] text-muted">
                  <input
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  Run automatically
                </label>
                <div className="flex gap-2">
                  <Button disabled={saveMutation.isPending} type="submit">
                    {saveMutation.isPending ? 'saving' : 'save'}
                  </Button>
                  <Button onClick={() => setEditing(false)} type="button">
                    cancel
                  </Button>
                </div>
              </form>
            ) : (
              <p className="max-w-[75ch] whitespace-normal break-words text-[11px] leading-[1.55] text-muted">
                {data.profile.instructions}
              </p>
            )}

            {mutationError ? (
              <p className="border border-accent/60 px-2 py-1.5 text-[10.5px] leading-4 text-accent">
                {queryErrorMessage(mutationError)}
              </p>
            ) : null}

            {briefingStale ? (
              <div className="border border-accent/60 px-2 py-1.5 text-[10.5px] leading-4 text-accent">
                <p>{data.sessionStaleReasons[0]?.message}</p>
                <Button
                  className="mt-2"
                  disabled={rotateMutation.isPending}
                  onClick={() => rotateMutation.mutate()}
                  type="button"
                >
                  {rotateMutation.isPending
                    ? 'starting fresh'
                    : 'start fresh conversation'}
                </Button>
              </div>
            ) : null}

            {!editing ? (
              <div className="flex flex-wrap gap-2 border-t border-line pt-2.5">
                <Button
                  disabled={
                    openMutation.isPending ||
                    (!data.profile.sessionId && !latest)
                  }
                  onClick={() => openMutation.mutate()}
                  type="button"
                >
                  open conversation
                </Button>
                <Button
                  disabled={runMutation.isPending || briefingStale}
                  onClick={() => runMutation.mutate()}
                  type="button"
                >
                  {runMutation.isPending ? 'queueing' : 'run now'}
                </Button>
                <Button onClick={() => setEditing(true)} type="button">
                  edit instructions
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    );
  },
} satisfies DisplayPlugin<BriefingPanelConfig>;

function focusChatPanel() {
  window.dispatchEvent(
    new CustomEvent('neondeck:focus-chat', {
      detail: { pluginId: 'flue-chat' },
    }),
  );
}
