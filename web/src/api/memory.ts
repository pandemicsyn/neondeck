import type {
  ActiveMemoryScope,
  MemoryScope,
  MemoryRecord,
  MemoryResponse,
} from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getMemories(
  input: {
    scope?: MemoryScope;
    status?: 'active' | 'archived';
    includeArchived?: boolean;
  } = {},
  options: ApiRequestOptions = {},
) {
  const params = new URLSearchParams();
  if (input.scope) params.set('scope', input.scope);
  if (input.status) params.set('status', input.status);
  if (input.includeArchived) params.set('includeArchived', 'true');
  const query = params.toString();
  return getJson<MemoryResponse>(
    `/api/memories${query ? `?${query}` : ''}`,
    options,
  );
}

export async function upsertMemory(input: {
  scope: ActiveMemoryScope;
  key: string;
  value: unknown;
  repoId?: string;
  expectedUpdatedAt?: string;
  reason?: string;
}) {
  const result = await postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    memory?: MemoryRecord;
    errors?: string[];
    requires?: string[];
  }>('/api/memories', input);
  return successfulMemoryMutation(result);
}

export async function archiveMemory(
  id: string,
  options: {
    expectedUpdatedAt?: string;
    reason?: string;
  } = {},
) {
  const result = await postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    memory?: MemoryRecord;
    errors?: string[];
    requires?: string[];
  }>(`/api/memories/${encodeURIComponent(id)}/archive`, {
    reason: options.reason ?? 'Archived from the Memory dashboard.',
    confirm: true,
    ...(options.expectedUpdatedAt
      ? { expectedUpdatedAt: options.expectedUpdatedAt }
      : {}),
  });
  return successfulMemoryMutation(result);
}

function successfulMemoryMutation<T extends { ok: boolean; message: string }>(
  result: T,
) {
  if (!result.ok) throw new Error(result.message);
  return result;
}
