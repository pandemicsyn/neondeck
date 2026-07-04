import { useFlueAgent, useFlueClient } from '@flue/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { NeonCommandResult, NeonSessionState } from '../../../api';
import {
  Badge,
  Button,
  Kbd,
  ScrollArea,
  Textarea,
} from '../../../components/ui';
import { queryKeys } from '../../../lib/query';
import { CommandResultSummary, CommandTypeahead } from './command-controls';
import {
  ChatPartEvent,
  errorMessage,
  renderMessagePart,
} from './message-parts';
import {
  commandQueryFromInput,
  filterCommands,
  mergeCommandCatalog,
} from '../lib/commands';
import { chatMessagesForRender } from '../lib/messages';
import type {
  FlueChatCommand,
  FlueChatConfig,
  FlueChatSession,
} from '../types';

export function FlueChatSessionView({
  agentName,
  quickCommands,
  session,
  sessionState,
}: {
  agentName: string;
  quickCommands: FlueChatConfig['quickCommands'];
  session: FlueChatSession | undefined;
  sessionState: NeonSessionState | undefined;
}) {
  const [input, setInput] = useState('');
  const [commandResult, setCommandResult] = useState<NeonCommandResult>();
  const [runningCommand, setRunningCommand] = useState<string>();
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedCommandInput, setDismissedCommandInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const queryClient = useQueryClient();
  const flue = useFlueClient();
  const agent = useFlueAgent({
    name: agentName,
    id: session?.id,
  });
  const [canonicalMessages, setCanonicalMessages] =
    useState<typeof agent.messages>();
  const [pendingHistoryRefresh, setPendingHistoryRefresh] = useState(false);
  const messages = chatMessagesForRender(
    agent.messages,
    canonicalMessages,
    agent.status,
  );
  const commandCatalog = useMemo(
    () => mergeCommandCatalog(quickCommands),
    [quickCommands],
  );
  const commandQuery = commandQueryFromInput(input);
  const matchingCommands = useMemo(
    () => filterCommands(commandCatalog, commandQuery),
    [commandCatalog, commandQuery],
  );
  const visibleCommands = matchingCommands.slice(0, 6);
  const commandMenuOpen =
    commandQuery !== undefined &&
    dismissedCommandInput !== input &&
    visibleCommands.length > 0;
  const activeCommand =
    visibleCommands[Math.min(activeCommandIndex, visibleCommands.length - 1)];

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [commandQuery]);

  useEffect(() => {
    setCanonicalMessages(undefined);
    setPendingHistoryRefresh(Boolean(session?.id));
  }, [agentName, session?.id]);

  useEffect(() => {
    if (!pendingHistoryRefresh) return;
    if (agent.status === 'error') {
      setPendingHistoryRefresh(false);
      return;
    }
    if (!session?.id || agent.status !== 'idle') return;

    let cancelled = false;
    void flue.agents
      .history(agentName, session.id)
      .then((history) => {
        if (cancelled) return;
        setCanonicalMessages(history.messages);
        setPendingHistoryRefresh(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPendingHistoryRefresh(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agent.status, agentName, flue, pendingHistoryRefresh, session?.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || sendingMessage || runningCommand) return;

    setSubmitError(undefined);

    if (message.startsWith('/')) {
      try {
        const result = await runCommand(message);
        setCommandResult(result);
        if (result.ok && result.command === 'reasoning') {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.neonSession,
          });
        }
        setInput('');
      } catch (error) {
        setSubmitError(errorMessage(error));
      }
      return;
    }
    if (!session) {
      setSubmitError('Active session is still resolving.');
      return;
    }

    setSendingMessage(true);
    try {
      setCanonicalMessages(undefined);
      await agent.sendMessage(message);
      setPendingHistoryRefresh(true);
      setInput('');
    } catch (error) {
      setPendingHistoryRefresh(false);
      setSubmitError(errorMessage(error));
    } finally {
      setSendingMessage(false);
    }
  }

  async function runCommand(command: string) {
    setRunningCommand(command);
    try {
      const run = await flue.workflows.invoke('command-run', {
        input: { command },
        wait: 'result',
      });
      return {
        ...(run.result as NeonCommandResult),
        flueRunId: run.runId,
      };
    } finally {
      setRunningCommand(undefined);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandMenuOpen && activeCommand) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveCommandIndex((index) => (index + 1) % visibleCommands.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveCommandIndex(
          (index) =>
            (index - 1 + visibleCommands.length) % visibleCommands.length,
        );
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        completeCommand(activeCommand);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const typedCommand = input.trim();
        if (typedCommand !== activeCommand.command) {
          event.preventDefault();
          completeCommand(activeCommand);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedCommandInput(input);
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function completeCommand(command: FlueChatCommand) {
    setInput(`${command.command} `);
    setDismissedCommandInput('');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="chat-log flex-1">
        <div className="flex min-h-full flex-col gap-3 px-[18px] py-3.5">
          <div className="flex items-center justify-between font-mono text-[10.5px] text-muted">
            <span className="text-primary">
              {session?.id ?? 'loading session'}
            </span>
            <Badge>{agent.status}</Badge>
          </div>
          {sessionState?.stale ? (
            <div className="border border-accent/60 bg-soft px-2.5 py-2 text-[10.5px] leading-4 text-muted">
              <div className="flex items-center justify-between gap-2 font-mono">
                <span className="text-accent">CONTEXT STALE</span>
                <Badge className="border-accent text-accent">
                  {sessionState.staleReasons.length}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2">
                {sessionState.staleReasons[0]?.message ??
                  'Start a new session to reload runtime context.'}
              </p>
            </div>
          ) : null}
          {messages.length > 0 ? (
            <div className="chat-workflow px-2.5 py-1 font-mono text-[10.5px]">
              <span>workflow</span>
              <span className="text-muted">
                session · {messages.length} messages
              </span>
            </div>
          ) : null}
          <CommandResultSummary
            latest={commandResult}
            runningCommand={runningCommand}
          />
          {messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted">
              <div className="max-w-[42ch]">
                <div className="miami-accent mx-auto mb-2 h-1.5 w-12" />
                <p className="font-medium text-ink">
                  {session ? 'Session ready' : 'Resolving session'}
                </p>
                <p className="mt-1 leading-5">
                  {session
                    ? 'Messages persist through the local Flue SQLite store.'
                    : 'Chat will attach when the active durable session is available.'}
                </p>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <article
                className={`chat-message chat-message-${message.role} space-y-1.5`}
                key={message.id}
              >
                <p className="font-mono text-[10px] font-semibold text-muted">
                  {message.role}
                </p>
                <div className="space-y-2 text-[13px] leading-[1.55] text-ink">
                  {message.parts.length > 0 ? (
                    message.parts.map((part, index) =>
                      renderMessagePart(part, `${message.id}-${index}`),
                    )
                  ) : (
                    <ChatPartEvent
                      kind="event"
                      name="assistant message"
                      preview="No visible message parts were returned."
                    />
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </ScrollArea>
      <div className="relative shrink-0 border-t border-line bg-field">
        <CommandTypeahead
          activeCommand={activeCommand}
          activeCommandIndex={activeCommandIndex}
          commands={visibleCommands}
          open={commandMenuOpen}
          onSelect={completeCommand}
        />
        {submitError ? (
          <div className="border-b border-accent/50 px-4 py-1 font-mono text-[10.5px] leading-4 text-accent">
            {submitError}
          </div>
        ) : null}
        <form className="flex h-11 items-center gap-2.5 px-4" onSubmit={submit}>
          <span className="font-mono text-[13px] text-accent">›</span>
          <Textarea
            aria-autocomplete="list"
            aria-controls="flue-command-typeahead"
            aria-expanded={commandMenuOpen}
            className="dashboard-input h-7 flex-1 overflow-hidden px-0 py-1 font-mono text-[13px] leading-5 caret-primary"
            onChange={(event) => {
              setInput(event.target.value);
              setDismissedCommandInput('');
              if (submitError) setSubmitError(undefined);
            }}
            onKeyDown={handleKeyDown}
            placeholder={session?.placeholder ?? 'Resolving active session...'}
            rows={1}
            disabled={!session || sendingMessage || !!runningCommand}
            value={input}
          />
          <Kbd>
            {commandMenuOpen
              ? 'Tab complete'
              : runningCommand
                ? 'Running'
                : sendingMessage
                  ? 'Sending'
                  : '/ commands | Enter send'}
          </Kbd>
          <Button
            className="sr-only"
            disabled={
              !session || !input.trim() || sendingMessage || !!runningCommand
            }
            type="submit"
          >
            Send
          </Button>
        </form>
      </div>
    </div>
  );
}
