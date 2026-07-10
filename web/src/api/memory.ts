import type {
  ActiveMemoryScope,
  MemoryScope,
  MemoryRecord,
  MemoryResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getMemories(
  input: {
    scope?: MemoryScope;
    status?: 'active' | 'archived';
    includeArchived?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  if (input.scope) params.set('scope', input.scope);
  if (input.status) params.set('status', input.status);
  if (input.includeArchived) params.set('includeArchived', 'true');
  const query = params.toString();
  return getJson<MemoryResponse>(`/api/memories${query ? `?${query}` : ''}`);
}

export async function upsertMemory(input: {
  scope: ActiveMemoryScope;
  key: string;
  value: unknown;
  repoId?: string;
  reason?: string;
}) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    memory?: MemoryRecord;
    errors?: string[];
    requires?: string[];
  }>('/api/memories', input);
}
