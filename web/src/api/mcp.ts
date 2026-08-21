import type {
  McpApproval,
  McpApprovalsResponse,
  McpLoginResponse,
  McpServersResponse,
} from './types';
import { getJson, patchJson, postJson, type ApiRequestOptions } from './http';

type McpApprovalModeTools = {
  approvalMode: 'prompt' | 'writes' | 'approve';
  overrides?: Record<string, 'prompt' | 'approve' | 'deny'>;
};

export async function getMcpServers(options: ApiRequestOptions = {}) {
  return getJson<McpServersResponse>('/api/mcp/servers', options);
}

export async function getMcpApprovals(
  input: { includeResolved?: boolean } = {},
  options: ApiRequestOptions = {},
) {
  const query = input.includeResolved ? '?includeResolved=1' : '';
  return getJson<McpApprovalsResponse>(`/api/mcp/approvals${query}`, options);
}

export async function startMcpLogin(id: string) {
  return postJson<McpLoginResponse>(`/api/mcp/servers/${id}/login`, {});
}

export async function logoutMcpServer(id: string) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
  }>(`/api/mcp/servers/${id}/logout`, { confirm: true });
}

export async function resolveMcpApproval(
  id: string,
  decision: 'allow-once' | 'allow-chat' | 'allow-always' | 'deny',
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    approval?: McpApproval;
    requires?: string[];
    errors?: string[];
  }>(`/api/mcp/approvals/${id}/resolve`, {
    decision,
    approverSurface: 'dashboard',
  });
}

export async function updateMcpApprovalMode(
  id: string,
  approvalMode: 'prompt' | 'writes' | 'approve',
  toolOverrides: Record<string, 'prompt' | 'approve' | 'deny'>,
) {
  const tools: McpApprovalModeTools = { approvalMode };
  if (Object.keys(toolOverrides).length > 0) tools.overrides = toolOverrides;
  return patchJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
  }>(`/api/mcp/servers/${id}`, {
    server: {
      tools,
    },
  });
}
