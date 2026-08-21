import { getJson, postJson, type ApiRequestOptions } from './http';
import { externalRecord } from './schemas';
import type { NeonCommandResult, NeonCommandsResponse } from './types';
import * as v from 'valibot';

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
  const data = externalRecord(result.data);
  if (!data) return undefined;
  const runId = v.safeParse(v.string(), data.runId);
  return runId.success ? runId.output : undefined;
}
