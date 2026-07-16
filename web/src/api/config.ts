import type {
  DashboardConfig,
  ConfigActionResult,
  AgentModelUpdate,
  ProviderUpdate,
} from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getDashboardConfig(options: ApiRequestOptions = {}) {
  return getJson<DashboardConfig>('/api/dashboard/config', options);
}

export async function updateDashboardConfig(input: DashboardConfig) {
  return postJson<ConfigActionResult>('/api/dashboard/config', input);
}

export async function applyDashboardPreset(input: {
  preset: 'classic' | 'cockpit';
  statuslinePosition?: 'top' | 'bottom';
}) {
  return postJson<ConfigActionResult>('/api/dashboard/preset', input);
}

export async function updateAgentModels(input: AgentModelUpdate) {
  return postJson<ConfigActionResult>('/api/models', input);
}

export async function updateProvider(provider: string, input: ProviderUpdate) {
  return postJson<ConfigActionResult>(`/api/providers/${provider}`, input);
}
