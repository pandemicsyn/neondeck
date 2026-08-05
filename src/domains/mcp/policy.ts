import {
  mcpServerApprovalMode,
  type McpConfig,
  type McpToolApprovalMode,
} from './schemas';

export type McpPolicyDecision = 'allow' | 'ask' | 'deny';

export function decideMcpToolPolicy(input: {
  config: McpConfig;
  serverId: string;
  toolName: string;
  annotations?: unknown;
}): McpPolicyDecision {
  const server = input.config.servers[input.serverId];
  if (!server) return 'deny';
  const override = server.tools?.overrides?.[input.toolName];
  if (override) return decisionForToolMode(override);

  const mode = mcpServerApprovalMode(server);
  if (mode === 'approve') return 'allow';
  if (mode === 'prompt') return 'ask';
  return isExplicitlyReadOnly(input.annotations) ? 'allow' : 'ask';
}

function decisionForToolMode(mode: McpToolApprovalMode): McpPolicyDecision {
  if (mode === 'approve') return 'allow';
  if (mode === 'deny') return 'deny';
  return 'ask';
}

export function isExplicitlyReadOnly(annotations: unknown) {
  if (
    !annotations ||
    typeof annotations !== 'object' ||
    Array.isArray(annotations)
  ) {
    return false;
  }
  const value = annotations as Record<string, unknown>;
  return value.readOnlyHint === true && value.destructiveHint !== true;
}
