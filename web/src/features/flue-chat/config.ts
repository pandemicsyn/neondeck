import * as v from 'valibot';
import { plainConfigRecord } from '../../plugins/config';
import {
  flueChatDefaultConfig,
  type FlueChatCommand,
  type FlueChatSession,
} from './types';

const nonBlankStringSchema = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0),
);
const sessionSchema = v.object({
  id: nonBlankStringSchema,
  label: nonBlankStringSchema,
  placeholder: nonBlankStringSchema,
});
const commandSchema = v.object({
  label: nonBlankStringSchema,
  command: nonBlankStringSchema,
  description: v.optional(v.string()),
});

export function parseFlueChatConfig(
  config: Parameters<typeof plainConfigRecord>[0],
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

function parseAgentName(
  value: Parameters<typeof v.safeParse>[1],
  issues: string[],
) {
  if (value === undefined || value === flueChatDefaultConfig.agentName) {
    return flueChatDefaultConfig.agentName;
  }
  issues.push('agentName must be "display-assistant".');
  return flueChatDefaultConfig.agentName;
}

function parseSessions(
  value: Parameters<typeof v.safeParse>[1],
  issues: string[],
): FlueChatSession[] {
  if (value === undefined) return flueChatDefaultConfig.sessions;
  const array = v.safeParse(v.array(v.unknown()), value);
  if (!array.success) {
    issues.push('sessions must be an array.');
    return flueChatDefaultConfig.sessions;
  }
  const sessions = array.output.flatMap((item, index) => {
    const parsed = v.safeParse(sessionSchema, item);
    if (parsed.success) return [parsed.output];
    issues.push(
      `sessions[${index}] must include non-empty id, label, and placeholder strings.`,
    );
    return [];
  });
  if (sessions.length > 0) return sessions;
  issues.push('sessions did not contain any usable entries.');
  return flueChatDefaultConfig.sessions;
}

function parseQuickCommands(
  value: Parameters<typeof v.safeParse>[1],
  issues: string[],
): FlueChatCommand[] {
  if (value === undefined) return flueChatDefaultConfig.quickCommands;
  const array = v.safeParse(v.array(v.unknown()), value);
  if (!array.success) {
    issues.push('quickCommands must be an array.');
    return flueChatDefaultConfig.quickCommands;
  }
  const commands = array.output.flatMap((item, index) => {
    const parsed = v.safeParse(commandSchema, item);
    if (parsed.success) return [parsed.output];
    issues.push(
      `quickCommands[${index}] must include non-empty label and command strings.`,
    );
    return [];
  });
  if (commands.length > 0) return commands;
  issues.push('quickCommands did not contain any usable entries.');
  return flueChatDefaultConfig.quickCommands;
}
