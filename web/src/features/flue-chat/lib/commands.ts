import type { NeonCommandDefinition } from '../../../api';
import { defaultCommandCatalog, type FlueChatCommand } from '../types';

export function mergeCommandCatalog(
  commands: FlueChatCommand[],
  supportedCommands: NeonCommandDefinition[] | undefined = undefined,
) {
  const canonicalCommands =
    supportedCommands !== undefined
      ? supportedCommands.map(commandFromDefinition)
      : defaultCommandCatalog;
  const canonicalCommandNames =
    supportedCommands === undefined
      ? undefined
      : new Set(canonicalCommands.map((command) => command.command));
  const detailsByCommand = new Map(
    defaultCommandCatalog.map((command) => [command.command, command]),
  );
  for (const command of canonicalCommands) {
    detailsByCommand.set(command.command, {
      ...detailsByCommand.get(command.command),
      ...command,
    });
  }

  const byCommand = new Map<string, FlueChatCommand>();
  for (const command of commands) {
    if (canonicalCommandNames && !canonicalCommandNames.has(command.command)) {
      continue;
    }
    byCommand.set(command.command, {
      ...detailsByCommand.get(command.command),
      ...command,
    });
  }
  for (const command of canonicalCommands) {
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

function commandFromDefinition(
  definition: NeonCommandDefinition,
): FlueChatCommand {
  const command = `/${definition.name}`;
  return {
    label:
      defaultCommandCatalog.find((item) => item.command === command)?.label ??
      commandLabel(definition.name),
    command,
    description: definition.description,
  };
}

function commandLabel(name: string) {
  return name
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
