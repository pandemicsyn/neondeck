import type { KiloTaskDiffResponse, KiloTasksResponse } from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getKiloTasks(options: ApiRequestOptions = {}) {
  return getJson<KiloTasksResponse>(
    '/api/kilo/tasks?limit=8&includeDiff=1',
    options,
  );
}

export async function getKiloTaskDiff(
  taskId: string,
  options: ApiRequestOptions = {},
) {
  return getJson<KiloTaskDiffResponse>(
    `/api/kilo/tasks/${encodeURIComponent(taskId)}/diff`,
    options,
  );
}
