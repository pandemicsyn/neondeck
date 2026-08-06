import { z } from 'zod';
import { verifyGithubWebhook } from './github-webhook';
import { jsonError } from './http';
import { broadcastResultSchema, RelayRoom } from './relay-room';
import { parseGithubWebhookRoute, parseWebSocketRoute } from './routes';
import { authenticateWebSocketRequest } from './websocket-auth';

export { RelayRoom };

const requestTargetSchema = z.object({
  method: z.string(),
  pathname: z.string(),
});

const healthRequestSchema = requestTargetSchema.extend({
  method: z.literal('GET'),
  pathname: z.literal('/healthz'),
});

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('github-webhook-relay'),
});

const webhookRelayResponseSchema = z.object({
  relayed: z.literal(true),
  protocolVersion: z.literal(1),
  deliveryId: z.string().uuid(),
  deliveredClients: z.number().int().nonnegative(),
});

const webSocketUpgradeResponseSchema = z.custom<Response>(
  (value) =>
    value instanceof Response &&
    value.status === 101 &&
    value.webSocket instanceof WebSocket,
);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const target = requestTargetSchema.parse({
      method: request.method,
      pathname: url.pathname,
    });

    if (healthRequestSchema.safeParse(target).success) {
      return Response.json(
        healthResponseSchema.parse({
          ok: true,
          service: 'github-webhook-relay',
        }),
      );
    }

    const webhookRoute = parseGithubWebhookRoute(target.pathname);
    if (webhookRoute) {
      if (target.method !== 'POST') {
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
        const broadcast = broadcastResultSchema.parse(
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
          webhookRelayResponseSchema.parse({
            relayed: true,
            protocolVersion: 1,
            deliveryId: result.webhook.deliveryId,
            deliveredClients: broadcast.deliveredClients,
          }),
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

    const webSocketRoute = parseWebSocketRoute(target.pathname);
    if (webSocketRoute) {
      if (target.method !== 'GET') {
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
        const internalRequest = new Request(
          `https://relay.internal/channels/${encodeURIComponent(webSocketRoute.channel)}/ws`,
          { headers },
        );
        const response = await room.fetch(internalRequest);
        return webSocketUpgradeResponseSchema.parse(response);
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
