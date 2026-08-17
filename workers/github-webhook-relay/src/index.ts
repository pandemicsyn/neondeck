import * as v from 'valibot';
import { verifyGithubWebhook } from './github-webhook';
import { jsonError } from './http';
import { broadcastResultSchema, RelayRoom } from './relay-room';
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
        console.error(
          JSON.stringify({
            message: 'GitHub webhook relay failed',
            channel: webhookRoute.channel,
            deliveryId: result.webhook.deliveryId,
            error:
              error instanceof Error ? error.message : 'Unknown relay error',
          }),
        );
        return jsonError(
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
