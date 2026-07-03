import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveChatSession,
  createChatSession,
  getChatSessions,
  getNeonSession,
  pinChatSession,
  referenceChatSession,
  refreshChatSessionSummary,
  renameChatSession,
  restoreChatSession,
  switchChatSession,
  type ChatSessionRecord,
} from '../../api';
import { Button } from '../../components/ui';
import { useConfigEvents } from '../../lib/config-events';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import type { DisplayPlugin } from '../../types';
import { SessionSelect } from './components/session-select';
import { FlueChatSessionView } from './components/session-view';
import { parseFlueChatConfig } from './config';
import { flueChatDefaultConfig, type FlueChatConfig } from './types';

export const FlueChatPlugin = {
  id: 'flue-chat',
  title: 'Flue chat',
  kind: 'agent',
  defaultConfig: flueChatDefaultConfig,
  parseConfig: parseFlueChatConfig,
  Component({ config }) {
    const fallbackSession =
      (config.sessions.length > 0
        ? config.sessions
        : flueChatDefaultConfig.sessions)[0] ??
      flueChatDefaultConfig.sessions[0];
    const queryClient = useQueryClient();
    const {
      data: sessionState,
      error: sessionError,
      refetch: refreshSession,
    } = useQuery({
      queryKey: queryKeys.neonSession,
      queryFn: getNeonSession,
      refetchInterval: 30_000,
    });
    const {
      data: sessionIndex,
      error: sessionIndexError,
      refetch: refreshSessionIndex,
    } = useQuery({
      queryKey: queryKeys.chatSessions,
      queryFn: () => getChatSessions({ includeArchived: true }),
      refetchInterval: 30_000,
    });
    const startSessionMutation = useMutation({
      async mutationFn() {
        const result = await createChatSession({
          title: 'Fresh',
          surface: 'dashboard',
          activate: true,
        });
        if (!result.state) {
          throw new Error(result.message);
        }
        return result.state;
      },
      onSuccess(state) {
        queryClient.setQueryData(queryKeys.neonSession, state);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
      },
    });
    const switchSessionMutation = useMutation({
      async mutationFn(session: ChatSessionRecord) {
        const restored = session.archivedAt
          ? await restoreChatSession(session.id)
          : undefined;
        if (restored && !restored.ok) throw new Error(restored.message);
        const result = await switchChatSession(session.id);
        if (!result.state) throw new Error(result.message);
        return result.state;
      },
      onSuccess(state) {
        queryClient.setQueryData(queryKeys.neonSession, state);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
      },
    });
    const sessionMetadataMutation = useMutation({
      async mutationFn(
        input:
          | { action: 'rename'; session: ChatSessionRecord; title: string }
          | { action: 'pin'; session: ChatSessionRecord }
          | { action: 'archive'; session: ChatSessionRecord }
          | { action: 'restore'; session: ChatSessionRecord },
      ) {
        let result;
        if (input.action === 'rename') {
          result = await renameChatSession(input.session.id, input.title);
        } else if (input.action === 'pin') {
          result = await pinChatSession(
            input.session.id,
            !input.session.pinned,
          );
        } else if (input.action === 'restore') {
          result = await restoreChatSession(input.session.id);
        } else {
          result = await archiveChatSession(input.session.id);
        }
        if (!result.ok) throw new Error(result.message);
        return result;
      },
      onSuccess(result) {
        if (result.state) {
          queryClient.setQueryData(queryKeys.neonSession, result.state);
        }
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.neonSession,
        });
      },
    });
    const referenceMutation = useMutation({
      async mutationFn(session: ChatSessionRecord) {
        if (session.summaryStatus !== 'fresh') {
          const refreshed = await refreshChatSessionSummary(session.id, {
            surface: 'dashboard',
            reason: 'dashboard-reference-active-session',
          });
          if (!refreshed.ok) throw new Error(refreshed.message);
        }
        const result = await referenceChatSession(session.id, {
          fromSessionId: sessionState?.activeSessionId,
          surface: 'dashboard',
          reason: 'dashboard-reference-active-session',
        });
        if (!result.ok) throw new Error(result.message);
        return result;
      },
      onSuccess() {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessions,
        });
      },
    });
    const sessions = sessionIndex?.sessions ?? sessionState?.sessions ?? [];
    const activeRecord =
      sessions.find(
        (session) => session.id === sessionState?.activeSessionId,
      ) ?? sessionState?.activeChatSession;
    const activeSession = sessionState
      ? {
          id: sessionState.activeSessionId,
          label: activeRecord?.title ?? sessionState.activeSession.label,
          placeholder: fallbackSession.placeholder,
        }
      : undefined;

    function startFreshSession() {
      startSessionMutation.mutate();
    }

    function switchToSession(id: string) {
      const session = sessions.find((item) => item.id === id);
      if (!session || session.id === activeSession?.id) return;
      switchSessionMutation.mutate(session);
    }

    function renameActiveSession() {
      if (!activeRecord) return;
      const title = window.prompt('Session title', activeRecord.title)?.trim();
      if (!title || title === activeRecord.title) return;
      sessionMetadataMutation.mutate({
        action: 'rename',
        session: activeRecord,
        title,
      });
    }

    useConfigEvents(() => {
      void refreshSession();
      void refreshSessionIndex();
    });

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-4 font-mono text-[11px] tracking-[0.14em]">
          <span className="flex items-center gap-2 text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
            FLUE AGENT · triage.ts
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <SessionSelect
              activeSessionId={activeSession?.id}
              disabled={switchSessionMutation.isPending}
              onSelect={switchToSession}
              sessions={sessions}
            />
            <Button
              className="h-5 border-transparent bg-transparent px-1.5 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={!activeRecord || sessionMetadataMutation.isPending}
              onClick={renameActiveSession}
              type="button"
            >
              Rename
            </Button>
            <Button
              className="h-5 border-transparent bg-transparent px-1.5 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={!activeRecord || sessionMetadataMutation.isPending}
              onClick={() =>
                activeRecord &&
                sessionMetadataMutation.mutate({
                  action: 'pin',
                  session: activeRecord,
                })
              }
              type="button"
            >
              {activeRecord?.pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              className="h-5 border-transparent bg-transparent px-1.5 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={!activeRecord || sessionMetadataMutation.isPending}
              onClick={() =>
                activeRecord &&
                sessionMetadataMutation.mutate({
                  action: activeRecord.archivedAt ? 'restore' : 'archive',
                  session: activeRecord,
                })
              }
              type="button"
            >
              {activeRecord?.archivedAt ? 'Restore' : 'Archive'}
            </Button>
            <Button
              className="h-5 border-transparent bg-transparent px-1.5 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={!activeRecord || referenceMutation.isPending}
              onClick={() =>
                activeRecord && referenceMutation.mutate(activeRecord)
              }
              type="button"
            >
              {referenceMutation.isPending ? 'Ref...' : 'Ref'}
            </Button>
            <Button
              className="h-5 border-transparent bg-transparent px-2 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={startSessionMutation.isPending}
              onClick={() => void startFreshSession()}
              type="button"
            >
              {startSessionMutation.isPending ? 'Starting' : 'New'}
            </Button>
            <span
              className={sessionState?.stale ? 'text-accent' : 'text-muted'}
            >
              {sessionState?.stale ? 'stale ctx' : 'durable ctx'}
            </span>
          </div>
        </header>
        {sessionError ||
        sessionIndexError ||
        startSessionMutation.error ||
        switchSessionMutation.error ||
        sessionMetadataMutation.error ||
        referenceMutation.error ? (
          <div className="border-b border-accent/60 bg-soft px-4 py-1.5 text-[11px] text-accent">
            {queryErrorMessage(
              sessionError ??
                sessionIndexError ??
                startSessionMutation.error ??
                switchSessionMutation.error ??
                sessionMetadataMutation.error ??
                referenceMutation.error,
            )}
          </div>
        ) : null}
        {referenceMutation.data?.session ? (
          <div className="border-b border-line bg-soft px-4 py-1.5 text-[11px] text-muted">
            Reference ready · {referenceMutation.data.session.id} ·{' '}
            {referenceMutation.data.session.summary ??
              'summary metadata refreshed'}
          </div>
        ) : null}
        <FlueChatSessionView
          agentName={config.agentName}
          quickCommands={config.quickCommands}
          session={activeSession}
          sessionState={sessionState}
        />
      </div>
    );
  },
} satisfies DisplayPlugin<FlueChatConfig>;
