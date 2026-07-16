import { z } from "zod";
import { verifyGithubWebhook } from "./github-webhook";
import { jsonError } from "./http";
import { parseGithubWebhookRoute, parseWebSocketRoute } from "./routes";
import { authenticateWebSocketRequest } from "./websocket-auth";

const requestTargetSchema = z.object({
  method: z.string(),
  pathname: z.string(),
});

const healthRequestSchema = requestTargetSchema.extend({
  method: z.literal("GET"),
  pathname: z.literal("/healthz"),
});

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("github-webhook-relay"),
});

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
          service: "github-webhook-relay",
        }),
      );
    }

    const webhookRoute = parseGithubWebhookRoute(target.pathname);
    if (webhookRoute) {
      if (target.method !== "POST") {
        return jsonError(405, "invalid_request", "Method not allowed.", {
          Allow: "POST",
        });
      }

      const result = await verifyGithubWebhook(request, env);
      if (!result.ok) {
        return jsonError(result.status, result.code, result.error);
      }

      console.warn(
        JSON.stringify({
          message: "verified webhook cannot be relayed yet",
          channel: webhookRoute.channel,
          deliveryId: result.webhook.deliveryId,
          event: result.webhook.event,
        }),
      );
      return jsonError(
        503,
        "relay_unavailable",
        "Webhook relay is unavailable.",
      );
    }

    const webSocketRoute = parseWebSocketRoute(target.pathname);
    if (webSocketRoute) {
      if (target.method !== "GET") {
        return jsonError(405, "invalid_request", "Method not allowed.", {
          Allow: "GET",
        });
      }

      const result = await authenticateWebSocketRequest(request, env);
      if (!result.ok) {
        return jsonError(result.status, result.code, result.error, {
          ...(result.status === 426 ? { Upgrade: "websocket" } : {}),
          ...(result.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="github-webhook-relay"' }
            : {}),
        });
      }

      console.warn(
        JSON.stringify({
          message: "authenticated WebSocket cannot connect yet",
          channel: webSocketRoute.channel,
        }),
      );
      return jsonError(
        503,
        "relay_unavailable",
        "WebSocket relay is unavailable.",
      );
    }

    return jsonError(404, "not_found", "Not found.");
  },
} satisfies ExportedHandler<Env>;
