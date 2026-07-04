import type { SafetyPolicy } from './types';
import { getJson } from './http';

export async function getSafetyPolicy() {
  return getJson<SafetyPolicy>('/api/safety/policy');
}
