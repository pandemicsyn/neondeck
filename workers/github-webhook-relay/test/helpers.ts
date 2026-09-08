import { exports as workerExports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import * as v from 'valibot';
import { errorCodeSchema } from '../src/http';
import type { JsonObject } from '../src/json';
import type { EventLogRow } from '../src/protocol';
import type { RelayRoom } from '../src/relay-room';

export const githubWebhookSecret = "It's a Secret to Everybody";
export const webSocketClientSecret = 'test-client-secret-0123456789';

// The one shared `{ error, code }` response shape every test file should
// validate error responses against. `code` is checked against the actual
// `errorCodeSchema` union from src/http.ts, not merely "non-empty string" —
// a response carrying a code outside the documented union must fail a test,
// not silently pass because the assertion only checked for stringiness.
export const errorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
  code: errorCodeSchema,
});

// A realistic `pull_request` webhook delivery. Both the top-level `number`
// and `pull_request.number` are populated, mirroring GitHub's actual
// payload shape, so tests exercising `extractPrNumber`'s
// `payload.pull_request.number` path have real-shaped input rather than a
// synthetic `{ pull_request: { number } }` stub.
export const pullRequestWebhookPayload: JsonObject = {
  action: 'opened',
  number: 42,
  pull_request: {
    number: 42,
    state: 'open',
    title: 'Add relay hibernation guard',
    html_url: 'https://github.com/owner/repository/pull/42',
    user: { login: 'octocat', id: 1 },
    head: { ref: 'feature/hibernation-guard', sha: 'abc123def456' },
    base: { ref: 'main', sha: 'def456abc123' },
  },
  repository: { full_name: 'owner/repository' },
  sender: { login: 'octocat', id: 1 },
  installation: { id: 123456 },
};

// A realistic `issue_comment`-shaped delivery: `issue.number` populated,
// no `pull_request` field at all, so `extractPrNumber`'s fallback to
// `payload.issue.number` runs against a real-shaped payload.
export const issueWebhookPayload: JsonObject = {
  action: 'created',
  issue: {
    number: 7,
    title: 'Ping frame byte order is undocumented',
    state: 'open',
    user: { login: 'octocat', id: 1 },
  },
  comment: {
    id: 987654321,
    body: 'Confirmed on the relay side too.',
    user: { login: 'octocat', id: 1 },
  },
  repository: { full_name: 'owner/repository' },
  sender: { login: 'octocat', id: 1 },
  installation: { id: 123456 },
};

const messageDataSchema = v.string();

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
  since?: string,
): Promise<WebSocket> {
  const url = new URL(
    `https://relay.test/channels/${encodeURIComponent(channel)}/ws`,
  );
  if (since !== undefined) url.searchParams.set('since', since);

  const response = await fetchWorker(
    new Request(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        Upgrade: 'websocket',
      },
    }),
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
        const parsed = v.safeParse(messageDataSchema, event.data);
        if (parsed.success) resolve(parsed.output);
        else reject(new Error('Expected a text WebSocket message.'));
      },
      { once: true },
    );
  });
}

// Collapses the `v.parse(<schema>, JSON.parse(await nextMessage(socket)))`
// pattern repeated across the WebSocket-driven test files into one call.
export async function nextEnvelope<TOutput>(
  socket: WebSocket,
  schema: v.GenericSchema<unknown, TOutput>,
): Promise<TOutput> {
  return v.parse(schema, JSON.parse(await nextMessage(socket)));
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

// Test-only access to the DO's internals via `runInDurableObject` (from
// `cloudflare:test`), which reaches the instance and its
// `DurableObjectState` directly. This is what lets the production class
// stay free of RPC methods that exist purely for tests — see
// `.plans/GITHUB_WEBHOOK_RELAY_PLAN.md` and the comments on `RelayRoom`.

// Seeds the event log through the same recordEvent/pruneEventLog path a
// real broadcast uses, skipping the HTTP + HMAC overhead of a full webhook
// round trip. Lets the pruning tests exercise retention at scale (up to and
// past the 1000-row cap) without paying for thousands of real requests.
// `recordEvent` is private, so the cast below is the price of not exposing
// it from the production class purely for tests: it reaches past the
// compiler, so a future rename of `recordEvent` will NOT be caught by
// `tsc` here — this cast will keep compiling and the break will only show
// up as a runtime "recordEvent is not a function" in whichever test calls
// `seedEventLog`. That risk is the deliberate trade for keeping
// `RelayRoom`'s public surface free of test-only RPC methods; keep the
// seam, but prefer driving `sendGithubWebhook` (the real HTTP path) instead
// of this cast for any test where correctness of the insert path itself —
// not just retention behavior at scale — is what's being verified.
export async function seedEventLog(
  room: DurableObjectStub<RelayRoom>,
  rows: EventLogRow[],
): Promise<void> {
  await runInDurableObject(room, (instance) => {
    const withRecordEvent = instance as unknown as {
      recordEvent(row: EventLogRow): void;
    };
    for (const row of rows) withRecordEvent.recordEvent(row);
  });
}

export async function getEventLogRowCount(
  room: DurableObjectStub<RelayRoom>,
): Promise<number> {
  return runInDurableObject(room, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ rowCount: number }>(`SELECT COUNT(*) AS rowCount FROM events`)
      .toArray();
    return rows[0]?.rowCount ?? 0;
  });
}

// Reads the durable `webSocketMessageCount` counter straight from storage
// (not an instance field), so the read is honest across Durable Object
// eviction — see the hibernation cost-model comment in `relay-room.ts`.
export async function getWebSocketMessageCount(
  room: DurableObjectStub<RelayRoom>,
): Promise<number> {
  return runInDurableObject(room, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ value: number }>(
        `SELECT value FROM counters WHERE name = 'webSocketMessageCount'`,
      )
      .toArray();
    return rows[0]?.value ?? 0;
  });
}

export async function getWebSocketAutoResponseTimestamps(
  room: DurableObjectStub<RelayRoom>,
): Promise<(string | null)[]> {
  return runInDurableObject(room, (_instance, state) =>
    state.getWebSockets().map((socket) => {
      const timestamp = state.getWebSocketAutoResponseTimestamp(socket);
      return timestamp ? timestamp.toISOString() : null;
    }),
  );
}
