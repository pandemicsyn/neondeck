import type {
  AutopilotState,
  AutopilotRecoveryActionId,
  AutopilotRecoveryResponse,
  AutopilotApprovalResolveResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getAutopilotState() {
  return getJson<AutopilotState>('/api/autopilot/state');
}

export async function getAutopilotRecoveryOptions(preparedDiffId: string) {
  return getJson<AutopilotRecoveryResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/recovery`,
  );
}

export async function runAutopilotRecovery(input: {
  preparedDiffId: string;
  recoveryAction: AutopilotRecoveryActionId;
  reason?: string;
  confirm?: boolean;
  checks?: string[];
  headRef?: string;
  headSha?: string;
  fetch?: boolean;
  dryRun?: boolean;
}) {
  const { preparedDiffId, ...body } = input;
  return postJson<AutopilotRecoveryResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/recovery/run`,
    body,
  );
}

export async function resolveAutopilotApproval(
  id: string,
  decision: 'approve' | 'deny',
) {
  return postJson<AutopilotApprovalResolveResponse>(
    `/api/autopilot/approvals/${encodeURIComponent(id)}/resolve`,
    {
      decision,
      approverSurface: 'dashboard',
    },
  );
}
