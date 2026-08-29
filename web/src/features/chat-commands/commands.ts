import type { ChatSlashCommand } from './types';
import { slashCommandToken, slashCommandTokens } from './types';

export function slashCommandQueryFromInput(input: string) {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith('/')) return undefined;
  const firstToken = trimmedStart.split(/\s+/, 1)[0] ?? '';
  if (trimmedStart.length > firstToken.length) return undefined;
  return firstToken.slice(1).toLowerCase();
}

export function filterSlashCommands(
  commands: readonly ChatSlashCommand[],
  query: string | undefined,
) {
  if (query === undefined) return [];
  if (!query) return [...commands];
  return commands.filter((command) => {
    const names = [command.name, ...(command.aliases ?? [])].map((name) =>
      name.toLowerCase(),
    );
    const label = command.label.toLowerCase();
    const description = command.description.toLowerCase();
    return (
      names.some((name) => name.includes(query)) ||
      label.includes(query) ||
      description.includes(query)
    );
  });
}

export function clampSlashCommandIndex(index: number, commandCount: number) {
  if (commandCount <= 0) return 0;
  return Math.min(Math.max(index, 0), commandCount - 1);
}

export function slashCommandCompletion(command: ChatSlashCommand) {
  return `${command.completion ?? slashCommandToken(command)} `;
}

export function inputExactlyNamesSlashCommand(
  input: string,
  command: ChatSlashCommand,
) {
  const completion = command.completion?.trim().toLowerCase();
  if (completion && completion !== slashCommandToken(command).toLowerCase()) {
    return input.trim().toLowerCase() === completion;
  }
  return slashCommandTokens(command).includes(input.trim().toLowerCase());
}

export type SlashCommandMenuKeyAction =
  'complete' | 'dismiss' | 'next' | 'previous' | null;

export function slashCommandMenuKeyAction({
  activeCommand,
  input,
  key,
  menuOpen,
  shiftKey = false,
}: {
  activeCommand: ChatSlashCommand | undefined;
  input: string;
  key: string;
  menuOpen: boolean;
  shiftKey?: boolean;
}): SlashCommandMenuKeyAction {
  if (!menuOpen || !activeCommand) return null;
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'previous';
  if (key === 'Tab') return 'complete';
  if (key === 'Escape') return 'dismiss';
  if (
    key === 'Enter' &&
    !shiftKey &&
    !inputExactlyNamesSlashCommand(input, activeCommand)
  ) {
    return 'complete';
  }
  return null;
}
