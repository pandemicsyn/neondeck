import { exports as workerExports } from 'cloudflare:workers';
import { z } from 'zod';
import type { JsonObject } from '../src/json';

export const githubWebhookSecret = "It's a Secret to Everybody";
export const webSocketClientSecret = 'test-client-secret-0123456789';

const messageDataSchema = z.string();

const openSockets = new Set<WebSocket>();

export type GithubRequestOptions = {
  body?: string;
  channel?: string;
  declaredLength?: number;
  deliveryId?: string;
  event?: string;
  hookId?: string;
  method?: string;
  omitHeaders?: string[];
  payload?: JsonObject;
  secret?: string;
  signature?: string;
};

export async function fetchWorker(request: Request): Promise<Response> {
  return workerExports.default.fetch(request);
}

export async function sendGithubWebhook(
  options: GithubRequestOptions = {},
): Promise<Response> {
  const channel = options.channel ?? 'default';
  const body =
    options.body ??
    JSON.stringify(
      options.payload ?? {
        action: 'opened',
        installation: { id: 123456 },
        repository: { full_name: 'owner/repository' },
      },
    );
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers({
    'content-length': String(options.declaredLength ?? bytes.byteLength),
    'content-type': 'application/json',
    'x-github-delivery':
      options.deliveryId ?? '8c2f4fb8-1a2b-4f4d-92cf-a0d9a7ab53f0',
    'x-github-event': options.event ?? 'pull_request',
    'x-github-hook-id': options.hookId ?? '12345678',
    'x-hub-signature-256':
      options.signature ??
      (await signBody(bytes, options.secret ?? githubWebhookSecret)),
  });
  for (const name of options.omitHeaders ?? []) headers.delete(name);

  const method = options.method ?? 'POST';
  return fetchWorker(
    new Request(
      `https://relay.test/channels/${encodeURIComponent(channel)}/webhooks/github`,
      {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? null : bytes,
      },
    ),
  );
}

export async function signBody(
  body: Uint8Array,
  secret = githubWebhookSecret,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `sha256=${Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export async function openWebSocket(
  channel: string,
  secret = webSocketClientSecret,
): Promise<WebSocket> {
  const response = await fetchWorker(
    new Request(
      `https://relay.test/channels/${encodeURIComponent(channel)}/ws`,
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          Upgrade: 'websocket',
        },
      },
    ),
  );
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Expected WebSocket upgrade, received ${response.status}.`);
  }

  const socket = response.webSocket;
  socket.accept();
  openSockets.add(socket);
  return socket;
}

export function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      (event) => {
        const parsed = messageDataSchema.safeParse(event.data);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error('Expected a text WebSocket message.'));
      },
      { once: true },
    );
  });
}

export function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
  });
}

export async function receivesMessageWithin(
  socket: WebSocket,
  durationMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const onMessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      resolve(false);
    }, durationMs);
    socket.addEventListener('message', onMessage, { once: true });
  });
}

export function closeOpenSockets(): void {
  for (const socket of openSockets) {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1000, 'Test complete.');
    }
  }
  openSockets.clear();
}
