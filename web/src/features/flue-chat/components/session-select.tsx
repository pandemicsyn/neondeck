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

  return (
    <select
      aria-label="Switch chat session"
      className="h-5 max-w-[22ch] border border-line bg-field px-1 font-mono text-[10.5px] tracking-normal text-ink outline-none hover:border-primary"
      disabled={disabled || sessions.length === 0}
      onChange={(event) => onSelect(event.target.value)}
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
  if (session.kind !== 'general') parts.push(session.kind);
  if (session.staleReasons.length > 0) parts.push('stale');
  if (session.archivedAt) parts.push('archived');
  return parts.join(' · ');
}
