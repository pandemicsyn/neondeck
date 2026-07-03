import type { NeonCommandResult } from '../../../api';
import { Badge } from '../../../components/ui';
import type { FlueChatCommand } from '../types';

export function CommandResultSummary({
  latest,
  runningCommand,
}: {
  latest: NeonCommandResult | undefined;
  runningCommand: string | undefined;
}) {
  if (!latest && !runningCommand) return null;

  return (
    <section className="border border-line bg-soft px-3 py-2 font-mono text-[10.5px] leading-4">
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            latest?.ok === false || !latest
              ? 'min-w-0 truncate text-accent'
              : 'min-w-0 truncate text-primary'
          }
        >
          {runningCommand ?? latest?.input}
        </span>
        <Badge>{runningCommand ? 'running' : latest?.status}</Badge>
      </div>
      {latest ? <p className="mt-1 text-muted">{latest.message}</p> : null}
    </section>
  );
}

export function CommandTypeahead({
  activeCommand,
  activeCommandIndex,
  commands,
  onSelect,
  open,
}: {
  activeCommand: FlueChatCommand | undefined;
  activeCommandIndex: number;
  commands: FlueChatCommand[];
  onSelect: (command: FlueChatCommand) => void;
  open: boolean;
}) {
  if (!open) return null;

  return (
    <div
      aria-label="Slash commands"
      className="command-typeahead absolute right-0 bottom-full left-0 z-10 border-t border-line bg-canvas font-mono"
      id="flue-command-typeahead"
    >
      {commands.slice(0, 6).map((command, index) => {
        const selected = activeCommand?.command === command.command;
        return (
          <button
            aria-current={selected}
            className="command-typeahead-option flex w-full items-center gap-4 px-[18px] py-1.5 text-left"
            data-active={index === activeCommandIndex}
            key={command.command}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
            type="button"
          >
            <span className="w-[18ch] shrink-0 truncate text-[13px] font-semibold text-ink">
              {command.command}
            </span>
            <span className="min-w-0 truncate text-[12px] text-muted">
              {command.description ?? command.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
