import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createChatSession, type ChatSessionKind } from '../api';
import { queryErrorMessage, queryKeys } from '../lib/query';

type SessionReferenceButtonProps = {
  title: string;
  kind: ChatSessionKind;
  linkedRepoId?: string | null;
  linkedWatchId?: string | null;
  linkedTaskId?: string | null;
  summary?: string | null;
  uiMetadata?: unknown;
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
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      <button
        aria-label={`Reference ${title} in chat`}
        className={className}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        title={`Reference ${title} in chat`}
        type="button"
      >
        {mutation.isPending ? 'Opening' : 'Reference'}
      </button>
      {mutation.error ? (
        <span
          className="max-w-[28ch] text-[10px] leading-4 text-accent"
          role="alert"
        >
          {queryErrorMessage(mutation.error)}
        </span>
      ) : null}
      {mutation.data ? (
        <output aria-live="polite" className="sr-only">
          Opened linked chat for {title}.
        </output>
      ) : null}
    </span>
  );
}
