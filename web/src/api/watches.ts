import type { PrWatchResponse } from './types';
import { getJson } from './http';

export async function getPrWatches() {
  return getJson<PrWatchResponse>('/api/watches');
}
