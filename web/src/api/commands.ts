import { getJson } from './http';
import type { NeonCommandsResponse } from './types';

export function getNeonCommands() {
  return getJson<NeonCommandsResponse>('/api/commands');
}
