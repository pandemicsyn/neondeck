import type { ExecutionApproval, ExecutionApprovalsResponse } from './types';
import { getJson, postJson } from './http';

export async function getExecutionApprovals(
  input: { includeResolved?: boolean } = {},
) {
  const query = input.includeResolved ? '?includeResolved=1' : '';
  return getJson<ExecutionApprovalsResponse>(
    `/api/execution/approvals${query}`,
  );
}

export async function resolveExecutionApproval(
  id: string,
  decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny',
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    approval?: ExecutionApproval;
    requires?: string[];
    errors?: string[];
  }>(`/api/execution/approvals/${id}/resolve`, {
    decision,
    approverSurface: 'dashboard',
  });
}
