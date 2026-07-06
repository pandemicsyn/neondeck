import { deleteJson, getJson, postJson } from './http';
import type {
  RoutineConfigResponse,
  RoutineConfigUpdateResponse,
  RoutineCreateInput,
  RoutineListResponse,
  RoutineMutationResponse,
  RoutineReadResponse,
  RoutineUpdateInput,
} from './types';

export async function getRoutines() {
  const response = await getJson<RoutineListResponse>('/api/routines');
  if (!response.ok)
    throw new Error(response.message ?? 'Routines unavailable.');
  return response;
}

export async function getRoutine(id: string) {
  const response = await getJson<RoutineReadResponse>(
    `/api/routines/${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw new Error(response.message ?? 'Routine unavailable.');
  return response;
}

export async function createRoutine(input: RoutineCreateInput) {
  const response = await postJson<RoutineMutationResponse>(
    '/api/routines',
    input,
  );
  if (!response.ok)
    throw new Error(response.message ?? 'Could not create routine.');
  return response;
}

export async function updateRoutine(id: string, input: RoutineUpdateInput) {
  const response = await postJson<RoutineMutationResponse>(
    `/api/routines/${encodeURIComponent(id)}`,
    input,
  );
  if (!response.ok)
    throw new Error(response.message ?? 'Could not update routine.');
  return response;
}

export async function runRoutine(id: string) {
  const response = await postJson<RoutineMutationResponse>(
    `/api/routines/${encodeURIComponent(id)}/run`,
    {},
  );
  if (!response.ok)
    throw new Error(response.message ?? 'Could not run routine.');
  return response;
}

export async function setRoutineEnabled(id: string, enabled: boolean) {
  const response = await postJson<RoutineMutationResponse>(
    `/api/routines/${encodeURIComponent(id)}/${enabled ? 'resume' : 'pause'}`,
    {},
  );
  if (!response.ok) {
    throw new Error(response.message ?? 'Could not update routine.');
  }
  return response;
}

export async function deleteRoutine(id: string) {
  const response = await deleteJson<RoutineMutationResponse>(
    `/api/routines/${encodeURIComponent(id)}?confirm=true`,
  );
  if (!response.ok)
    throw new Error(response.message ?? 'Could not delete routine.');
  return response;
}

export async function getRoutineConfig() {
  const response = await getJson<RoutineConfigResponse>('/api/routines/config');
  if (!response.ok) {
    throw new Error(response.message ?? 'Routine config unavailable.');
  }
  return response;
}

export async function updateRoutineConfig(enabled: boolean) {
  const response = await postJson<RoutineConfigUpdateResponse>(
    '/api/routines/config',
    { enabled },
  );
  if (!response.ok) {
    throw new Error(response.message ?? 'Could not update routine config.');
  }
  return response;
}
