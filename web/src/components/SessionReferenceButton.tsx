import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  createChatSession,
  getChatSessions,
  restoreChatSession,
  switchChatSession,
  type ChatSessionListResponse,
  type ChatSessionKind,
  type ChatSessionRecord,
} from '../api';
import { queryKeys } from '../lib/query';

type SessionReferenceButtonProps = {
  title: string;
  kind: ChatSessionKind;
  linkedRepoId?: string | null;
  linkedWatchId?: string | null;
  linkedTaskId?: string | null;
  summary?: string | null;
  uiMetadata?: unknown;
  label?: string;
  className?: string;
};

export function SessionReferenceButton({
  title,
  kind,
  linkedRepoId,
  linkedWatchId,
  linkedTaskId,
  summary,
  uiMetadata,
  label = 'session',
  className = 'shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary disabled:opacity-50',
}: SessionReferenceButtonProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    async mutationFn() {
      const existing = await findExistingLinkedSession(queryClient, {
        kind,
        linkedRepoId,
        linkedWatchId,
        linkedTaskId,
      });
      if (existing) {
        if (existing.archivedAt) {
          const restored = await restoreChatSession(existing.id);
          if (!restored.ok) throw new Error(restored.message);
        }
        const switched = await switchChatSession(existing.id);
        if (!switched.ok) throw new Error(switched.message);
        return switched;
      }

      const result = await createChatSession({
        title,
        kind,
        activate: true,
        surface: 'dashboard',
        linkedRepoId,
        linkedWatchId,
        linkedTaskId,
        summary,
        summarySource: summary ? 'metadata' : undefined,
        uiMetadata,
        reason: 'dashboard-reference-row',
      });
      if (!result.ok || !result.session) throw new Error(result.message);
      if (!result.state) {
        await switchChatSession(result.session.id);
      }
      return result;
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.neonSession });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions });
    },
  });

  return (
    <button
      className={className}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title="Open a linked chat session for this row"
      type="button"
    >
      {mutation.isPending ? 'opening' : label}
    </button>
  );
}

async function findExistingLinkedSession(
  queryClient: QueryClient,
  input: {
    kind: ChatSessionKind;
    linkedRepoId?: string | null;
    linkedWatchId?: string | null;
    linkedTaskId?: string | null;
  },
) {
  const cached = queryClient.getQueryData<ChatSessionListResponse>(
    queryKeys.chatSessions,
  );
  const sessions =
    cached?.sessions ??
    (await getChatSessions({ includeArchived: true })).sessions;

  return sessions.find((session) => matchesLinkedSession(session, input));
}

function matchesLinkedSession(
  session: ChatSessionRecord,
  input: {
    kind: ChatSessionKind;
    linkedRepoId?: string | null;
    linkedWatchId?: string | null;
    linkedTaskId?: string | null;
  },
) {
  if (session.kind !== input.kind) return false;
  if (input.linkedTaskId) return session.linkedTaskId === input.linkedTaskId;
  if (input.linkedWatchId) return session.linkedWatchId === input.linkedWatchId;
  if (input.linkedRepoId) {
    return (
      session.linkedRepoId === input.linkedRepoId &&
      !session.linkedTaskId &&
      !session.linkedWatchId
    );
  }
  return false;
}
