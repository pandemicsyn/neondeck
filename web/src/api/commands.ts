import { getJson, type ApiRequestOptions } from './http';
import type { NeonCommandsResponse } from './types';

export function getNeonCommands(options: ApiRequestOptions = {}) {
  return getJson<NeonCommandsResponse>('/api/commands', options);
}
