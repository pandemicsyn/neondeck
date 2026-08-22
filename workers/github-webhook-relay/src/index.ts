import * as v from 'valibot';
import { verifyGithubWebhook } from './github-webhook';
import { jsonError } from './http';
import {
  broadcastResultSchema,
  RelayChannelMismatchError,
  RelayRoom,
} from './relay-room';
import { parseGithubWebhookRoute, parseWebSocketRoute } from './routes';
import { authenticateWebSocketRequest } from './websocket-auth';

export { RelayRoom };

// A non-101 response with a `webSocket` isn't a valid upgrade — this is the
// one remaining check worth keeping from the schema this used to be: it
// guards against the Durable Object returning a malformed 101 (missing the
// paired client socket), which would otherwise be handed straight to the
// caller.
function isWebSocketUpgradeResponse(response: Response): boolean {
  return response.status === 101 && response.webSocket instanceof WebSocket;
}

// `RelayRoom.broadcast` is invoked over Durable Object RPC, not a plain
// function call — a thrown error crosses that boundary structurally
// cloned, not by reference. Cloudflare's RPC error serialization retains
// an Error's `.message` and `.name` but reconstructs it as a plain
// `Error`, so `instanceof RelayChannelMismatchError` is always false here
// even when the error really was one on the Durable Object side.
// Comparing `.name` against the class's own static `.name` is the
// reliable way to recognize it after the round trip.
function isRelayChannelMismatchError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === RelayChannelMismatchError.name
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/healthz') {
      return Response.json({
        ok: true as const,
        service: 'github-webhook-relay' as const,
      });
    }

    const webhookRoute = parseGithubWebhookRoute(pathname);
    if (webhookRoute) {
      if (method !== 'POST') {
        return jsonError(405, 'invalid_request', 'Method not allowed.', {
          Allow: 'POST',
        });
      }

      const result = await verifyGithubWebhook(request, env);
      if (!result.ok) {
        return jsonError(result.status, result.code, result.error);
      }

      try {
        const room = env.RELAY_ROOMS.getByName(webhookRoute.channel);
        const broadcast = v.parse(
          broadcastResultSchema,
          await room.broadcast({
            channel: webhookRoute.channel,
            webhook: result.webhook,
          }),
        );
        console.log(
          JSON.stringify({
            message: 'GitHub webhook relayed',
            channel: webhookRoute.channel,
            deliveryId: result.webhook.deliveryId,
            event: result.webhook.event,
            connectedClients: broadcast.connectedClients,
            deliveredClients: broadcast.deliveredClients,
            failedClients: broadcast.failedClients,
          }),
        );
        return Response.json(
          {
            relayed: true as const,
            protocolVersion: 1 as const,
            deliveryId: result.webhook.deliveryId,
            deliveredClients: broadcast.deliveredClients,
          },
          { status: 200 },
        );
      } catch (error) {
        // A thrown validation/invariant error (e.g. the channel-identity
        // check in `RelayRoom.broadcast`) means the request reached the
        // Durable Object and it made a deliberate decision — that is a
        // routing bug in this worker, not a relay outage, and flattening
        // it to the same 503 as a genuine RPC/transport failure would make
        // the two indistinguishable in both the response and this log
        // line.
        const isInvariantError = isRelayChannelMismatchError(error);
        console.error(
          JSON.stringify({
            message: isInvariantError
              ? 'GitHub webhook relay rejected the request'
              : 'GitHub webhook relay failed',
            channel: webhookRoute.channel,
            deliveryId: result.webhook.deliveryId,
            error:
              error instanceof Error ? error.message : 'Unknown relay error',
          }),
        );
        return isInvariantError
          ? jsonError(
              500,
              'invalid_request',
              'Webhook relay encountered an internal routing error.',
            )
          : jsonError(
              503,
              'relay_unavailable',
              'Webhook relay is unavailable.',
            );
      }
    }

    const webSocketRoute = parseWebSocketRoute(pathname);
    if (webSocketRoute) {
      if (method !== 'GET') {
        return jsonError(405, 'invalid_request', 'Method not allowed.', {
          Allow: 'GET',
        });
      }

      const result = await authenticateWebSocketRequest(request, env);
      if (!result.ok) {
        return jsonError(result.status, result.code, result.error, {
          ...(result.status === 426 ? { Upgrade: 'websocket' } : {}),
          ...(result.status === 401
            ? { 'WWW-Authenticate': 'Bearer realm="github-webhook-relay"' }
            : {}),
        });
      }

      try {
        const room = env.RELAY_ROOMS.getByName(webSocketRoute.channel);
        const headers = new Headers({ Upgrade: 'websocket' });
        const internalUrl = new URL(
          `https://relay.internal/channels/${encodeURIComponent(webSocketRoute.channel)}/ws`,
        );
        // Forward the replay cursor so the Durable Object can catch the
        // client up. The client's bearer credential is deliberately not
        // forwarded — only the Upgrade header and this routing param.
        const sinceParam = url.searchParams.get('since');
        if (sinceParam !== null) {
          internalUrl.searchParams.set('since', sinceParam);
        }
        const internalRequest = new Request(internalUrl, { headers });
        const response = await room.fetch(internalRequest);
        // A non-101 response is the Durable Object's own routing decision
        // (e.g. its `400 invalid_request`), not a relay outage. Pass it
        // through instead of flattening it to a generic 503 below.
        if (response.status !== 101) {
          return response;
        }
        if (!isWebSocketUpgradeResponse(response)) {
          throw new Error('Durable Object did not return a WebSocket upgrade.');
        }
        return response;
      } catch (error) {
        console.error(
          JSON.stringify({
            message: 'WebSocket relay connection failed',
            channel: webSocketRoute.channel,
            error:
              error instanceof Error ? error.message : 'Unknown relay error',
          }),
        );
        return jsonError(
          503,
          'relay_unavailable',
          'WebSocket relay is unavailable.',
        );
      }
    }

    return jsonError(404, 'not_found', 'Not found.');
  },
} satisfies ExportedHandler<Env>;
