import type { WorktreesResponse } from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getWorktrees(options: ApiRequestOptions = {}) {
  return getJson<WorktreesResponse>('/api/worktrees', options);
}
