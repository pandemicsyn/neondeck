import { createFlueClient } from '@flue/sdk';
import { getLocalApiSession } from '../api/local-api-session';

export function createNeondeckConversationClient(
  agentName: string,
  conversationId: string,
) {
  return createFlueClient({
    url: `/api/flue/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(conversationId)}`,
    fetch: authorizedFlueFetch,
  });
}

async function authorizedFlueFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const session = await getLocalApiSession();
  const headers = new Headers(init?.headers);
  if (session?.token) {
    headers.set(session.header || 'x-neondeck-api-token', session.token);
  }
  return fetch(input, { ...init, headers });
}
