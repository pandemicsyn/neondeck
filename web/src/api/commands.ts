import { getJson, postJson, type ApiRequestOptions } from './http';
import type { NeonCommandResult, NeonCommandsResponse } from './types';

export function getNeonCommands(options: ApiRequestOptions = {}) {
  return getJson<NeonCommandsResponse>('/api/commands', options);
}

export function runNeonCommand(input: {
  command: string;
  sessionId?: string;
  surface?: string;
}) {
  return postJson<NeonCommandResult>('/api/commands/run', input);
}

export function neonCommandRunId(result: NeonCommandResult) {
  if (!result.data || typeof result.data !== 'object') return undefined;
  if (!('runId' in result.data)) return undefined;
  return typeof result.data.runId === 'string' ? result.data.runId : undefined;
}
