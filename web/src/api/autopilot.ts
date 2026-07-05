import type {
  AutopilotState,
  AutopilotRecoveryActionId,
  AutopilotRecoveryResponse,
  AutopilotApprovalResolveResponse,
  PreparedDiffFileDiffResponse,
  PreparedDiffFilesResponse,
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

export async function getPreparedDiffFiles(preparedDiffId: string) {
  return getJson<PreparedDiffFilesResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/files`,
  );
}

export async function getPreparedDiffFileDiff(input: {
  preparedDiffId: string;
  path: string;
  maxPatchBytes?: number;
}) {
  const params = new URLSearchParams({ path: input.path });
  if (input.maxPatchBytes) {
    params.set('maxPatchBytes', String(input.maxPatchBytes));
  }
  return getJson<PreparedDiffFileDiffResponse>(
    `/api/prepared-diffs/${encodeURIComponent(input.preparedDiffId)}/files/diff?${params.toString()}`,
  );
}

export async function runAutopilotRecovery(input: {
  preparedDiffId: string;
  recoveryAction: AutopilotRecoveryActionId;
  reason?: string;
  runRevisionNow?: boolean;
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
  input: { reason?: string; runRevisionNow?: boolean } = {},
) {
  return postJson<AutopilotApprovalResolveResponse>(
    `/api/autopilot/approvals/${encodeURIComponent(id)}/resolve`,
    {
      decision,
      approverSurface: 'dashboard',
      ...input,
    },
  );
}
