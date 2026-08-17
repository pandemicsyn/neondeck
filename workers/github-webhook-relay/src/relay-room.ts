import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { jsonError } from './http';
import {
  createGithubWebhookEnvelope,
  createGithubWebhookReplayEnvelope,
  encodeServerFrame,
  parseClientControlFrame,
  pingFrameText,
  pongFrameText,
  relayBroadcastInputSchema,
  type EventLogRow,
} from './protocol';
import { channelSchema, parseWebSocketRoute } from './routes';

const connectionAttachmentSchema = v.strictObject({
  version: v.literal(1),
  channel: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  connectionId: v.pipe(v.string(), v.uuid()),
  connectedAt: v.pipe(v.string(), v.isoTimestamp()),
});

export const broadcastResultSchema = v.strictObject({
  connectedClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deliveredClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
  failedClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

// Note: incoming WebSocket messages used to be re-validated against a
// `string | ArrayBuffer` union schema here, but `webSocketMessage` below
// already types `message` that way — the runtime guarantees it, so the
// check below is a plain `instanceof` narrowing instead.

const sinceCursorSchema = v.pipe(v.string(), v.uuid());

// Retain roughly 24h or 1000 rows, whichever bound ends up smaller.
const eventLogRetentionMs = 24 * 60 * 60 * 1000;
const eventLogRetentionRows = 1000;

// Pulls a PR number out of an already-signature-verified but otherwise
// untyped GitHub payload. This is real GitHub input — the payload's nested
// shape is not guaranteed by any type, so it is validated here.
const prNumberSourceSchema = v.looseObject({
  pull_request: v.optional(
    v.looseObject({ number: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
  ),
  issue: v.optional(
    v.looseObject({ number: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
  ),
});

function extractPrNumber(payload: unknown): number | null {
  const parsed = v.safeParse(prNumberSourceSchema, payload);
  if (!parsed.success) return null;
  return (
    parsed.output.pull_request?.number ?? parsed.output.issue?.number ?? null
  );
}

const eventLogSeedInputSchema = v.object({
  rows: v.array(
    v.object({
      deliveryId: v.pipe(v.string(), v.uuid()),
      event: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)),
      action: v.nullable(v.pipe(v.string(), v.minLength(1))),
      repository: v.nullable(v.pipe(v.string(), v.minLength(1))),
      prNumber: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
      receivedAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
  ),
});

export class RelayRoom extends DurableObject<Env> {
  // Test instrumentation for the hibernation cost-model guard: counts
  // webSocketMessage invocations so a test can assert the canonical ping
  // never reaches it (auto-response answers it without waking the object).
  // Resets to 0 on every construction, which is fine — the guarantee under
  // test is "stays 0 across N pings", not a total across the object's life.
  private webSocketMessageCount = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(pingFrameText, pongFrameText),
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        deliveryId TEXT UNIQUE NOT NULL,
        event TEXT NOT NULL,
        action TEXT,
        repository TEXT,
        prNumber INTEGER,
        receivedAt TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idxEventsReceivedAt ON events (receivedAt)`,
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = parseWebSocketRoute(url.pathname);
    const roomChannel = v.safeParse(channelSchema, this.ctx.id.name);
    if (
      !route ||
      !roomChannel.success ||
      route.channel !== roomChannel.output ||
      request.method !== 'GET' ||
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
    ) {
      return jsonError(
        400,
        'invalid_request',
        'Invalid relay connection request.',
      );
    }

    const sinceParam = url.searchParams.get('since');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment = v.parse(connectionAttachmentSchema, {
      version: 1,
      channel: roomChannel.output,
      connectionId: crypto.randomUUID(),
      connectedAt: new Date().toISOString(),
    });

    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`channel:${roomChannel.output}`]);

    if (sinceParam !== null) {
      this.replayFrom(server, roomChannel.output, sinceParam);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(
    input: unknown,
  ): Promise<v.InferOutput<typeof broadcastResultSchema>> {
    const broadcast = v.parse(relayBroadcastInputSchema, input);
    const roomChannel = v.parse(channelSchema, this.ctx.id.name);
    if (broadcast.channel !== roomChannel) {
      throw new Error('Relay channel does not match Durable Object identity.');
    }

    this.recordEvent({
      deliveryId: broadcast.webhook.deliveryId,
      event: broadcast.webhook.event,
      action: broadcast.webhook.payload.action ?? null,
      repository: broadcast.webhook.payload.repository?.full_name ?? null,
      prNumber: extractPrNumber(broadcast.webhook.payload),
      receivedAt: broadcast.webhook.receivedAt,
    });

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

    return v.parse(broadcastResultSchema, {
      connectedClients: sockets.length,
      deliveredClients,
      failedClients,
    });
  }

  // Test-only diagnostics for the hibernation guard. Not reachable from any
  // HTTP route — only via direct Durable Object RPC, the same surface the
  // test suite already uses for `evictDurableObject`.
  async getHibernationDiagnostics(): Promise<{
    webSocketMessageCount: number;
    autoResponseTimestamps: (string | null)[];
  }> {
    return {
      webSocketMessageCount: this.webSocketMessageCount,
      autoResponseTimestamps: this.ctx.getWebSockets().map((socket) => {
        const timestamp = this.ctx.getWebSocketAutoResponseTimestamp(socket);
        return timestamp ? timestamp.toISOString() : null;
      }),
    };
  }

  // Test-only diagnostics for the pruning guard. Same RPC-only surface as
  // getHibernationDiagnostics above.
  async getEventLogDiagnostics(): Promise<{ rowCount: number }> {
    const rows = this.ctx.storage.sql
      .exec<{ rowCount: number }>(`SELECT COUNT(*) AS rowCount FROM events`)
      .toArray();
    return { rowCount: rows[0]?.rowCount ?? 0 };
  }

  // Test-only: seeds the event log through the same recordEvent/
  // pruneEventLog path a real broadcast uses, skipping the HTTP + HMAC
  // overhead of a full webhook round trip. Lets the pruning tests exercise
  // retention at scale without paying for thousands of real requests.
  async seedEventLogForTest(input: unknown): Promise<void> {
    const parsed = v.parse(eventLogSeedInputSchema, input);
    for (const row of parsed.rows) {
      this.recordEvent(row);
    }
  }

  private recordEvent(row: EventLogRow): void {
    // One transaction for the insert and its prune, so a broadcast costs a
    // single durable commit instead of one per statement.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO events
           (deliveryId, event, action, repository, prNumber, receivedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.deliveryId,
        row.event,
        row.action,
        row.repository,
        row.prNumber,
        row.receivedAt,
      );
      this.pruneEventLog();
    });
  }

  private pruneEventLog(): void {
    const cutoff = new Date(Date.now() - eventLogRetentionMs).toISOString();
    this.ctx.storage.sql.exec(
      `DELETE FROM events WHERE receivedAt < ?`,
      cutoff,
    );

    // `seq` is an AUTOINCREMENT primary key, so MAX(seq) is a cheap index
    // lookup and the retention cutoff is plain arithmetic on it — an
    // indexed range delete on the primary key, cheap even called on every
    // write. Avoid `ORDER BY seq DESC LIMIT 1 OFFSET n`: OFFSET forces
    // SQLite to walk and discard `n` rows per call, which turns "prune on
    // every write" quadratic as the table approaches the retention cap.
    const maxSeqRow = this.ctx.storage.sql
      .exec<{ maxSeq: number | null }>(`SELECT MAX(seq) AS maxSeq FROM events`)
      .toArray();
    const maxSeq = maxSeqRow[0]?.maxSeq;
    if (maxSeq !== null && maxSeq !== undefined) {
      const cutoffSeq = maxSeq - eventLogRetentionRows + 1;
      this.ctx.storage.sql.exec(`DELETE FROM events WHERE seq < ?`, cutoffSeq);
    }
  }

  // Sends replayed rows after `sinceParam`'s delivery, then resumes live
  // delivery. An unresolvable cursor (malformed, unknown, or already
  // pruned) replays nothing and sends a truncation notice instead, so the
  // client knows it has a gap and must force a full refresh.
  private replayFrom(
    server: WebSocket,
    channel: string,
    sinceParam: string,
  ): void {
    const cursor = v.safeParse(sinceCursorSchema, sinceParam);
    if (!cursor.success) {
      server.send(encodeServerFrame({ version: 1, type: 'replay.truncated' }));
      return;
    }

    const cursorRow = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM events WHERE deliveryId = ?`,
        cursor.output,
      )
      .toArray();
    const cursorSeq = cursorRow[0]?.seq;
    if (cursorSeq === undefined) {
      server.send(encodeServerFrame({ version: 1, type: 'replay.truncated' }));
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<{
        deliveryId: string;
        event: string;
        action: string | null;
        repository: string | null;
        prNumber: number | null;
        receivedAt: string;
      }>(
        `SELECT deliveryId, event, action, repository, prNumber, receivedAt
           FROM events WHERE seq > ? ORDER BY seq ASC`,
        cursorSeq,
      )
      .toArray();

    for (const row of rows) {
      server.send(
        encodeServerFrame(createGithubWebhookReplayEnvelope(channel, row)),
      );
    }
  }

  override webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    this.webSocketMessageCount += 1;
    if (message instanceof ArrayBuffer) {
      ws.close(1003, 'Text frames only.');
      return;
    }

    const attachment = v.safeParse(
      connectionAttachmentSchema,
      ws.deserializeAttachment(),
    );
    if (!attachment.success) {
      ws.close(1011, 'Connection state is invalid.');
      return;
    }

    const controlFrame = parseClientControlFrame(message);
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

  // `reason` is part of the DurableObject override signature but is not
  // logged (it never was — a schema used to validate it without the result
  // being used).
  override webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): void {
    const attachment = v.safeParse(
      connectionAttachmentSchema,
      ws.deserializeAttachment(),
    );
    if (!attachment.success) return;

    // Always log, regardless of the close code the runtime reports — codes
    // outside the registered 0-4999 range are still real close events and
    // must not be silently dropped.
    console.log(
      JSON.stringify({
        message: 'relay WebSocket closed',
        channel: attachment.output.channel,
        connectionId: attachment.output.connectionId,
        code,
        wasClean,
      }),
    );
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    const attachment = v.safeParse(
      connectionAttachmentSchema,
      ws.deserializeAttachment(),
    );
    console.error(
      JSON.stringify({
        message: 'relay WebSocket error',
        channel: attachment.success ? attachment.output.channel : null,
        connectionId: attachment.success
          ? attachment.output.connectionId
          : null,
        error:
          error instanceof Error ? error.message : 'Unknown WebSocket error',
      }),
    );
  }
}
