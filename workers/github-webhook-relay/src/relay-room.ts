import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { verifiedGithubWebhookSchema } from "./github-webhook";
import { jsonError } from "./http";
import { parseWebSocketRoute } from "./routes";

const connectionAttachmentSchema = z.object({
  version: z.literal(1),
  channel: z.string().min(1).max(64),
  connectionId: z.string().uuid(),
  connectedAt: z.string().datetime(),
});

const relaySocketMessageSchema = z.object({
  deliveryId: z.string().uuid(),
  event: z.string().min(1),
  payload: z.record(z.unknown()),
});

export const broadcastResultSchema = z.object({
  connectedClients: z.number().int().nonnegative(),
  deliveredClients: z.number().int().nonnegative(),
  failedClients: z.number().int().nonnegative(),
});

const socketFrameSchema = z.union([z.string(), z.instanceof(ArrayBuffer)]);

export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = parseWebSocketRoute(url.pathname);
    if (
      !route ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return jsonError(400, "invalid_request", "Invalid relay connection request.");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment = connectionAttachmentSchema.parse({
      version: 1,
      channel: route.channel,
      connectionId: crypto.randomUUID(),
      connectedAt: new Date().toISOString(),
    });

    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`channel:${route.channel}`]);

    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(input: unknown): Promise<z.infer<typeof broadcastResultSchema>> {
    const webhook = verifiedGithubWebhookSchema.parse(input);
    const frame = JSON.stringify(
      relaySocketMessageSchema.parse({
        deliveryId: webhook.deliveryId,
        event: webhook.event,
        payload: webhook.payload,
      }),
    );
    const sockets = this.ctx.getWebSockets();
    let deliveredClients = 0;
    let failedClients = 0;

    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(frame);
        deliveredClients += 1;
      } catch {
        failedClients += 1;
        socket.close(1011, "Relay delivery failed.");
      }
    }

    return broadcastResultSchema.parse({
      connectedClients: sockets.length,
      deliveredClients,
      failedClients,
    });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const parsedMessage = socketFrameSchema.safeParse(message);
    if (!parsedMessage.success || parsedMessage.data instanceof ArrayBuffer) {
      ws.close(1003, "Text frames only.");
      return;
    }

    const attachment = connectionAttachmentSchema.safeParse(
      ws.deserializeAttachment(),
    );
    if (!attachment.success) {
      ws.close(1011, "Connection state is invalid.");
      return;
    }

    ws.close(1008, "Client messages are not supported.");
  }

  override webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    const closeEvent = z
      .object({
        code: z.number().int().min(0).max(4999),
        reason: z.string().max(123),
        wasClean: z.boolean(),
      })
      .safeParse({ code, reason, wasClean });
    const attachment = connectionAttachmentSchema.safeParse(
      ws.deserializeAttachment(),
    );
    if (!closeEvent.success || !attachment.success) return;

    console.log(
      JSON.stringify({
        message: "relay WebSocket closed",
        channel: attachment.data.channel,
        connectionId: attachment.data.connectionId,
        code: closeEvent.data.code,
        wasClean: closeEvent.data.wasClean,
      }),
    );
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    const attachment = connectionAttachmentSchema.safeParse(
      ws.deserializeAttachment(),
    );
    console.error(
      JSON.stringify({
        message: "relay WebSocket error",
        channel: attachment.success ? attachment.data.channel : null,
        connectionId: attachment.success
          ? attachment.data.connectionId
          : null,
        error: error instanceof Error ? error.message : "Unknown WebSocket error",
      }),
    );
  }
}
