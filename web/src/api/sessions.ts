import type {
  ChatSessionKind,
  NeonSessionState,
  ChatSessionListResponse,
  ChatSessionMutationResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getNeonSession() {
  return getJson<NeonSessionState>('/api/session');
}

export async function getChatSessions(
  input: { includeArchived?: boolean } = {},
) {
  const query = input.includeArchived ? '?includeArchived=1' : '';
  return getJson<ChatSessionListResponse>(`/api/sessions${query}`);
}

export async function startNeonSession(
  input: {
    label?: string;
    reason?: string;
  } = {},
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    state?: NeonSessionState;
    errors?: string[];
  }>('/api/session/new', input);
}

export async function createChatSession(
  input: {
    title?: string;
    kind?: ChatSessionKind;
    activate?: boolean;
    surface?: string;
    linkedRepoId?: string | null;
    linkedWatchId?: string | null;
    linkedTaskId?: string | null;
    uiMetadata?: unknown;
    summary?: string | null;
    summarySource?: 'manual' | 'metadata' | 'agent' | 'transcript-summary';
    reason?: string;
  } = {},
) {
  return postJson<ChatSessionMutationResponse>('/api/sessions', input);
}

export async function refreshChatSessionSummary(
  id: string,
  input: {
    providedSummary?: string;
    source?: 'manual' | 'metadata' | 'agent' | 'transcript-summary';
    reason?: string;
    surface?: string;
  } = {},
) {
  return postJson<ChatSessionMutationResponse>(
    `/api/sessions/${id}/summary/refresh`,
    input,
  );
}

export async function referenceChatSession(
  id: string,
  input: {
    fromSessionId?: string;
    reason?: string;
    surface?: string;
    includeRawTranscript?: boolean;
    explicitUserRequest?: boolean;
  } = {},
) {
  return postJson<ChatSessionMutationResponse>(
    `/api/sessions/${id}/reference`,
    input,
  );
}

export async function switchChatSession(id: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/switch`, {
    surface: 'dashboard',
    reason: 'dashboard-session-switcher',
  });
}

export async function renameChatSession(id: string, title: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/rename`, {
    title,
    reason: 'dashboard-session-switcher',
  });
}

export async function pinChatSession(id: string, pinned: boolean) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/pin`, {
    pinned,
    reason: 'dashboard-session-switcher',
  });
}

export async function archiveChatSession(id: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/archive`, {
    surface: 'dashboard',
    reason: 'dashboard-session-switcher',
  });
}

export async function restoreChatSession(id: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/restore`, {
    surface: 'dashboard',
    reason: 'dashboard-session-switcher',
  });
}
