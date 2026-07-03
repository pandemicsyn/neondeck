import { defaultCommandCatalog, type FlueChatCommand } from '../types';

export function mergeCommandCatalog(commands: FlueChatCommand[]) {
  const byCommand = new Map<string, FlueChatCommand>();
  for (const command of commands) {
    byCommand.set(command.command, {
      ...defaultCommandDetails(command.command),
      ...command,
    });
  }
  for (const command of defaultCommandCatalog) {
    if (!byCommand.has(command.command))
      byCommand.set(command.command, command);
  }
  return [...byCommand.values()];
}

export function commandQueryFromInput(input: string) {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith('/')) return undefined;
  const firstToken = trimmedStart.split(/\s+/, 1)[0] ?? '';
  if (trimmedStart.length > firstToken.length) return undefined;
  return firstToken.slice(1).toLowerCase();
}

export function filterCommands(
  commands: FlueChatCommand[],
  query: string | undefined,
) {
  if (query === undefined) return [];
  if (!query) return commands;
  return commands.filter((command) => {
    const commandName = command.command.slice(1).toLowerCase();
    const label = command.label.toLowerCase();
    const description = command.description?.toLowerCase() ?? '';
    return (
      commandName.includes(query) ||
      label.includes(query) ||
      description.includes(query)
    );
  });
}

function defaultCommandDetails(command: string) {
  return defaultCommandCatalog.find((item) => item.command === command);
}
