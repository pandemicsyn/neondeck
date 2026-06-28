import { useFlueAgent, useFlueClient } from '@flue/react';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  getNeonSession,
  startNeonSession,
  type NeonCommandResult,
  type NeonSessionState,
} from '../api';
import { Badge, Button, Kbd, ScrollArea, Textarea } from '../components/ui';
import { useConfigEvents } from '../lib/config-events';
import type { DisplayPlugin } from '../types';

type FlueChatSession = {
  id: string;
  label: string;
  placeholder: string;
};

type FlueChatConfig = {
  agentName: string;
  sessions: FlueChatSession[];
  quickCommands: Array<{
    label: string;
    command: string;
  }>;
};

export const FlueChatPlugin = {
  id: 'flue-chat',
  title: 'Flue chat',
  kind: 'agent',
  defaultConfig: {
    agentName: 'display-assistant',
    sessions: [
      {
        id: 'neondeck-main',
        label: 'Primary',
        placeholder: 'Ask the assistant...',
      },
    ],
    quickCommands: [
      { label: 'Repo', command: '/repo-status' },
      { label: 'Queue', command: '/review-queue' },
      { label: 'CI', command: '/explain-ci' },
      { label: 'PR', command: '/summarize-pr' },
      { label: 'Draft', command: '/draft-pr-description' },
      { label: 'Prep', command: '/prepare-pr' },
      { label: 'Review', command: '/review-local' },
      { label: 'Memory', command: '/memory' },
      { label: 'Doctor', command: '/dev-doctor' },
      { label: 'Briefing', command: '/briefing' },
    ],
  },
  Component({ config }) {
    const fallbackSession =
      (config.sessions.length > 0
        ? config.sessions
        : FlueChatPlugin.defaultConfig.sessions)[0] ??
      FlueChatPlugin.defaultConfig.sessions[0];
    const [sessionState, setSessionState] = useState<NeonSessionState>();
    const [sessionError, setSessionError] = useState<string>();
    const [startingSession, setStartingSession] = useState(false);
    const activeSession = sessionState
      ? {
          id: sessionState.activeSession.id,
          label: sessionState.activeSession.label,
          placeholder: fallbackSession.placeholder,
        }
      : fallbackSession;

    async function refreshSession() {
      try {
        setSessionState(await getNeonSession());
        setSessionError(undefined);
      } catch (cause) {
        setSessionError(cause instanceof Error ? cause.message : String(cause));
      }
    }

    async function startFreshSession() {
      setStartingSession(true);
      try {
        const result = await startNeonSession({
          label: 'Fresh',
          reason: 'dashboard-new-session',
        });
        if (!result.state) {
          throw new Error(result.message);
        }
        setSessionState(result.state);
        setSessionError(undefined);
      } catch (cause) {
        setSessionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setStartingSession(false);
      }
    }

    useConfigEvents(() => void refreshSession());

    useEffect(() => {
      void refreshSession();
      const timer = window.setInterval(refreshSession, 30_000);
      return () => window.clearInterval(timer);
    }, []);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-4 font-mono text-[11px] tracking-[0.14em]">
          <span className="flex items-center gap-2 text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
            FLUE AGENT · triage.ts
          </span>
          <div className="flex items-center gap-3">
            <Button
              className="h-5 border-transparent bg-transparent px-2 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={startingSession}
              onClick={() => void startFreshSession()}
              type="button"
            >
              {startingSession ? 'Starting' : 'New'}
            </Button>
            <span
              className={sessionState?.stale ? 'text-accent' : 'text-muted'}
            >
              {sessionState?.stale ? 'stale ctx' : 'durable ctx'}
            </span>
          </div>
        </header>
        {sessionError ? (
          <div className="border-b border-accent/60 bg-soft px-4 py-1.5 text-[11px] text-accent">
            {sessionError}
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

function FlueChatSessionView({
  agentName,
  quickCommands,
  session,
  sessionState,
}: {
  agentName: string;
  quickCommands: FlueChatConfig['quickCommands'];
  session: FlueChatSession;
  sessionState: NeonSessionState | undefined;
}) {
  const [input, setInput] = useState('');
  const [commandResult, setCommandResult] = useState<NeonCommandResult>();
  const [runningCommand, setRunningCommand] = useState<string>();
  const flue = useFlueClient();
  const agent = useFlueAgent({
    name: agentName,
    id: session.id,
    history: 'all',
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    setInput('');
    if (message.startsWith('/')) {
      setCommandResult(await runCommand(message));
      return;
    }

    await agent.sendMessage(message);
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
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="chat-log flex-1">
        <div className="flex min-h-full flex-col gap-3 px-[18px] py-3.5">
          <div className="flex items-center justify-between font-mono text-[10.5px] text-muted">
            <span className="text-primary">{session.id}</span>
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
          {agent.messages.length > 0 ? (
            <div className="chat-workflow px-2.5 py-1 font-mono text-[10.5px]">
              <span>workflow</span>
              <span className="text-muted">
                session · {agent.messages.length} messages
              </span>
            </div>
          ) : null}
          <CommandButtons
            commands={quickCommands}
            latest={commandResult}
            onRun={async (command) =>
              setCommandResult(await runCommand(command))
            }
            runningCommand={runningCommand}
          />
          {agent.messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted">
              <div className="max-w-[42ch]">
                <div className="miami-accent mx-auto mb-2 h-1.5 w-12" />
                <p className="font-medium text-ink">Session ready</p>
                <p className="mt-1 leading-5">
                  Messages persist through the local Flue SQLite store.
                </p>
              </div>
            </div>
          ) : (
            agent.messages.map((message) => (
              <article
                className={`chat-message chat-message-${message.role} space-y-1.5`}
                key={message.id}
              >
                <p className="font-mono text-[10px] font-semibold text-muted">
                  {message.role}
                </p>
                <div className="space-y-2 text-[13px] leading-[1.55] text-ink">
                  {message.parts.map((part, index) =>
                    part.type === 'text' ? (
                      <p key={`${message.id}-${index}`}>{part.text}</p>
                    ) : null,
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </ScrollArea>
      <form
        className="flex h-11 items-center gap-2.5 border-t border-line bg-field px-4"
        onSubmit={submit}
      >
        <span className="font-mono text-[13px] text-accent">›</span>
        <Textarea
          className="dashboard-input h-7 flex-1 overflow-hidden px-0 py-1 font-mono text-[13px] leading-5"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={session.placeholder}
          rows={1}
          value={input}
        />
        <Kbd>Enter send · Ctrl K tools</Kbd>
        <Button className="sr-only" disabled={!input.trim()} type="submit">
          Send
        </Button>
      </form>
    </div>
  );
}

function CommandButtons({
  commands,
  latest,
  onRun,
  runningCommand,
}: {
  commands: FlueChatConfig['quickCommands'];
  latest: NeonCommandResult | undefined;
  onRun: (command: string) => Promise<void>;
  runningCommand: string | undefined;
}) {
  return (
    <section className="border border-line bg-panel/70 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {commands.map((command) => (
            <Button
              className="h-6 border-line bg-field px-2 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary"
              disabled={!!runningCommand}
              key={command.command}
              onClick={() => void onRun(command.command)}
              title={command.command}
              type="button"
            >
              {runningCommand === command.command ? 'Running' : command.label}
            </Button>
          ))}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted">
          commands
        </span>
      </div>
      {latest ? (
        <div className="mt-2 border-t border-line pt-2 font-mono text-[10.5px] leading-4">
          <div className="flex items-center justify-between gap-3">
            <span className={latest.ok ? 'text-primary' : 'text-accent'}>
              {latest.input}
            </span>
            <Badge>{latest.status}</Badge>
          </div>
          <p className="mt-1 text-muted">{latest.message}</p>
        </div>
      ) : null}
    </section>
  );
}
