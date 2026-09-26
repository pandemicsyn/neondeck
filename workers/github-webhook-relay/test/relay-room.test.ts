import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { RelayChannelMismatchError, type RelayRoom } from '../src/relay-room';
import { errorSchema, sendGithubWebhook } from './helpers';

describe('GitHub webhook relay error mapping', () => {
  it('maps a channel-identity invariant violation to 500, distinct from an outage', async () => {
    // `RelayRoom.broadcast` throws `RelayChannelMismatchError` when the
    // caller's `channel` disagrees with the Durable Object's own identity
    // — an invariant violation on this worker's own routing, not an RPC or
    // transport failure. In production this can only be forced by a bug in
    // `src/index.ts` itself (it always looks up and broadcasts to the same
    // channel), so the only way to exercise the mapping is to fake the RPC
    // boundary: `env.RELAY_ROOMS.getByName` is spied to return a stub whose
    // `broadcast` rejects with a plain `Error` named
    // `RelayChannelMismatchError` — exactly the shape a real
    // `RelayChannelMismatchError` becomes after crossing the Durable Object
    // RPC boundary (see the `.name`-not-`instanceof` comment in
    // src/index.ts).
    const getByNameSpy = vi
      .spyOn(env.RELAY_ROOMS, 'getByName')
      .mockReturnValue({
        broadcast: () =>
          Promise.reject(
            Object.assign(new Error('channel identity mismatch'), {
              name: RelayChannelMismatchError.name,
            }),
          ),
      } as unknown as DurableObjectStub<RelayRoom>);

    let response: Response;
    try {
      response = await sendGithubWebhook({ channel: 'invariant-channel' });
    } finally {
      getByNameSpy.mockRestore();
    }

    expect(response.status).toBe(500);
    const body = v.parse(errorSchema, await response.json());
    expect(body.code).toBe('invalid_request');
    // No internal detail leaked: the thrown error's own message must not
    // appear in the client-facing response.
    expect(body.error).not.toContain('channel identity mismatch');
  });

  it('maps a genuine Durable Object RPC failure to 503, distinct from the invariant path', async () => {
    // A rejection with no `RelayChannelMismatchError` name is a genuine
    // outage (RPC/transport failure) and must map to 503 `relay_unavailable`
    // — a different status and code from the 500 above, so the two are
    // distinguishable by any client or on-call engineer reading the
    // response alone.
    const getByNameSpy = vi
      .spyOn(env.RELAY_ROOMS, 'getByName')
      .mockReturnValue({
        broadcast: () => Promise.reject(new Error('connection reset')),
      } as unknown as DurableObjectStub<RelayRoom>);

    let response: Response;
    try {
      response = await sendGithubWebhook({ channel: 'outage-channel' });
    } finally {
      getByNameSpy.mockRestore();
    }

    expect(response.status).toBe(503);
    const body = v.parse(errorSchema, await response.json());
    expect(body.code).toBe('relay_unavailable');
    expect(body.error).not.toContain('connection reset');
  });
});

describe('RelayRoom.fetch called directly (unreachable from the external worker surface)', () => {
  // `src/index.ts` validates method, upgrade header, and route shape before
  // ever constructing the internal request it forwards to `RelayRoom.fetch`
  // — so these branches inside `RelayRoom.fetch` are dead from any request
  // that goes through the worker's public `fetch` handler. They are only
  // reachable by calling the Durable Object stub's `fetch` directly, the
  // same way `src/index.ts` itself does internally.
  it('rejects a request whose channel does not match this Durable Object identity', async () => {
    const room = env.RELAY_ROOMS.getByName('room-a');

    const response = await room.fetch(
      new Request('https://relay.internal/channels/room-b/ws', {
        headers: { Upgrade: 'websocket' },
      }),
    );

    expect(response.status).toBe(400);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'invalid_request',
    );
  });

  it('rejects a non-GET method', async () => {
    // No `Upgrade` header here deliberately: workerd normalizes
    // `request.method` to `GET` for any Durable-Object-bound `fetch()`
    // call that carries `Upgrade: websocket` (verified empirically — a
    // POST constructed with that header arrives inside `RelayRoom.fetch`
    // as a GET), so including it would mask the very branch under test.
    // This means the request below also fails the upgrade-header
    // condition, not only the method one — the combined `if` in
    // `RelayRoom.fetch` can't be cleanly decomposed into one assertion
    // per predicate via the public `fetch()` surface. What this honestly
    // proves is narrower than the test name suggests in isolation: a
    // non-GET, non-upgrade request 400s. It does not, on its own, prove
    // the method check specifically is load-bearing independent of the
    // header check.
    const room = env.RELAY_ROOMS.getByName('method-check');

    const response = await room.fetch(
      new Request('https://relay.internal/channels/method-check/ws', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(400);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'invalid_request',
    );
  });

  it('rejects a request missing the Upgrade header', async () => {
    const room = env.RELAY_ROOMS.getByName('upgrade-check');

    const response = await room.fetch(
      new Request('https://relay.internal/channels/upgrade-check/ws'),
    );

    expect(response.status).toBe(400);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'invalid_request',
    );
  });
});
