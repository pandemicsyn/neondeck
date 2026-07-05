import { useFlueAgent, useFlueClient } from '@flue/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  ChatSessionRecord,
  NeonCommandResult,
  NeonSessionState,
} from '../../../api';
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
  activeRecord,
  agentName,
  onReferenceDraftConsumed,
  quickCommands,
  referenceDraft,
  session,
  sessionState,
}: {
  activeRecord: ChatSessionRecord | undefined;
  agentName: string;
  onReferenceDraftConsumed?: () => void;
  quickCommands: FlueChatConfig['quickCommands'];
  referenceDraft?: string;
  session: FlueChatSession | undefined;
  sessionState: NeonSessionState | undefined;
}) {
  const [input, setInput] = useState('');
  const [commandEvents, setCommandEvents] = useState<CommandEvent[]>([]);
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
  const [historyRefreshError, setHistoryRefreshError] = useState<string>();
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
  const historyInputBlocked =
    pendingHistoryRefresh || Boolean(historyRefreshError);
  const inputPlaceholder = !session
    ? 'Resolving active session...'
    : historyRefreshError
      ? 'Retry session history before sending...'
      : pendingHistoryRefresh
        ? 'Loading session history...'
        : session.placeholder;

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [commandQuery]);

  useEffect(() => {
    setCanonicalMessages(undefined);
    setPendingHistoryRefresh(Boolean(session?.id));
    setHistoryRefreshError(undefined);
    setCommandEvents(loadCommandEvents(session?.id));
  }, [agentName, session?.id]);

  useEffect(() => {
    if (!session?.id) return;
    saveCommandEvents(session.id, commandEvents);
  }, [commandEvents, session?.id]);

  useEffect(() => {
    if (!referenceDraft) return;
    setInput((current) =>
      current.trim() ? `${current}\n\n${referenceDraft}` : referenceDraft,
    );
    onReferenceDraftConsumed?.();
  }, [onReferenceDraftConsumed, referenceDraft]);

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
        setHistoryRefreshError(undefined);
      })
      .catch((error) => {
        if (cancelled) return;
        if (isMissingHistoryError(error)) {
          setCanonicalMessages([]);
          setHistoryRefreshError(undefined);
          setPendingHistoryRefresh(false);
          return;
        }
        setHistoryRefreshError(errorMessage(error));
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
      const eventId = `command:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;
      appendCommandEvent({
        id: eventId,
        input: message,
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      try {
        const result = await runCommand(message);
        updateCommandEvent(eventId, {
          status: result.ok ? 'completed' : 'failed',
          result,
          completedAt: new Date().toISOString(),
        });
        if (result.ok && result.command === 'reasoning') {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.neonSession,
          });
        }
        setInput('');
      } catch (error) {
        updateCommandEvent(eventId, {
          status: 'failed',
          result: commandFailureResult(message, error),
          completedAt: new Date().toISOString(),
        });
        setSubmitError(errorMessage(error));
      }
      return;
    }
    if (!session) {
      setSubmitError('Active session is still resolving.');
      return;
    }
    if (historyInputBlocked) {
      setSubmitError(
        historyRefreshError
          ? 'Refresh session history before sending.'
          : 'Session history is still loading.',
      );
      return;
    }

    setSendingMessage(true);
    const commandContextEvents = commandEventsForAgentContext(commandEvents);
    try {
      setCanonicalMessages(undefined);
      await agent.sendMessage(
        messageWithSessionContext(
          message,
          activeRecord,
          messages,
          commandContextEvents,
        ),
      );
      markCommandEventsContextSent(
        commandContextEvents.map((event) => event.id),
      );
      setPendingHistoryRefresh(true);
      setInput('');
    } catch (error) {
      setPendingHistoryRefresh(false);
      setSubmitError(errorMessage(error));
    } finally {
      setSendingMessage(false);
    }
  }

  function appendCommandEvent(event: CommandEvent) {
    setCommandEvents((events) => [...events, event].slice(-30));
  }

  function updateCommandEvent(id: string, patch: Partial<CommandEvent>) {
    setCommandEvents((events) =>
      events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
    );
  }

  function markCommandEventsContextSent(ids: string[]) {
    if (ids.length === 0) return;
    const sentAt = new Date().toISOString();
    setCommandEvents((events) =>
      events.map((event) =>
        ids.includes(event.id)
          ? { ...event, agentContextSentAt: sentAt }
          : event,
      ),
    );
  }

  async function askAboutCommand(event: CommandEvent) {
    if (!session || sendingMessage || runningCommand || historyInputBlocked) {
      return;
    }
    const summaryId = event.result?.workflowSummary?.id;
    const runId = event.result?.flueRunId;
    const message = [
      `Explain the result of command ${event.input}.`,
      summaryId ? `Workflow summary id: ${summaryId}.` : undefined,
      runId ? `Flue run id: ${runId}.` : undefined,
      event.result?.message
        ? `Command message: ${event.result.message}`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n');
    setSendingMessage(true);
    try {
      setCanonicalMessages(undefined);
      await agent.sendMessage(
        messageWithSessionContext(message, activeRecord, messages, []),
      );
      markCommandEventsContextSent([event.id]);
      setPendingHistoryRefresh(true);
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
          {historyRefreshError ? (
            <div className="border border-accent/60 bg-soft px-2.5 py-2 text-[10.5px] leading-4 text-muted">
              <div className="flex items-center justify-between gap-2 font-mono">
                <span className="text-accent">HISTORY REFRESH FAILED</span>
                <Button
                  className="min-h-[24px] border-accent bg-transparent px-1.5 py-0 text-[10px] text-accent"
                  onClick={() => {
                    setHistoryRefreshError(undefined);
                    setPendingHistoryRefresh(Boolean(session?.id));
                  }}
                  type="button"
                >
                  retry
                </Button>
              </div>
              <p className="mt-1 line-clamp-2">{historyRefreshError}</p>
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
          {commandEvents.map((event) => (
            <CommandResultSummary
              event={event}
              key={event.id}
              onAsk={
                event.result ? () => void askAboutCommand(event) : undefined
              }
            />
          ))}
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
            placeholder={inputPlaceholder}
            rows={1}
            disabled={
              !session ||
              historyInputBlocked ||
              sendingMessage ||
              !!runningCommand
            }
            value={input}
          />
          <Kbd>
            {commandMenuOpen
              ? 'Tab complete'
              : historyInputBlocked
                ? 'Loading history'
                : runningCommand
                  ? 'Running'
                  : sendingMessage
                    ? 'Sending'
                    : '/ commands | Enter send'}
          </Kbd>
          <Button
            className="sr-only"
            disabled={
              !session ||
              historyInputBlocked ||
              !input.trim() ||
              sendingMessage ||
              !!runningCommand
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

type CommandRunResult = NeonCommandResult & { flueRunId?: string };

type CommandEvent = {
  id: string;
  input: string;
  status: 'running' | 'completed' | 'failed';
  result?: CommandRunResult;
  createdAt: string;
  completedAt?: string;
  agentContextSentAt?: string;
};

function commandStorageKey(sessionId: string) {
  return `neondeck:chat-command-events:${sessionId}`;
}

function loadCommandEvents(sessionId: string | undefined): CommandEvent[] {
  if (!sessionId || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(commandStorageKey(sessionId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(isCommandEvent).slice(-30)
      : [];
  } catch {
    return [];
  }
}

function saveCommandEvents(sessionId: string, events: CommandEvent[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    commandStorageKey(sessionId),
    JSON.stringify(events.slice(-30)),
  );
}

function isCommandEvent(value: unknown): value is CommandEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<CommandEvent>;
  return (
    typeof event.id === 'string' &&
    typeof event.input === 'string' &&
    (event.status === 'running' ||
      event.status === 'completed' ||
      event.status === 'failed') &&
    typeof event.createdAt === 'string'
  );
}

function commandFailureResult(
  command: string,
  error: unknown,
): CommandRunResult {
  return {
    ok: false,
    command: commandNameFromInput(command),
    input: command,
    status: 'failed',
    message: errorMessage(error),
    errors: [errorMessage(error)],
  };
}

function commandNameFromInput(command: string): NeonCommandResult['command'] {
  const name = command.replace(/^\//, '').split(/\s+/, 1)[0];
  const supported: NeonCommandResult['command'][] = [
    'repo-status',
    'review-queue',
    'explain-ci',
    'summarize-pr',
    'draft-pr-description',
    'prepare-pr',
    'review-local',
    'briefing',
    'reasoning',
    'memory',
    'watch-pr',
    'dev-doctor',
    'watch-release',
  ];
  return supported.includes(name as NeonCommandResult['command'])
    ? (name as NeonCommandResult['command'])
    : 'dev-doctor';
}

function messageWithSessionContext(
  message: string,
  session: ChatSessionRecord | undefined,
  messages: unknown[],
  commandEvents: CommandEvent[],
) {
  const sections: string[][] = [];
  if (session && messages.length === 0 && hasLinkedContext(session)) {
    sections.push(
      [
        'Linked Neondeck session context:',
        `- kind: ${session.kind}`,
        session.linkedRepoId ? `- repo id: ${session.linkedRepoId}` : undefined,
        session.linkedWatchId
          ? `- watch id: ${session.linkedWatchId}`
          : undefined,
        session.linkedTaskId ? `- task id: ${session.linkedTaskId}` : undefined,
        session.summary ? `- summary: ${session.summary}` : undefined,
        session.uiMetadata
          ? `- UI metadata: ${truncate(JSON.stringify(session.uiMetadata), 1_000)}`
          : undefined,
      ].filter((line): line is string => line !== undefined),
    );
  }

  const commandContext = commandEventsForAgentContext(commandEvents);
  if (commandContext.length > 0) {
    sections.push([
      'Recent Neondeck slash command results not yet in agent context:',
      ...commandContext.flatMap(commandEventContextLines),
    ]);
  }

  if (sections.length === 0) {
    return message;
  }

  return [
    ...sections.flatMap((section, index) =>
      index === 0 ? section : ['', ...section],
    ),
    '',
    'User message:',
    message,
  ].join('\n');
}

function hasLinkedContext(session: ChatSessionRecord) {
  return Boolean(
    session.linkedRepoId ||
    session.linkedWatchId ||
    session.linkedTaskId ||
    session.summary ||
    session.uiMetadata,
  );
}

function isMissingHistoryError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('404') && message.includes('stream_not_found');
}

function commandEventsForAgentContext(events: CommandEvent[]) {
  return events
    .filter(
      (event) =>
        !event.agentContextSentAt &&
        event.result &&
        (event.status === 'completed' || event.status === 'failed'),
    )
    .slice(-5);
}

function commandEventContextLines(event: CommandEvent) {
  const result = event.result;
  return [
    `- command: ${event.input}`,
    `  status: ${event.status}${result?.ok === false ? ' (not ok)' : ''}`,
    result?.message ? `  message: ${truncate(result.message, 500)}` : undefined,
    result?.workflowSummary?.id
      ? `  workflow summary id: ${result.workflowSummary.id}`
      : undefined,
    result?.flueRunId ? `  Flue run id: ${result.flueRunId}` : undefined,
    result?.errors?.length
      ? `  errors: ${truncate(result.errors.join('; '), 500)}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
