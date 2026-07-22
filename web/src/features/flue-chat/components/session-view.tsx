// The multiline composer intentionally implements the WAI-ARIA combobox
// pattern; replacing it with a single-line input would remove message editing.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import { useFlueAgent, useFlueClient } from '@flue/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  ChatSessionCommandEvent,
  ChatSessionRecord,
  NeonCommandResult,
  NeonSessionState,
} from '../../../api';
import {
  createChatSessionCommandEvent,
  getChatSessionActivity,
  getChatSessionCommandEvents,
  getNeonCommands,
  openChatSessionCommandEventStream,
  openChatSessionEventStream,
  runBriefing,
  updateChatSessionCommandEvent,
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
import { ChatTimelineItems } from './chat-timeline';
import { errorMessage } from './message-parts';
import {
  clampCommandIndex,
  commandQueryFromInput,
  filterCommands,
  mergeCommandCatalog,
} from '../lib/commands';
import { upsertCommandEvent } from '../lib/command-events';
import { chatMessagesForRender } from '../lib/messages';
import {
  sessionActivityForLinkedWatch,
  sessionTimelineItems,
} from '../lib/timeline';
import { useChatAutoScroll } from '../lib/use-chat-auto-scroll';
import type {
  FlueChatCommand,
  FlueChatConfig,
  FlueChatSession,
} from '../types';

export function FlueChatSessionView({
  activeRecord,
  agentName,
  allowCommands = true,
  messageEnabled = true,
  messageLabel = 'Message Neon',
  onReferenceDraftConsumed,
  quickCommands,
  referenceDraft,
  session,
  sessionState,
}: {
  activeRecord: ChatSessionRecord | undefined;
  agentName: string;
  allowCommands?: boolean;
  messageEnabled?: boolean;
  messageLabel?: string;
  onReferenceDraftConsumed?: () => void;
  quickCommands: FlueChatConfig['quickCommands'];
  referenceDraft?: string;
  session: FlueChatSession | undefined;
  sessionState: NeonSessionState | undefined;
}) {
  const [input, setInput] = useState('');
  const [commandEvents, setCommandEvents] = useState<CommandEvent[]>([]);
  const [runningCommand, setRunningCommand] = useState<string>();
  const [commandSubmitting, setCommandSubmitting] = useState(false);
  const [requestedCommandIndex, setRequestedCommandIndex] = useState(0);
  const [dismissedCommandInput, setDismissedCommandInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const commandSubmitLockRef = useRef(false);
  const commandTypeaheadId = useId();
  const queryClient = useQueryClient();
  const flue = useFlueClient();
  const agent = useFlueAgent({
    name: agentName,
    id: session?.id,
  });
  const messages = useMemo(
    () => chatMessagesForRender(agent.messages),
    [agent.messages],
  );
  const commandsQuery = useQuery({
    queryKey: queryKeys.neonCommands,
    queryFn: getNeonCommands,
    enabled: allowCommands,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const commandCatalog = useMemo(
    () => mergeCommandCatalog(quickCommands, commandsQuery.data?.items),
    [commandsQuery.data?.items, quickCommands],
  );
  const commandQuery = allowCommands ? commandQueryFromInput(input) : undefined;
  const matchingCommands = useMemo(
    () => filterCommands(commandCatalog, commandQuery),
    [commandCatalog, commandQuery],
  );
  const visibleCommands = matchingCommands.slice(0, 6);
  const commandMenuOpen =
    commandQuery !== undefined &&
    dismissedCommandInput !== input &&
    visibleCommands.length > 0;
  const activeCommandIndex = clampCommandIndex(
    requestedCommandIndex,
    visibleCommands.length,
  );
  const activeCommand = visibleCommands[activeCommandIndex];
  const historyInputBlocked = Boolean(session?.id) && !agent.historyReady;
  const commandBusy = commandSubmitting || Boolean(runningCommand);
  const inputPlaceholder = !session
    ? 'Resolving active session...'
    : !messageEnabled
      ? session.placeholder
      : historyInputBlocked
        ? 'Loading session history...'
        : session.placeholder;
  const linkedWatchId = activeRecord?.linkedWatchId;
  const commandEventsQuery = useQuery({
    queryKey: queryKeys.chatSessionCommandEvents(session?.id),
    queryFn: ({ signal }) =>
      getChatSessionCommandEvents(session?.id ?? '', { signal }),
    enabled: Boolean(allowCommands && session?.id),
  });
  const activityQuery = useQuery({
    queryKey: queryKeys.chatSessionActivity(session?.id, linkedWatchId),
    queryFn: ({ signal }) =>
      getChatSessionActivity(session?.id ?? '', { signal }),
    enabled: Boolean(session?.id && linkedWatchId),
    refetchInterval: 30_000,
  });
  const activity = useMemo(
    () =>
      sessionActivityForLinkedWatch(linkedWatchId, activityQuery.data?.items),
    [activityQuery.data?.items, linkedWatchId],
  );
  const timelineItems = useMemo(
    () => sessionTimelineItems(messages, activity),
    [activity, messages],
  );
  const chatAutoScroll = useChatAutoScroll(session?.id);

  useEffect(() => {
    setRequestedCommandIndex(0);
  }, [commandQuery]);

  useEffect(() => {
    setCommandEvents([]);
  }, [agentName, session?.id]);

  useEffect(() => {
    setCommandEvents(commandEventsQuery.data?.events ?? []);
  }, [commandEventsQuery.data?.events]);

  useEffect(() => {
    if (!session?.id) return;
    const refreshCommandEvents = () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatSessionCommandEvents(session.id),
      });
    };
    const refreshSessionQueries = () => {
      refreshCommandEvents();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatSessionActivity(session.id, linkedWatchId),
      });
    };
    const closeSessionEvents = openChatSessionEventStream(
      (event) => {
        if (event.session.id === session.id) refreshSessionQueries();
      },
      undefined,
      refreshSessionQueries,
    );
    const closeCommandEvents = openChatSessionCommandEventStream((event) => {
      if (event.sessionId === session.id) refreshCommandEvents();
    });
    return () => {
      closeCommandEvents();
      closeSessionEvents();
    };
  }, [linkedWatchId, queryClient, session?.id]);

  useEffect(() => {
    if (!referenceDraft) return;
    setInput((current) =>
      current.trim() ? `${current}\n\n${referenceDraft}` : referenceDraft,
    );
    onReferenceDraftConsumed?.();
  }, [onReferenceDraftConsumed, referenceDraft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (
      !message ||
      !messageEnabled ||
      sendingMessage ||
      commandBusy ||
      commandSubmitLockRef.current
    )
      return;

    setSubmitError(undefined);

    if (!session) {
      setSubmitError('Active session is still resolving.');
      return;
    }

    if (allowCommands && message.startsWith('/')) {
      let createdEvent: CommandEvent | undefined;
      commandSubmitLockRef.current = true;
      setCommandSubmitting(true);
      try {
        const created = await createChatSessionCommandEvent(session.id, {
          input: message,
          reason: 'dashboard-slash-command',
        });
        if (!created.event) {
          setSubmitError('Command transcript row was not created.');
          return;
        }
        createdEvent = created.event;
        appendCommandEvent(createdEvent);

        if (commandNameFromInput(message) === 'briefing') {
          setRunningCommand(message);
          const admitted = await runBriefing({
            profileId: 'morning',
            sessionId: session.id,
            commandEventId: createdEvent.id,
            trigger: 'manual',
          });
          if (!admitted.ok) throw new Error(admitted.message);
          if (admitted.workflowRunId) {
            updateCommandEvent(createdEvent.id, {
              flueRunId: admitted.workflowRunId,
            });
            await updateChatSessionCommandEvent(session.id, createdEvent.id, {
              status: 'running',
              flueRunId: admitted.workflowRunId,
              reason: 'dashboard-briefing-workflow-admitted',
            });
          }
          setInput('');
          return;
        }

        const result = await runCommand(message);
        const status =
          result.status === 'running'
            ? 'running'
            : result.ok
              ? 'completed'
              : 'failed';
        const completedAt =
          status === 'running' ? null : new Date().toISOString();
        updateCommandEvent(createdEvent.id, {
          status,
          result,
          flueRunId: result.flueRunId ?? null,
          workflowSummaryId: result.workflowSummary?.id ?? null,
          completedAt,
        });

        try {
          const updated = await updateChatSessionCommandEvent(
            session.id,
            createdEvent.id,
            {
              status,
              result,
              flueRunId: result.flueRunId ?? null,
              workflowSummaryId: result.workflowSummary?.id ?? null,
              ...(completedAt ? { completedAt } : {}),
              reason:
                status === 'running'
                  ? 'dashboard-slash-command-admitted'
                  : 'dashboard-slash-command-complete',
            },
          );
          if (updated.event)
            updateCommandEvent(updated.event.id, updated.event);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.chatSessionCommandEvents(session.id),
          });
        } catch (persistError) {
          setSubmitError(
            `Command finished but transcript update failed: ${errorMessage(
              persistError,
            )}`,
          );
        }

        if (result.ok && result.command === 'reasoning') {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.neonSession,
          });
        }
        setInput('');
      } catch (error) {
        if (!createdEvent) {
          setSubmitError(errorMessage(error));
          return;
        }

        const failedResult = commandFailureResult(message, error);
        const completedAt = new Date().toISOString();
        updateCommandEvent(createdEvent.id, {
          status: 'failed',
          result: failedResult,
          completedAt,
        });
        await updateChatSessionCommandEvent(session.id, createdEvent.id, {
          status: 'failed',
          result: failedResult,
          completedAt,
          reason: 'dashboard-slash-command-failed',
        }).catch((persistError) => {
          setSubmitError(
            `Command failed and transcript update failed: ${errorMessage(
              persistError,
            )}`,
          );
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessionCommandEvents(session.id),
        });
        setSubmitError(errorMessage(error));
      } finally {
        setRunningCommand(undefined);
        commandSubmitLockRef.current = false;
        setCommandSubmitting(false);
      }
      return;
    }
    if (historyInputBlocked) {
      setSubmitError('Session history is still loading.');
      return;
    }

    setSendingMessage(true);
    try {
      await agent.sendMessage(message);
      setInput('');
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSendingMessage(false);
    }
  }

  function appendCommandEvent(event: CommandEvent) {
    setCommandEvents((events) => upsertCommandEvent(events, event));
  }

  function updateCommandEvent(id: string, patch: Partial<CommandEvent>) {
    setCommandEvents((events) =>
      events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
    );
  }

  async function askAboutCommand(event: CommandEvent) {
    if (!session || sendingMessage || commandBusy || historyInputBlocked) {
      return;
    }
    const summaryId = event.result?.workflowSummary?.id;
    const runId = event.result?.flueRunId ?? event.flueRunId;
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
      await agent.sendMessage(message);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSendingMessage(false);
    }
  }

  async function runCommand(command: string) {
    setRunningCommand(command);
    try {
      const run = await flue.workflows.invoke('command-run', {
        input: {
          command,
          ...(session?.id ? { sessionId: session.id } : {}),
          surface: 'dashboard',
        },
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
        setRequestedCommandIndex(
          (activeCommandIndex + 1) % visibleCommands.length,
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setRequestedCommandIndex(
          (activeCommandIndex - 1 + visibleCommands.length) %
            visibleCommands.length,
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
      <div className="relative min-h-0 flex-1">
        <ScrollArea
          aria-label="Chat transcript"
          aria-live="polite"
          className="chat-log h-full"
          onScroll={chatAutoScroll.handleScroll}
          ref={chatAutoScroll.transcriptRef}
        >
          <div className="flex min-h-full flex-col gap-3 px-[18px] py-3.5">
            <div className="flex items-center justify-between font-mono text-[10.5px] text-muted">
              <span className="text-primary">
                {session?.id ?? 'loading session'}
              </span>
              <Badge>{agent.status}</Badge>
            </div>
            {sessionState?.stale ? (
              <div
                className="border border-accent/60 bg-soft px-2.5 py-2 text-[10.5px] leading-4 text-muted"
                role="alert"
              >
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
            {agent.error ? (
              <div
                className="border border-accent/60 bg-soft px-2.5 py-2 text-[10.5px] leading-4 text-muted"
                role="alert"
              >
                <div className="flex items-center justify-between gap-2 font-mono">
                  <span className="text-accent">SESSION CONNECTION FAILED</span>
                </div>
                <p className="mt-1 line-clamp-2">{agent.error.message}</p>
              </div>
            ) : null}
            {allowCommands && commandEventsQuery.error ? (
              <div
                className="border border-accent/60 bg-soft px-2.5 py-2 font-mono text-[10.5px] leading-4 text-accent"
                role="alert"
              >
                COMMAND HISTORY UNAVAILABLE ·{' '}
                {errorMessage(commandEventsQuery.error)}
              </div>
            ) : null}
            {linkedWatchId && activityQuery.error ? (
              <div
                className="border border-accent/60 bg-soft px-2.5 py-2 font-mono text-[10.5px] leading-4 text-accent"
                role="alert"
              >
                SESSION ACTIVITY UNAVAILABLE ·{' '}
                {errorMessage(activityQuery.error)}
              </div>
            ) : null}
            {timelineItems.length > 0 ? (
              <div className="chat-workflow px-2.5 py-1 font-mono text-[10.5px]">
                <span>workflow</span>
                <span className="text-muted">
                  session · {messages.length} messages
                  {activity.length > 0
                    ? ` · ${activity.length} activity records`
                    : ''}
                </span>
              </div>
            ) : null}
            {commandEvents.filter(isDeterministicCommandEvent).map((event) => (
              <CommandResultSummary
                event={event}
                key={event.id}
                onAsk={
                  event.result ? () => void askAboutCommand(event) : undefined
                }
              />
            ))}
            <ChatTimelineItems
              hasSession={Boolean(session)}
              items={timelineItems}
            />
          </div>
        </ScrollArea>
        {!chatAutoScroll.followsLatest ? (
          <Button
            aria-label="Jump to latest chat activity"
            className="absolute right-3 bottom-3 min-h-7 gap-1.5 bg-panel px-2.5 py-1 font-mono text-[10.5px] shadow-[0_3px_8px_rgba(0,0,0,0.28)]"
            onClick={chatAutoScroll.jumpToLatest}
            type="button"
          >
            {chatAutoScroll.hasNewActivity ? 'New activity' : 'Jump to latest'}
            <span aria-hidden="true">↓</span>
          </Button>
        ) : null}
      </div>
      <div className="relative shrink-0 border-t border-line bg-field">
        {allowCommands ? (
          <CommandTypeahead
            activeCommand={activeCommand}
            activeCommandIndex={activeCommandIndex}
            commands={visibleCommands}
            id={commandTypeaheadId}
            open={commandMenuOpen}
            onSelect={completeCommand}
          />
        ) : null}
        {submitError ? (
          <div
            className="border-b border-accent/50 px-4 py-1 font-mono text-[10.5px] leading-4 text-accent"
            role="alert"
          >
            {submitError}
          </div>
        ) : null}
        <form
          className="flue-chat-composer flex min-h-11 items-center gap-2.5 px-4"
          onSubmit={submit}
        >
          <span className="font-mono text-[13px] text-accent">›</span>
          <Textarea
            aria-activedescendant={
              commandMenuOpen
                ? `${commandTypeaheadId}-option-${activeCommandIndex}`
                : undefined
            }
            aria-autocomplete="list"
            aria-controls={commandTypeaheadId}
            aria-expanded={commandMenuOpen}
            aria-label={messageLabel}
            className="dashboard-input h-7 min-w-0 flex-1 overflow-hidden px-0 py-1 font-mono text-[13px] leading-5 caret-primary"
            onChange={(event) => {
              setInput(event.target.value);
              setDismissedCommandInput('');
              if (submitError) setSubmitError(undefined);
            }}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            rows={1}
            role="combobox"
            disabled={
              !session ||
              !messageEnabled ||
              historyInputBlocked ||
              sendingMessage ||
              commandBusy
            }
            value={input}
          />
          <Kbd className="flue-chat-composer-hint">
            {commandMenuOpen
              ? 'Tab complete'
              : historyInputBlocked
                ? 'Loading history'
                : runningCommand
                  ? 'Running'
                  : commandSubmitting
                    ? 'Starting'
                    : sendingMessage
                      ? 'Sending'
                      : allowCommands
                        ? '/ commands | Enter send'
                        : 'Enter send'}
          </Kbd>
          <Button
            className="flue-chat-send min-h-[28px] shrink-0 bg-transparent px-2 py-1 font-mono text-[10px]"
            disabled={
              !session ||
              !messageEnabled ||
              historyInputBlocked ||
              !input.trim() ||
              sendingMessage ||
              commandBusy
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

type CommandEvent = ChatSessionCommandEvent;

function isDeterministicCommandEvent(event: CommandEvent) {
  return commandNameFromInput(event.input) !== 'briefing';
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
  return name || 'unknown';
}
