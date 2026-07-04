import type { KiloTasksResponse } from './types';
import { getJson } from './http';

export async function getKiloTasks() {
  return getJson<KiloTasksResponse>('/api/kilo/tasks?limit=8&includeDiff=1');
}
