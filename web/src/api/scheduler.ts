import type { ScheduledTasksResponse } from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getScheduledTasks(options: ApiRequestOptions = {}) {
  return getJson<ScheduledTasksResponse>('/api/scheduled-tasks', options);
}
