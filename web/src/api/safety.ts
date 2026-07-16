import type { SafetyPolicy } from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getSafetyPolicy(options: ApiRequestOptions = {}) {
  return getJson<SafetyPolicy>('/api/safety/policy', options);
}
