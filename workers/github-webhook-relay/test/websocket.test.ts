import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  githubWebhookEnvelopeSchema,
  pingFrameText,
  serverControlFrameSchema,
} from '../src/protocol';
import {
  closeOpenSockets,
  fetchWorker,
  nextClose,
  nextMessage,
  openWebSocket,
  receivesMessageWithin,
  sendGithubWebhook,
  webSocketClientSecret,
} from './helpers';

const errorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
  code: v.pipe(v.string(), v.minLength(1)),
});

afterEach(() => {
  closeOpenSockets();
});

describe('authenticated hibernating WebSockets', () => {
  it('rejects a missing bearer credential before upgrade', async () => {
    const response = await fetchWorker(
      new Request('https://relay.test/channels/auth-missing/ws', {
        headers: { Upgrade: 'websocket' },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'unauthorized',
    );
  });

  it('rejects an invalid bearer credential', async () => {
    const response = await fetchWorker(
      new Request('https://relay.test/channels/auth-invalid/ws', {
        headers: {
          Authorization: 'Bearer invalid-client-secret',
          Upgrade: 'websocket',
        },
      }),
    );

    expect(response.status).toBe(401);
  });

  it('requires a WebSocket upgrade header', async () => {
    const response = await fetchWorker(
      new Request('https://relay.test/channels/upgrade-required/ws', {
        headers: {
          Authorization: `Bearer ${webSocketClientSecret}`,
        },
      }),
    );

    expect(response.status).toBe(426);
    expect(response.headers.get('upgrade')).toBe('websocket');
  });

  it('rejects the wrong method with an Allow header', async () => {
    const response = await fetchWorker(
      new Request('https://relay.test/channels/wrong-method/ws', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('answers the canonical ping with a validated pong', async () => {
    const socket = await openWebSocket('ping-room');
    const message = nextMessage(socket);

    socket.send('{"version":1,"type":"ping"}');

    expect(
      v.parse(serverControlFrameSchema, JSON.parse(await message)),
    ).toEqual({
      version: 1,
      type: 'pong',
    });
  });

  it('answers canonical pings without waking the Durable Object', async () => {
    // This guards the cost model decision this relay is built on: a
    // hibernating WebSocket accrues no duration while idle, and
    // setWebSocketAutoResponse answers the exact canonical ping without
    // ever invoking webSocketMessage or otherwise waking the object. If a
    // regression makes the ping fall through to webSocketMessage, this
    // relay silently goes back to being billed for continuous duration
    // instead of only real deliveries.
    const channel = 'hibernation-guard';
    const socket = await openWebSocket(channel);
    const room = env.RELAY_ROOMS.getByName(channel);

    const timestampsAfterPing: (string | null)[] = [];
    for (let index = 0; index < 5; index += 1) {
      const pong = nextMessage(socket);
      socket.send(pingFrameText);
      await pong;
      const diagnostics = await room.getHibernationDiagnostics();
      expect(diagnostics.webSocketMessageCount).toBe(0);
      timestampsAfterPing.push(diagnostics.autoResponseTimestamps[0] ?? null);
    }

    // Every ping was answered by the auto-response system (the timestamp
    // is set and non-decreasing) while webSocketMessage was never called.
    for (const timestamp of timestampsAfterPing) {
      expect(timestamp).not.toBeNull();
    }
    const parsedTimestamps = timestampsAfterPing.map((timestamp) =>
      new Date(timestamp as string).getTime(),
    );
    for (let index = 1; index < parsedTimestamps.length; index += 1) {
      expect(parsedTimestamps[index]).toBeGreaterThanOrEqual(
        parsedTimestamps[index - 1] as number,
      );
    }
  });

  it('rejects unknown fields in a client control frame', async () => {
    const socket = await openWebSocket('strict-control');
    const closed = nextClose(socket);

    socket.send('{"version":1,"type":"ping","unexpected":true}');

    expect((await closed).code).toBe(1008);
  });

  it('rejects oversized client text before JSON parsing', async () => {
    const socket = await openWebSocket('oversized-control');
    const closed = nextClose(socket);

    socket.send('x'.repeat(257));

    expect((await closed).code).toBe(1009);
  });

  it('rejects binary client frames', async () => {
    const socket = await openWebSocket('binary-control');
    const closed = nextClose(socket);

    socket.send(new Uint8Array([1, 2, 3]).buffer);

    expect((await closed).code).toBe(1003);
  });

  it('broadcasts the versioned envelope to every client in one channel only', async () => {
    const first = await openWebSocket('broadcast-room');
    const second = await openWebSocket('broadcast-room');
    const other = await openWebSocket('other-room');
    const firstMessage = nextMessage(first);
    const secondMessage = nextMessage(second);
    const otherReceived = receivesMessageWithin(other, 50);

    const response = await sendGithubWebhook({
      channel: 'broadcast-room',
      deliveryId: '328c7420-ec01-4f6d-ae08-b643e158f70a',
      payload: {
        action: 'completed',
        installation: { id: 42 },
        repository: { full_name: 'owner/repository' },
        unicode: '雪',
      },
    });

    expect(response.status).toBe(200);
    const firstEnvelope = v.parse(
      githubWebhookEnvelopeSchema,
      JSON.parse(await firstMessage),
    );
    const secondEnvelope = v.parse(
      githubWebhookEnvelopeSchema,
      JSON.parse(await secondMessage),
    );
    expect(firstEnvelope).toEqual(secondEnvelope);
    expect(firstEnvelope).toMatchObject({
      version: 1,
      type: 'github.webhook',
      channel: 'broadcast-room',
      event: 'pull_request',
      action: 'completed',
      hookId: '12345678',
      repository: 'owner/repository',
      installationId: 42,
    });
    expect(firstEnvelope.payload.unicode).toBe('雪');
    expect(await otherReceived).toBe(false);
  });

  it('delivers duplicate redeliveries with the same idempotency key', async () => {
    const socket = await openWebSocket('duplicate-room');
    const deliveryId = '57ac05f0-cfbc-4e16-9759-93f090cb00a0';

    const firstMessage = nextMessage(socket);
    await sendGithubWebhook({ channel: 'duplicate-room', deliveryId });
    const first = v.parse(
      githubWebhookEnvelopeSchema,
      JSON.parse(await firstMessage),
    );

    const secondMessage = nextMessage(socket);
    await sendGithubWebhook({ channel: 'duplicate-room', deliveryId });
    const second = v.parse(
      githubWebhookEnvelopeSchema,
      JSON.parse(await secondMessage),
    );

    expect(first.deliveryId).toBe(deliveryId);
    expect(second.deliveryId).toBe(deliveryId);
  });

  it('keeps a socket connected across Durable Object eviction', async () => {
    const channel = 'hibernation-room';
    const socket = await openWebSocket(channel);
    const room = env.RELAY_ROOMS.getByName(channel);

    await evictDurableObject(room);
    const message = nextMessage(socket);
    const response = await sendGithubWebhook({
      channel,
      deliveryId: '4a577ab1-8d2f-4785-8a5e-745225485caf',
    });

    expect(response.status).toBe(200);
    expect(
      v.parse(githubWebhookEnvelopeSchema, JSON.parse(await message))
        .deliveryId,
    ).toBe('4a577ab1-8d2f-4785-8a5e-745225485caf');
  });
});
