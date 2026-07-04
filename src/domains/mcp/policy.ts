import type { McpConfig } from './schemas';

export type McpPolicyDecision = 'allow' | 'ask' | 'deny';

export function decideMcpToolPolicy(input: {
  config: McpConfig;
  serverId: string;
  toolName: string;
}): McpPolicyDecision {
  const server = input.config.servers[input.serverId];
  const policy = server?.tools;
  if (policy?.deny?.includes(input.toolName)) return 'deny';
  if (policy?.autoApprove?.includes(input.toolName)) return 'allow';
  return 'ask';
}
