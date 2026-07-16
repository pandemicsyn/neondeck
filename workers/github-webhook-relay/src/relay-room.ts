import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { jsonError } from './http';
import {
  createGithubWebhookEnvelope,
  encodeServerFrame,
  parseClientControlFrame,
  pingFrameText,
  pongFrameText,
  relayBroadcastInputSchema,
} from './protocol';
import { channelSchema, parseWebSocketRoute } from './routes';

const connectionAttachmentSchema = z
  .object({
    version: z.literal(1),
    channel: z.string().min(1).max(64),
    connectionId: z.string().uuid(),
    connectedAt: z.string().datetime(),
  })
  .strict();

export const broadcastResultSchema = z
  .object({
    connectedClients: z.number().int().nonnegative(),
    deliveredClients: z.number().int().nonnegative(),
    failedClients: z.number().int().nonnegative(),
  })
  .strict();

const socketFrameSchema = z.union([z.string(), z.instanceof(ArrayBuffer)]);

export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(pingFrameText, pongFrameText),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = parseWebSocketRoute(url.pathname);
    const roomChannel = channelSchema.safeParse(this.ctx.id.name);
    if (
      !route ||
      !roomChannel.success ||
      route.channel !== roomChannel.data ||
      request.method !== 'GET' ||
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
    ) {
      return jsonError(
        400,
        'invalid_request',
        'Invalid relay connection request.',
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment = connectionAttachmentSchema.parse({
      version: 1,
      channel: roomChannel.data,
      connectionId: crypto.randomUUID(),
      connectedAt: new Date().toISOString(),
    });

    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`channel:${roomChannel.data}`]);

    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(
    input: unknown,
  ): Promise<z.infer<typeof broadcastResultSchema>> {
    const broadcast = relayBroadcastInputSchema.parse(input);
    const roomChannel = channelSchema.parse(this.ctx.id.name);
    if (broadcast.channel !== roomChannel) {
      throw new Error('Relay channel does not match Durable Object identity.');
    }
    const frame = encodeServerFrame(
      createGithubWebhookEnvelope(roomChannel, broadcast.webhook),
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
        socket.close(1011, 'Relay delivery failed.');
      }
    }

    return broadcastResultSchema.parse({
      connectedClients: sockets.length,
      deliveredClients,
      failedClients,
    });
  }

  override webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    const parsedMessage = socketFrameSchema.safeParse(message);
    if (!parsedMessage.success || parsedMessage.data instanceof ArrayBuffer) {
      ws.close(1003, 'Text frames only.');
      return;
    }

    const attachment = connectionAttachmentSchema.safeParse(
      ws.deserializeAttachment(),
    );
    if (!attachment.success) {
      ws.close(1011, 'Connection state is invalid.');
      return;
    }

    const controlFrame = parseClientControlFrame(parsedMessage.data);
    if (!controlFrame.ok) {
      ws.close(
        controlFrame.reason === 'too_large' ? 1009 : 1008,
        controlFrame.reason === 'too_large'
          ? 'Client message is too large.'
          : 'Unsupported client message.',
      );
      return;
    }

    ws.send(encodeServerFrame({ version: 1, type: 'pong' }));
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
        message: 'relay WebSocket closed',
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
        message: 'relay WebSocket error',
        channel: attachment.success ? attachment.data.channel : null,
        connectionId: attachment.success ? attachment.data.connectionId : null,
        error:
          error instanceof Error ? error.message : 'Unknown WebSocket error',
      }),
    );
  }
}
