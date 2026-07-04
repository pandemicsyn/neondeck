import type {
  RepoRegistryResponse,
  RepoHealthResponse,
  RepoEditEventsResponse,
} from './types';
import { getJson } from './http';

export async function getRepoRegistry() {
  return getJson<RepoRegistryResponse>('/api/repos');
}

export async function getRepoHealth() {
  return getJson<RepoHealthResponse>('/api/repos/health');
}

export async function getRepoEditEvents() {
  return getJson<RepoEditEventsResponse>('/api/repo-edits');
}
