import type { PrWatchMutationResponse, PrWatchResponse } from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export type AutopilotWatchConfirmationIntent = {
  watchId: string;
  currentMode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  mode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  processExisting: boolean;
  intervalSeconds?: number;
  reason?: string;
};

export async function getPrWatches(options: ApiRequestOptions = {}) {
  return getJson<PrWatchResponse>('/api/watches', options);
}

export async function addPrWatch(input: {
  ref: string;
  desiredTerminalState?: 'checks' | 'merged' | 'prod';
}) {
  return postJson<PrWatchMutationResponse>('/api/watches', input);
}

export async function removePrWatch(id: string) {
  return postJson<PrWatchMutationResponse>(
    `/api/watches/${encodeURIComponent(id)}`,
    {
      confirm: true,
    },
  );
}

export async function setPrWatchPolling(id: string, enabled: boolean) {
  return postJson<PrWatchMutationResponse>(
    `/api/watches/${encodeURIComponent(id)}/polling`,
    { enabled },
  );
}

export type AutopilotWatchSetupResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  requires?: string[];
  errors?: string[];
  confirmation?: {
    required: boolean;
    accepted: boolean;
    intent?: AutopilotWatchConfirmationIntent;
  };
  watch?: PrWatchResponse['watches'][number];
  mode?:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  processExisting?: boolean;
  firstPlannedAction?: string;
  owner?: {
    id: string;
    status: string;
    flueInstanceId: string | null;
    worktreeId: string | null;
  };
  readiness?: {
    ok: boolean;
    ready?: boolean;
    status?: 'ready' | 'blocked' | 'warning';
    message?: string;
    blocking?: string[];
    requires?: string[];
  };
};

export async function configureAutopilotWatch(input: {
  ref: string;
  mode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  processExisting?: boolean;
  intervalSeconds?: number;
  reason?: string;
  confirm?: boolean;
  confirmation?: AutopilotWatchConfirmationIntent;
}) {
  return postJson<AutopilotWatchSetupResponse>(
    '/api/autopilot/watches/configure',
    input,
  );
}

export async function controlAutopilotWatch(input: {
  operation: 'list' | 'status' | 'pause' | 'resume' | 'stop' | 'retry';
  watchId?: string;
  admissionId?: string;
  confirm?: boolean;
}) {
  return postJson<AutopilotWatchSetupResponse>(
    '/api/autopilot/watches/control',
    input,
  );
}
