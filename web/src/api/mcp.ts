import type {
  McpApproval,
  McpApprovalsResponse,
  McpLoginResponse,
  McpServersResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getMcpServers() {
  return getJson<McpServersResponse>('/api/mcp/servers');
}

export async function getMcpApprovals(
  input: { includeResolved?: boolean } = {},
) {
  const query = input.includeResolved ? '?includeResolved=1' : '';
  return getJson<McpApprovalsResponse>(`/api/mcp/approvals${query}`);
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
  decision: 'approve' | 'deny',
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
