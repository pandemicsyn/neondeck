import type { KiloTaskDiffResponse, KiloTasksResponse } from './types';
import { getJson } from './http';

export async function getKiloTasks() {
  return getJson<KiloTasksResponse>('/api/kilo/tasks?limit=8&includeDiff=1');
}

export async function getKiloTaskDiff(taskId: string) {
  return getJson<KiloTaskDiffResponse>(
    `/api/kilo/tasks/${encodeURIComponent(taskId)}/diff`,
  );
}
