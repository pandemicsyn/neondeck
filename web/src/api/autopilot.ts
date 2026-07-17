import type {
  AutopilotState,
  AutopilotRecoveryActionId,
  AutopilotRecoveryResponse,
  AutopilotApprovalResolveResponse,
  PreparedDiffFileDiffResponse,
  PreparedDiffFilesResponse,
} from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getAutopilotState(options: ApiRequestOptions = {}) {
  return getJson<AutopilotState>('/api/autopilot/state', options);
}

export async function getAutopilotRecoveryOptions(
  preparedDiffId: string,
  options: ApiRequestOptions = {},
) {
  return getJson<AutopilotRecoveryResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/recovery`,
    options,
  );
}

export async function getPreparedDiffFiles(
  preparedDiffId: string,
  options: ApiRequestOptions = {},
) {
  return getJson<PreparedDiffFilesResponse>(
    `/api/prepared-diffs/${encodeURIComponent(preparedDiffId)}/files`,
    options,
  );
}

export async function getPreparedDiffFileDiff(
  input: {
    preparedDiffId: string;
    path: string;
    maxPatchBytes?: number;
  },
  options: ApiRequestOptions = {},
) {
  const params = new URLSearchParams({ path: input.path });
  if (input.maxPatchBytes) {
    params.set('maxPatchBytes', String(input.maxPatchBytes));
  }
  return getJson<PreparedDiffFileDiffResponse>(
    `/api/prepared-diffs/${encodeURIComponent(input.preparedDiffId)}/files/diff?${params.toString()}`,
    options,
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
