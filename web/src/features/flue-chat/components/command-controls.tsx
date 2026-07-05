import type { NeonCommandResult } from '../../../api';
import { Badge, Button } from '../../../components/ui';
import type { FlueChatCommand } from '../types';

export function CommandResultSummary({
  event,
  onAsk,
}: {
  event: {
    input: string;
    status: 'running' | 'completed' | 'failed';
    result?: (NeonCommandResult & { flueRunId?: string }) | undefined;
  };
  onAsk?: () => void;
}) {
  const failed = event.result?.ok === false || event.status === 'failed';
  return (
    <section className="border border-line bg-soft px-3 py-2 font-mono text-[10.5px] leading-4">
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            failed
              ? 'min-w-0 truncate text-accent'
              : 'min-w-0 truncate text-primary'
          }
        >
          {event.input}
        </span>
        <Badge>{event.status}</Badge>
      </div>
      {event.result ? (
        <div className="mt-1 flex items-start justify-between gap-3 text-muted">
          <p className="min-w-0">{event.result.message}</p>
          {onAsk ? (
            <Button
              className="min-h-[24px] shrink-0 bg-transparent px-1.5 py-0 text-[10px]"
              onClick={onAsk}
              type="button"
            >
              ask Neon
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-muted">Command workflow is running.</p>
      )}
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
