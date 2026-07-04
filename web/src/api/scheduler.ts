import type { SchedulerJobsResponse } from './types';
import { getJson } from './http';

export async function getSchedulerJobs() {
  return getJson<SchedulerJobsResponse>('/api/jobs');
}
