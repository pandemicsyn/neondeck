import type { PrWatchMutationResponse, PrWatchResponse } from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getPrWatches(options: ApiRequestOptions = {}) {
  return getJson<PrWatchResponse>('/api/watches', options);
}

export async function addPrWatch(input: {
  ref: string;
  desiredTerminalState?: 'checks' | 'merged' | 'prod';
}) {
  return postJson<PrWatchMutationResponse>('/api/watches', input);
}

export async function configurePrAutopilot(input: {
  ref: string;
  mode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  processExisting: boolean;
}) {
  return postJson<PrWatchMutationResponse>('/api/watches/autopilot', input);
}

export async function controlPrAutopilot(
  id: string,
  operation: 'pause' | 'resume' | 'retry' | 'stop',
) {
  return postJson<PrWatchMutationResponse>(
    `/api/watches/${encodeURIComponent(id)}/autopilot/control`,
    { operation },
  );
}

export async function messagePrAutopilotOwner(id: string, message: string) {
  return postJson<PrWatchMutationResponse>(
    `/api/watches/${encodeURIComponent(id)}/autopilot/message`,
    { message },
  );
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
