// The rich slash-command popup is the listbox owned by a multiline combobox;
// a native select/datalist cannot preserve descriptions and completion flow.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import { slashCommandDisplay } from './types';
import type { ChatSlashCommand } from './types';

export function SlashCommandTypeahead({
  activeCommand,
  activeCommandIndex,
  commands,
  compact = false,
  id,
  onSelect,
  open,
}: {
  activeCommand: ChatSlashCommand | undefined;
  activeCommandIndex: number;
  commands: readonly ChatSlashCommand[];
  compact?: boolean;
  id: string;
  onSelect: (command: ChatSlashCommand) => void;
  open: boolean;
}) {
  if (!open) return null;

  return (
    <div
      aria-label="Slash commands"
      className="command-typeahead absolute right-0 bottom-full left-0 z-10 border-t border-line bg-canvas font-mono"
      id={id}
      role="listbox"
    >
      {commands.slice(0, 6).map((command, index) => {
        const selected = activeCommand === command;
        const aliases = command.aliases?.map((alias) => `/${alias}`).join(', ');
        return (
          <button
            aria-selected={selected}
            className={`command-typeahead-option flex w-full items-center py-1.5 text-left ${compact ? 'gap-2 px-3' : 'gap-4 px-[18px]'}`}
            data-active={index === activeCommandIndex}
            id={`${id}-option-${index}`}
            key={`${command.scope}:${slashCommandDisplay(command).toLowerCase()}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
            role="option"
            tabIndex={-1}
            type="button"
          >
            <span
              className={`${compact ? 'w-[11ch]' : 'w-[18ch]'} shrink-0 truncate text-[13px] font-semibold text-ink`}
            >
              {slashCommandDisplay(command)}
            </span>
            <span className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
              {aliases ? (
                <span className="shrink-0 text-subtle">alias {aliases}</span>
              ) : null}
              <span className="truncate">{command.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
