import { plainConfigRecord } from '../../plugins/config';
import {
  flueChatDefaultConfig,
  type FlueChatCommand,
  type FlueChatSession,
} from './types';

export function parseFlueChatConfig(
  config: Record<string, unknown> | undefined,
) {
  const source = plainConfigRecord(config);
  const issues: string[] = [];

  return {
    config: {
      agentName: parseAgentName(source.agentName, issues),
      sessions: parseSessions(source.sessions, issues),
      quickCommands: parseQuickCommands(source.quickCommands, issues),
    },
    issues,
  };
}

function parseAgentName(value: unknown, issues: string[]) {
  if (value === undefined || value === flueChatDefaultConfig.agentName) {
    return flueChatDefaultConfig.agentName;
  }
  issues.push('agentName must be "display-assistant".');
  return flueChatDefaultConfig.agentName;
}

function parseSessions(value: unknown, issues: string[]) {
  if (value === undefined) return flueChatDefaultConfig.sessions;
  if (!Array.isArray(value)) {
    issues.push('sessions must be an array.');
    return flueChatDefaultConfig.sessions;
  }

  const sessions = value.flatMap((item, index): FlueChatSession[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`sessions[${index}] must be an object.`);
      return [];
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.label !== 'string' ||
      typeof record.placeholder !== 'string' ||
      record.id.trim().length === 0 ||
      record.label.trim().length === 0 ||
      record.placeholder.trim().length === 0
    ) {
      issues.push(
        `sessions[${index}] must include non-empty id, label, and placeholder strings.`,
      );
      return [];
    }
    return [
      {
        id: record.id,
        label: record.label,
        placeholder: record.placeholder,
      },
    ];
  });

  if (sessions.length > 0) return sessions;
  issues.push('sessions did not contain any usable entries.');
  return flueChatDefaultConfig.sessions;
}

function parseQuickCommands(value: unknown, issues: string[]) {
  if (value === undefined) return flueChatDefaultConfig.quickCommands;
  if (!Array.isArray(value)) {
    issues.push('quickCommands must be an array.');
    return flueChatDefaultConfig.quickCommands;
  }

  const commands = value.flatMap((item, index): FlueChatCommand[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`quickCommands[${index}] must be an object.`);
      return [];
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.label !== 'string' ||
      typeof record.command !== 'string' ||
      record.label.trim().length === 0 ||
      record.command.trim().length === 0
    ) {
      issues.push(
        `quickCommands[${index}] must include non-empty label and command strings.`,
      );
      return [];
    }
    return [
      {
        label: record.label,
        command: record.command,
        ...(typeof record.description === 'string'
          ? { description: record.description }
          : {}),
      },
    ];
  });

  if (commands.length > 0) return commands;
  issues.push('quickCommands did not contain any usable entries.');
  return flueChatDefaultConfig.quickCommands;
}
