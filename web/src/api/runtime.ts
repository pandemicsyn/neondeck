import type {
  RuntimeHealth,
  RuntimeStatus,
  RuntimeSkillsResponse,
  HostMetrics,
} from './types';
import { getJson, type ApiRequestOptions } from './http';

export async function getRuntimeHealth(options: ApiRequestOptions = {}) {
  return getJson<RuntimeHealth>('/api/health', options);
}

export async function getRuntimeStatus(options: ApiRequestOptions = {}) {
  return getJson<RuntimeStatus>('/api/runtime/status', options);
}

export async function getRuntimeSkills(options: ApiRequestOptions = {}) {
  return getJson<RuntimeSkillsResponse>('/api/skills', options);
}

export async function getHostMetrics(options: ApiRequestOptions = {}) {
  return getJson<HostMetrics>('/api/metrics/host', options);
}
