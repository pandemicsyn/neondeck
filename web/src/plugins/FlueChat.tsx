import { useFlueAgent } from '@flue/react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Badge, Button, Kbd, ScrollArea, Textarea } from '../components/ui';
import type { DisplayPlugin } from '../types';

type FlueChatSession = {
  id: string;
  label: string;
  placeholder: string;
};

type FlueChatConfig = {
  agentName: string;
  sessions: FlueChatSession[];
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
  },
  Component({ config }) {
    const sessions = config.sessions.length > 0 ? config.sessions : FlueChatPlugin.defaultConfig.sessions;
    const [activeSessionId, setActiveSessionId] = useState(() => sessions[0].id);
    const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-4 font-mono text-[11px] tracking-[0.14em]">
          <span className="flex items-center gap-2 text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
            FLUE AGENT · triage.ts
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 tracking-normal">
              {sessions.map((session) => (
                <Button
                  aria-pressed={session.id === activeSession.id}
                  className="h-5 border-transparent bg-transparent px-2 py-0 font-mono text-[10.5px] text-muted hover:border-violet hover:text-primary aria-pressed:border-violet aria-pressed:bg-soft aria-pressed:text-primary"
                  key={session.id}
                  onClick={() => setActiveSessionId(session.id)}
                  type="button"
                >
                  {session.label}
                </Button>
              ))}
            </div>
            <span className="text-muted">durable · ctx 18k</span>
          </div>
        </header>
        <FlueChatSessionView agentName={config.agentName} session={activeSession} />
      </div>
    );
  },
} satisfies DisplayPlugin<FlueChatConfig>;

function FlueChatSessionView({ agentName, session }: { agentName: string; session: FlueChatSession }) {
  const [input, setInput] = useState('');
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
    await agent.sendMessage(message);
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
          {agent.messages.length > 0 ? (
            <div className="chat-workflow px-2.5 py-1 font-mono text-[10.5px]">
              <span>workflow</span>
              <span className="text-muted">session · {agent.messages.length} messages</span>
            </div>
          ) : null}
          {agent.messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted">
              <div className="max-w-[42ch]">
                <div className="miami-accent mx-auto mb-2 h-1.5 w-12" />
                <p className="font-medium text-ink">Session ready</p>
                <p className="mt-1 leading-5">Messages persist through the local Flue SQLite store.</p>
              </div>
            </div>
          ) : (
            agent.messages.map((message) => (
              <article className={`chat-message chat-message-${message.role} space-y-1.5`} key={message.id}>
                <p className="font-mono text-[10px] font-semibold text-muted">{message.role}</p>
                <div className="space-y-2 text-[13px] leading-[1.55] text-ink">
                  {message.parts.map((part, index) =>
                    part.type === 'text' ? <p key={`${message.id}-${index}`}>{part.text}</p> : null,
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </ScrollArea>
      <form className="flex h-11 items-center gap-2.5 border-t border-line bg-field px-4" onSubmit={submit}>
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
