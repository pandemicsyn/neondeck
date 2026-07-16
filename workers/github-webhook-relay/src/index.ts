import { z } from "zod";
import { verifyGithubWebhook } from "./github-webhook";
import { jsonError } from "./http";
import { parseGithubWebhookRoute } from "./routes";

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

    return jsonError(404, "not_found", "Not found.");
  },
} satisfies ExportedHandler<Env>;
