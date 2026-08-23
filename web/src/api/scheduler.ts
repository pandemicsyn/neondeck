import type {
  ScheduledRunArtifact,
  ScheduledTaskRun,
  ScheduledTasksResponse,
  TaskWorkspace,
  PhysicalWorkspaceQuarantine,
  WorkspaceProviderState,
} from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getScheduledTasks(options: ApiRequestOptions = {}) {
  return getJson<ScheduledTasksResponse>('/api/scheduled-tasks', options);
}

export function getWorkspaceProviders(options: ApiRequestOptions = {}) {
  return getJson<{
    defaultProviderId: string;
    defaultRemoteProviderId: string | null;
    providers: WorkspaceProviderState[];
  }>('/api/workspace-providers', options);
}

export function getScheduledWorkspaceQuarantines(
  options: ApiRequestOptions = {},
) {
  return getJson<{ quarantines: PhysicalWorkspaceQuarantine[] }>(
    '/api/scheduled-workspace-quarantines',
    options,
  );
}

export function clearScheduledWorkspaceQuarantine(
  physicalResourceKey: string,
  confirm: boolean,
) {
  return postJson<{ ok: boolean; changed: boolean; message: string }>(
    '/api/scheduled-workspace-quarantines/clear',
    { physicalResourceKey, confirm },
  );
}

export function getScheduledTaskRuns(
  id: string,
  options: ApiRequestOptions = {},
) {
  return getJson<{ runs: ScheduledTaskRun[] }>(
    `/api/scheduled-tasks/${encodeURIComponent(id)}/runs`,
    options,
  );
}

export function getScheduledTaskRun(
  id: string,
  options: ApiRequestOptions = {},
) {
  return getJson<{
    run: ScheduledTaskRun;
    workspace?: TaskWorkspace;
    artifacts: ScheduledRunArtifact[];
  }>(`/api/scheduled-task-runs/${encodeURIComponent(id)}`, options);
}

export function createScheduledInstruction(body: unknown) {
  return postJson<{ ok: boolean; message: string }>(
    '/api/scheduled-tasks/instructions',
    body,
  );
}

export function runScheduledTaskNow(id: string) {
  return postJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, {});
}

export function pauseScheduledTask(id: string) {
  return postJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/pause`, {});
}

export function resumeScheduledTask(id: string) {
  return postJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/resume`, {});
}

export function retryScheduledTaskRun(id: string) {
  return postJson(
    `/api/scheduled-task-runs/${encodeURIComponent(id)}/retry`,
    {},
  );
}

export function retainScheduledTaskRun(id: string) {
  return postJson(
    `/api/scheduled-task-runs/${encodeURIComponent(id)}/retain`,
    {},
  );
}

export function cleanupScheduledTaskRun(id: string, confirm: boolean) {
  return postJson(
    `/api/scheduled-task-runs/${encodeURIComponent(id)}/cleanup`,
    { confirm },
  );
}
