import type { WorktreesResponse } from './types';
import { getJson } from './http';

export async function getWorktrees() {
  return getJson<WorktreesResponse>('/api/worktrees');
}
