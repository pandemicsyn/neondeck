import type { ChatSessionRecord } from '../../../api';

export function SessionSelect({
  activeSessionId,
  disabled,
  onSelect,
  sessions,
}: {
  activeSessionId: string | undefined;
  disabled: boolean;
  onSelect: (id: string) => void;
  sessions: ChatSessionRecord[];
}) {
  const pinned = sessions.filter(
    (session) => session.pinned && !session.archivedAt,
  );
  const recent = sessions.filter(
    (session) => !session.pinned && !session.archivedAt,
  );
  const archived = sessions.filter((session) => session.archivedAt);
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  );

  return (
    <select
      aria-label="Switch chat session"
      className="h-5 w-[32ch] max-w-full border border-line bg-field px-1 font-mono text-[10.5px] tracking-normal text-ink outline-none hover:border-primary"
      disabled={disabled || sessions.length === 0}
      onChange={(event) => onSelect(event.target.value)}
      title={sessionTooltip(activeSession)}
      value={activeSessionId ?? ''}
    >
      {!activeSessionId ? <option value="">Loading</option> : null}
      <SessionOptionGroup label="Pinned" sessions={pinned} />
      <SessionOptionGroup label="Recent" sessions={recent} />
      <SessionOptionGroup label="Archived" sessions={archived} />
    </select>
  );
}

function SessionOptionGroup({
  label,
  sessions,
}: {
  label: string;
  sessions: ChatSessionRecord[];
}) {
  if (sessions.length === 0) return null;

  return (
    <optgroup label={label}>
      {sessions.map((session) => (
        <option key={session.id} value={session.id}>
          {sessionLabel(session)}
        </option>
      ))}
    </optgroup>
  );
}

function sessionLabel(session: ChatSessionRecord) {
  const parts = [session.title];
  if (session.kind !== 'general' && session.kind !== 'main')
    parts.push(session.kind);
  if (session.staleReasons.length > 0) parts.push('context changed');
  if (session.archivedAt) parts.push('archived');
  return parts.join(' · ');
}

function sessionTooltip(session: ChatSessionRecord | undefined) {
  if (!session) return 'Switch chat';
  if (session.staleReasons.length === 0)
    return `Current chat: ${session.title}`;

  const reasons = session.staleReasons
    .map((reason) => reason.message)
    .join(' ');
  return `${reasons} Start a new chat to load the latest context.`;
}
