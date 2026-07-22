import type {
  DashboardConfig,
  ConfigActionResult,
  AgentModelUpdate,
  ProviderUpdate,
  AutopilotOwnerPromptMode,
  AutopilotPromptConfigResponse,
  PrReviewPromptConfigResponse,
  PrReviewPromptKind,
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

export async function getAutopilotPrompts(options: ApiRequestOptions = {}) {
  return getJson<AutopilotPromptConfigResponse>(
    '/api/autopilot/prompts',
    options,
  );
}

export async function updateAutopilotPrompt(input: {
  mode: AutopilotOwnerPromptMode;
  prompt: string | null;
}) {
  return postJson<AutopilotPromptConfigResponse>(
    '/api/autopilot/prompts',
    input,
  );
}

export async function getPrReviewPrompts(options: ApiRequestOptions = {}) {
  return getJson<PrReviewPromptConfigResponse>(
    '/api/pr-review/prompts',
    options,
  );
}

export async function updatePrReviewPrompt(input: {
  kind: PrReviewPromptKind;
  prompt: string | null;
}) {
  return postJson<PrReviewPromptConfigResponse>(
    '/api/pr-review/prompts',
    input,
  );
}
