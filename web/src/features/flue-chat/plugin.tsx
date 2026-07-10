import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
    const [renameDraft, setRenameDraft] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [referenceDismissed, setReferenceDismissed] = useState(false);
    const [referenceDraft, setReferenceDraft] = useState<string>();
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
      onSuccess(result) {
        setReferenceDismissed(false);
        const summary =
          result.session?.summary ?? 'Prepared cross-session reference.';
        setReferenceDraft(
          `Use this prepared session reference as context:\n\n${summary}\n\nMy question: `,
        );
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
    const activeRecordId = activeRecord?.id;
    const activeRecordTitle = activeRecord?.title;
    const activeSession = sessionState
      ? {
          id: sessionState.activeSessionId,
          label: activeRecord?.title ?? sessionState.activeChatSession.title,
          placeholder:
            linkedContextPlaceholder(activeRecord) ??
            fallbackSession.placeholder,
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
      const title = renameDraft.trim();
      if (!title || title === activeRecord.title) return;
      sessionMetadataMutation.mutate({
        action: 'rename',
        session: activeRecord,
        title,
      });
      setRenaming(false);
    }

    useConfigEvents(() => {
      void refreshSession();
      void refreshSessionIndex();
    });

    useEffect(() => {
      if (!activeRecordTitle) return;
      setRenameDraft(activeRecordTitle);
      setRenaming(false);
    }, [activeRecordId, activeRecordTitle]);

    useEffect(() => {
      if (!referenceMutation.data?.session || referenceDismissed) return;
      const timeout = window.setTimeout(
        () => setReferenceDismissed(true),
        8_000,
      );
      return () => window.clearTimeout(timeout);
    }, [referenceDismissed, referenceMutation.data?.session]);

    const showReferenceNotice = Boolean(
      referenceMutation.data?.session && !referenceDismissed,
    );

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-4 font-mono text-[11px] tracking-[0.14em]">
          <span className="flex items-center gap-2 text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
            FLUE AGENT · {config.agentName}
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
              onClick={() => setRenaming((value) => !value)}
              type="button"
            >
              {renaming ? 'Cancel' : 'Rename'}
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
        {renaming && activeRecord ? (
          <form
            className="flex items-center gap-2 border-b border-line bg-field px-4 py-1.5 font-mono text-[10.5px]"
            onSubmit={(event) => {
              event.preventDefault();
              renameActiveSession();
            }}
          >
            <span className="text-muted">title</span>
            <input
              className="min-w-0 flex-1 border border-line bg-panel px-2 py-1 text-ink outline-none focus:border-primary"
              disabled={sessionMetadataMutation.isPending}
              onChange={(event) => setRenameDraft(event.target.value)}
              value={renameDraft}
            />
            <Button
              className="min-h-[28px] px-2 py-1 text-[10px]"
              disabled={sessionMetadataMutation.isPending}
              type="submit"
            >
              Save
            </Button>
          </form>
        ) : null}
        {activeRecord ? <LinkedContextStrip session={activeRecord} /> : null}
        {showReferenceNotice && referenceMutation.data?.session ? (
          <div className="flex items-center justify-between gap-3 border-b border-line bg-soft px-4 py-1.5 text-[11px] text-muted">
            <span className="min-w-0 truncate">
              Reference ready · {referenceMutation.data.session.id} ·{' '}
              {referenceMutation.data.session.summary ??
                'summary metadata refreshed'}
            </span>
            <Button
              className="min-h-[24px] border-transparent bg-transparent px-1.5 py-0 font-mono text-[10px] text-muted"
              onClick={() => setReferenceDismissed(true)}
              type="button"
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        <FlueChatSessionView
          activeRecord={activeRecord}
          agentName={config.agentName}
          quickCommands={config.quickCommands}
          referenceDraft={referenceDraft}
          onReferenceDraftConsumed={() => setReferenceDraft(undefined)}
          session={activeSession}
          sessionState={sessionState}
        />
      </div>
    );
  },
} satisfies DisplayPlugin<FlueChatConfig>;

function LinkedContextStrip({ session }: { session: ChatSessionRecord }) {
  const label = linkedContextLabel(session);
  if (!label) return null;

  const url = linkedContextUrl(session);
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line bg-soft px-4 py-1.5 font-mono text-[10.5px] text-muted">
      <span className="min-w-0 truncate">
        linked: <span className="text-primary">{label}</span>
      </span>
      {url ? (
        <a
          className="shrink-0 text-primary hover:text-primary-strong"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          open
        </a>
      ) : null}
    </div>
  );
}

function linkedContextPlaceholder(session: ChatSessionRecord | undefined) {
  if (!session) return undefined;
  const label = linkedContextLabel(session);
  if (!label) return undefined;
  return `Ask about ${label}...`;
}

function linkedContextLabel(session: ChatSessionRecord) {
  const metadata = objectMetadata(session.uiMetadata);
  if (metadata?.source === 'github-pr' && typeof metadata.repo === 'string') {
    return `${metadata.repo}#${metadata.prNumber}`;
  }
  if (
    metadata?.source === 'pr-watch' &&
    typeof metadata.repoFullName === 'string'
  ) {
    return `${metadata.repoFullName}#${metadata.prNumber} watch`;
  }
  if (
    typeof metadata?.repoFullName === 'string' &&
    typeof metadata.prNumber === 'number'
  ) {
    return `${metadata.repoFullName}#${metadata.prNumber}`;
  }
  if (session.linkedTaskId) return session.linkedTaskId;
  if (session.linkedWatchId) return session.linkedWatchId;
  if (session.linkedRepoId) return session.linkedRepoId;
  return undefined;
}

function linkedContextUrl(session: ChatSessionRecord) {
  const metadata = objectMetadata(session.uiMetadata);
  return typeof metadata?.url === 'string' ? metadata.url : undefined;
}

function objectMetadata(value: unknown) {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
