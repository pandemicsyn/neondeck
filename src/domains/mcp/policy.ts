import {
  mcpServerApprovalMode,
  type McpConfig,
  type McpExternalValue,
  type McpToolApprovalMode,
} from './schemas';
import * as v from 'valibot';

const mcpToolAnnotationsSchema = v.object({
  readOnlyHint: v.optional(v.boolean()),
  destructiveHint: v.optional(v.boolean()),
});

export type McpPolicyDecision = 'allow' | 'ask' | 'deny';

export function decideMcpToolPolicy(input: {
  config: McpConfig;
  serverId: string;
  toolName: string;
  annotations?: McpExternalValue;
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

export function isExplicitlyReadOnly(annotations: McpExternalValue) {
  const parsed = v.safeParse(mcpToolAnnotationsSchema, annotations);
  return (
    parsed.success &&
    parsed.output.readOnlyHint === true &&
    parsed.output.destructiveHint !== true
  );
}
