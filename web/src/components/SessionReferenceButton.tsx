import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createChatSession, type ChatSessionKind } from '../api';
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
  className = 'inline-flex min-h-[28px] shrink-0 items-center border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary disabled:opacity-50',
}: SessionReferenceButtonProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    async mutationFn() {
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
      return result;
    },
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.neonSession });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions });
      window.dispatchEvent(
        new CustomEvent('neondeck:focus-chat', {
          detail: { pluginId: 'flue-chat' },
        }),
      );
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
