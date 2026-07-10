import type { ScheduledTasksResponse } from './types';
import { getJson } from './http';

export async function getScheduledTasks() {
  return getJson<ScheduledTasksResponse>('/api/scheduled-tasks');
}
