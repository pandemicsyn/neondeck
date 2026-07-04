import type {
  RuntimeHealth,
  RuntimeStatus,
  RuntimeSkillsResponse,
  HostMetrics,
} from './types';
import { getJson } from './http';

export async function getRuntimeHealth() {
  return getJson<RuntimeHealth>('/api/health');
}

export async function getRuntimeStatus() {
  return getJson<RuntimeStatus>('/api/runtime/status');
}

export async function getRuntimeSkills() {
  return getJson<RuntimeSkillsResponse>('/api/skills');
}

export async function getHostMetrics() {
  return getJson<HostMetrics>('/api/metrics/host');
}
