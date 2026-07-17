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
