import {
  createFlueClient,
  type AgentSendResult,
  type FlueClient,
} from '@flue/sdk';
import { getLocalApiSession } from '../api/local-api-session';

export function createNeondeckConversationClient(
  agentName: string,
  conversationId: string,
  options: {
    onAdmission?: (admission: AgentSendResult) => void;
  } = {},
) {
  const client = createFlueClient({
    url: `/api/flue/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(conversationId)}`,
    fetch: authorizedFlueFetch,
  });
  return options.onAdmission
    ? observeFlueAdmissions(client, options.onAdmission)
    : client;
}

function observeFlueAdmissions(
  client: FlueClient,
  onAdmission: (admission: AgentSendResult) => void,
): FlueClient {
  return {
    url: client.url,
    abort: (options) => client.abort(options),
    attachmentUrl: (attachmentId) => client.attachmentUrl(attachmentId),
    history: (options) => client.history(options),
    observe: (options) => client.observe(options),
    read: (target, options) => client.read(target, options),
    send: async (options) => {
      const admission = await client.send(options);
      onAdmission(admission);
      return admission;
    },
    wait: (admission, options) => client.wait(admission, options),
  };
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

/** Fixed factory capability route; the server validates the durable task binding. */
export function createFactoryPlannerConversationClient(sessionId: string) {
  return createNeondeckConversationClient('factory-planner', sessionId);
}
