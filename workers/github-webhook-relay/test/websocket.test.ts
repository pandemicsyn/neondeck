import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
  githubWebhookEnvelopeSchema,
  pingFrameText,
  serverControlFrameSchema,
} from '../src/protocol';
import { authenticateWebSocketRequest } from '../src/websocket-auth';
import { RelayRoom } from '../src/relay-room';
import {
  closeOpenSockets,
  errorSchema,
  fetchWorker,
  getEventLogRowCount,
  getWebSocketAutoResponseTimestamps,
  getWebSocketMessageCount,
  issueWebhookPayload,
  nextClose,
  nextEnvelope,
  nextMessage,
  openWebSocket,
  pullRequestWebhookPayload,
  receivesMessageWithin,
  sendGithubWebhook,
  webSocketClientSecret,
} from './helpers';

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

  it('reports 500 without an HTTP round trip when WS_CLIENT_SECRET is misconfigured', async () => {
    // `authenticateWebSocketRequest` is exported and directly callable with
    // a fabricated bad `env` — the same cheap gap as
    // `verifyGithubWebhook`'s equivalent test in github-webhook.test.ts.
    const request = new Request('https://relay.test/channels/x/ws', {
      headers: {
        Authorization: `Bearer ${webSocketClientSecret}`,
        Upgrade: 'websocket',
      },
    });

    // Too short to satisfy `bearerTokenSchema`'s `v.minLength(16)` —
    // simulates a deployment where the secret was never set correctly.
    const badEnv = { WS_CLIENT_SECRET: 'too-short' } as unknown as Env;

    const result = await authenticateWebSocketRequest(request, badEnv);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.code).toBe('invalid_request');
    }
  });

  it('answers the canonical ping with a validated pong', async () => {
    const socket = await openWebSocket('ping-room');
    const pong = nextEnvelope(socket, serverControlFrameSchema);

    socket.send('{"version":1,"type":"ping"}');

    expect(await pong).toEqual({
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
    //
    // The count is read from durable storage (see getWebSocketMessageCount
    // in helpers.ts), not an instance field, so this assertion is honest
    // even if the object were evicted between pings — see the persistence
    // test below and the comment on the `counters` table in relay-room.ts.
    const channel = 'hibernation-guard';
    const socket = await openWebSocket(channel);
    const room = env.RELAY_ROOMS.getByName(channel);

    const timestampsAfterPing: (string | null)[] = [];
    for (let index = 0; index < 5; index += 1) {
      const pong = nextMessage(socket);
      socket.send(pingFrameText);
      await pong;
      timestampsAfterPing.push(
        (await getWebSocketAutoResponseTimestamps(room))[0] ?? null,
      );
    }

    // Every ping was answered by the auto-response system (the timestamp
    // is set and non-decreasing) while webSocketMessage was never called —
    // checked once at the end, against durable storage, after all five
    // pings.
    expect(await getWebSocketMessageCount(room)).toBe(0);
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

  it('persists the webSocketMessage counter across Durable Object eviction', async () => {
    // Finding 1's fix: webSocketMessageCount lives in SQLite storage, not
    // an instance field, so it must survive eviction. This test proves the
    // fix directly — increment the counter, evict the object, read it back
    // — which is exactly what the "stays 0" guard above depends on to be
    // meaningful rather than accidental (a millisecond-scale test never
    // naturally reaches the 10s hibernation threshold, so without this test
    // the guard could regress silently).
    const channel = 'counter-persistence';
    const socket = await openWebSocket(channel);
    const room = env.RELAY_ROOMS.getByName(channel);

    // A control frame that parses as a valid ping but is not byte-exact
    // with the canonical `pingFrameText` misses the auto-response fast
    // path and falls through to webSocketMessage, incrementing the
    // counter without closing the connection.
    const nonCanonicalPing = JSON.stringify({ type: 'ping', version: 1 });
    expect(nonCanonicalPing).not.toBe(pingFrameText);

    const pingCount = 3;
    for (let index = 0; index < pingCount; index += 1) {
      const pong = nextMessage(socket);
      socket.send(nonCanonicalPing);
      await pong;
    }
    expect(await getWebSocketMessageCount(room)).toBe(pingCount);

    await evictDurableObject(room);

    expect(await getWebSocketMessageCount(room)).toBe(pingCount);
  });

  it('re-arms the ping auto-response after Durable Object eviction', async () => {
    // This is the literal Phase 1 acceptance criterion: a laptop sleeps, the
    // Durable Object evicts, the client reconnects (or its socket simply
    // survives — hibernating WebSockets are not torn down by eviction), and
    // canonical pings sent afterward must still be answered by
    // setWebSocketAutoResponse without waking the object. The two existing
    // tests above get close but don't combine: one pings without evicting
    // (proves the guard exists), the other evicts then sends a webhook, not
    // a ping (proves the socket and counter survive eviction, but not that
    // auto-response specifically re-arms). `setWebSocketAutoResponse` is
    // called unconditionally in the RelayRoom constructor — if that call
    // were ever dropped or made conditional, every ping sent after the
    // first eviction would fall through to webSocketMessage instead of
    // being answered before the object is even reconstructed, which is
    // exactly what this test would catch.
    const channel = 'hibernation-full-cycle';
    const socket = await openWebSocket(channel);
    const room = env.RELAY_ROOMS.getByName(channel);

    await evictDurableObject(room);

    const pingCount = 5;
    const timestampsAfterPing: (string | null)[] = [];
    for (let index = 0; index < pingCount; index += 1) {
      const pong = nextMessage(socket);
      socket.send(pingFrameText);
      await pong;
      timestampsAfterPing.push(
        (await getWebSocketAutoResponseTimestamps(room))[0] ?? null,
      );
    }

    // The persisted counter (see the constructor comment on the `counters`
    // table in relay-room.ts) stays 0 across the whole post-eviction
    // sequence: every one of the five pings was answered by auto-response,
    // never by webSocketMessage.
    expect(await getWebSocketMessageCount(room)).toBe(0);
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
    const firstEnvelopePromise = nextEnvelope(
      first,
      githubWebhookEnvelopeSchema,
    );
    const secondEnvelopePromise = nextEnvelope(
      second,
      githubWebhookEnvelopeSchema,
    );
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
    const firstEnvelope = await firstEnvelopePromise;
    const secondEnvelope = await secondEnvelopePromise;
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
    // Finding 12: `receivesMessageWithin(other, 50)` only proves absence
    // *within a fixed 50ms window* — under a slower runner or deferred
    // delivery, a real cross-channel leak could still read as green there.
    // The event log is the channel's durable ground truth and has no
    // timing window to race: if `broadcast` ever delivered (or persisted)
    // this event into the wrong Durable Object, this assertion catches it
    // even when the timing-based one above does not.
    expect(
      await getEventLogRowCount(env.RELAY_ROOMS.getByName('other-room')),
    ).toBe(0);
  });

  it('delivers duplicate redeliveries with the same idempotency key', async () => {
    const socket = await openWebSocket('duplicate-room');
    const deliveryId = '57ac05f0-cfbc-4e16-9759-93f090cb00a0';

    const firstPromise = nextEnvelope(socket, githubWebhookEnvelopeSchema);
    await sendGithubWebhook({ channel: 'duplicate-room', deliveryId });
    const first = await firstPromise;

    const secondPromise = nextEnvelope(socket, githubWebhookEnvelopeSchema);
    await sendGithubWebhook({ channel: 'duplicate-room', deliveryId });
    const second = await secondPromise;

    expect(first.deliveryId).toBe(deliveryId);
    expect(second.deliveryId).toBe(deliveryId);
  });

  it('keeps a socket connected across Durable Object eviction', async () => {
    const channel = 'hibernation-room';
    const socket = await openWebSocket(channel);
    const room = env.RELAY_ROOMS.getByName(channel);

    await evictDurableObject(room);
    const envelopePromise = nextEnvelope(socket, githubWebhookEnvelopeSchema);
    const response = await sendGithubWebhook({
      channel,
      deliveryId: '4a577ab1-8d2f-4785-8a5e-745225485caf',
    });

    expect(response.status).toBe(200);
    expect((await envelopePromise).deliveryId).toBe(
      '4a577ab1-8d2f-4785-8a5e-745225485caf',
    );
  });

  it('extracts prNumber from a realistic pull_request delivery on the live frame', async () => {
    const channel = 'pr-number-live-pull-request';
    const socket = await openWebSocket(channel);
    const envelopePromise = nextEnvelope(socket, githubWebhookEnvelopeSchema);

    const response = await sendGithubWebhook({
      channel,
      event: 'pull_request',
      payload: pullRequestWebhookPayload,
    });

    expect(response.status).toBe(200);
    const envelope = await envelopePromise;
    expect(envelope.prNumber).toBe(
      (pullRequestWebhookPayload.pull_request as { number: number }).number,
    );
    expect(envelope.prNumber).not.toBeNull();
  });

  it('extracts prNumber from a realistic issue delivery on the live frame', async () => {
    const channel = 'pr-number-live-issue';
    const socket = await openWebSocket(channel);
    const envelopePromise = nextEnvelope(socket, githubWebhookEnvelopeSchema);

    const response = await sendGithubWebhook({
      channel,
      event: 'issue_comment',
      payload: issueWebhookPayload,
    });

    expect(response.status).toBe(200);
    const envelope = await envelopePromise;
    expect(envelope.prNumber).toBe(
      (issueWebhookPayload.issue as { number: number }).number,
    );
    expect(envelope.prNumber).not.toBeNull();
  });

  it('never forwards the client bearer credential to the Durable Object', async () => {
    // SECURITY.md states this as a trust-boundary guarantee: "Worker-to-
    // Durable-Object requests remove the bearer credential before
    // forwarding the upgrade." That claim had no test anywhere — this
    // spies on the real `RelayRoom.fetch` (restoring the original
    // implementation afterward so the upgrade still completes normally)
    // and inspects the actual `Request` src/index.ts constructs, which is
    // the one place that claim could silently regress.
    const capturedRequests: Request[] = [];
    const originalFetch = RelayRoom.prototype.fetch;
    const fetchSpy = vi
      .spyOn(RelayRoom.prototype, 'fetch')
      .mockImplementation(function (this: RelayRoom, request: Request) {
        capturedRequests.push(request);
        return originalFetch.call(this, request);
      });

    try {
      await openWebSocket('bearer-stripping-room');
    } finally {
      fetchSpy.mockRestore();
    }

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.headers.has('authorization')).toBe(false);
  });
});
