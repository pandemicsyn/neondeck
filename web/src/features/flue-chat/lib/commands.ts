import type { NeonCommandDefinition } from '../../../api';
import {
  clampSlashCommandIndex,
  filterSlashCommands,
  slashCommandQueryFromInput,
} from '../../chat-commands/commands';
import type { ChatSlashCommand } from '../../chat-commands/types';
import { defaultCommandCatalog, type FlueChatCommand } from '../types';

export function mergeCommandCatalog(
  commands: FlueChatCommand[],
  supportedCommands: NeonCommandDefinition[] | undefined = undefined,
) {
  const defaultCommands = defaultCommandCatalog.map(commandFromQuickCommand);
  const canonicalCommands =
    supportedCommands !== undefined
      ? supportedCommands.map(commandFromDefinition)
      : defaultCommands;
  const canonicalCommandNames =
    supportedCommands === undefined
      ? undefined
      : new Set(canonicalCommands.map((command) => command.name));
  const detailsByName = new Map(
    defaultCommands.map((command) => [command.name, command]),
  );
  for (const command of canonicalCommands) {
    detailsByName.set(command.name, {
      ...detailsByName.get(command.name),
      ...command,
    });
  }

  const byCompletion = new Map<string, ChatSlashCommand>();
  const configuredNames = new Set<string>();
  for (const quickCommand of commands) {
    const command = commandFromQuickCommand(quickCommand);
    if (canonicalCommandNames && !canonicalCommandNames.has(command.name)) {
      continue;
    }
    configuredNames.add(command.name);
    const details = detailsByName.get(command.name);
    byCompletion.set(command.completion!.trim().toLowerCase(), {
      ...details,
      ...command,
      description:
        quickCommand.description ?? details?.description ?? command.description,
      usage: details?.usage ?? command.usage,
    });
  }
  for (const command of canonicalCommands) {
    if (!configuredNames.has(command.name)) {
      byCompletion.set(command.name, command);
    }
  }
  return [...byCompletion.values()];
}

export const commandQueryFromInput = slashCommandQueryFromInput;
export const filterCommands = filterSlashCommands;
export const clampCommandIndex = clampSlashCommandIndex;

function commandFromDefinition(
  definition: NeonCommandDefinition,
): ChatSlashCommand {
  return {
    label:
      defaultCommandCatalog.find(
        (item) => commandName(item.command) === definition.name,
      )?.label ?? commandLabel(definition.name),
    name: definition.name,
    usage: definition.usage,
    description: definition.description,
    scope: 'main',
    dispatch: { kind: 'app-command' },
  };
}

function commandFromQuickCommand(command: FlueChatCommand): ChatSlashCommand {
  const name = commandName(command.command);
  return {
    completion: command.command,
    label: command.label,
    name,
    usage: command.command,
    description: command.description ?? command.label,
    scope: 'main',
    dispatch: { kind: 'app-command' },
  };
}

function commandName(command: string) {
  return command.replace(/^\//, '').split(/\s+/, 1)[0]!.toLowerCase();
}

function commandLabel(name: string) {
  return name
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
