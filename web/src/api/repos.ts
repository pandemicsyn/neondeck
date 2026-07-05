import type {
  RepoRegistryResponse,
  RepoHealthResponse,
  RepoEditEventsResponse,
  RepoDiffResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getRepoRegistry() {
  return getJson<RepoRegistryResponse>('/api/repos');
}

export async function getRepoHealth() {
  return getJson<RepoHealthResponse>('/api/repos/health');
}

export async function getRepoEditEvents() {
  return getJson<RepoEditEventsResponse>('/api/repo-edits');
}

export async function getRepoDiff(input: {
  repoId: string;
  worktreeId?: string | null;
  base?: string;
  paths?: string[];
  includePatch?: boolean;
  maxPatchBytes?: number;
}) {
  const { repoId, ...body } = input;
  const payload = {
    ...body,
    worktreeId: body.worktreeId ?? undefined,
    paths: body.paths && body.paths.length > 0 ? body.paths : undefined,
  };
  return postJson<RepoDiffResponse>(
    `/api/repos/${encodeURIComponent(repoId)}/diff`,
    payload,
  );
}
