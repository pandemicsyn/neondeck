import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { jsonError } from './http';
import {
  createGithubWebhookEnvelope,
  createGithubWebhookReplayEnvelope,
  encodeServerFrame,
  extractPrNumber,
  parseClientControlFrame,
  pingFrameText,
  pongFrameText,
  relayBroadcastInputSchema,
  type EventLogRow,
} from './protocol';
import { channelSchema, parseWebSocketRoute } from './routes';
import { isoTimestampSchema, uuidSchema } from './schema-primitives';

const connectionAttachmentSchema = v.strictObject({
  version: v.literal(1),
  channel: channelSchema,
  connectionId: uuidSchema,
  connectedAt: isoTimestampSchema,
});

// Thrown when the caller's `channel` disagrees with this Durable Object's
// own identity (`ctx.id.name`) — an invariant violation in the caller, not
// an RPC/transport failure. `src/index.ts` distinguishes this from a
// genuine relay outage by name (see the comment there on why `.name` and
// not `instanceof` is used across the RPC boundary).
export class RelayChannelMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayChannelMismatchError';
  }
}

export const broadcastResultSchema = v.strictObject({
  connectedClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deliveredClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
  failedClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

// Note: incoming WebSocket messages used to be re-validated against a
// `string | ArrayBuffer` union schema here, but `webSocketMessage` below
// already types `message` that way — the runtime guarantees it, so the
// check below is a plain `instanceof` narrowing instead.

const sinceCursorSchema = uuidSchema;

// Retain roughly 24h or 1000 rows, whichever bound ends up smaller.
const eventLogRetentionMs = 24 * 60 * 60 * 1000;
const eventLogRetentionRows = 1000;

// Key for the persisted webSocketMessage counter in the `counters` table —
// see the hibernation cost-model comment on that table in the constructor.
const webSocketMessageCounterName = 'webSocketMessageCount';

export class RelayRoom extends DurableObject<Env> {
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
    // Durable counters for test instrumentation, notably the hibernation
    // cost-model guard: `webSocketMessage` increments `webSocketMessageCount`
    // here so a test can assert the canonical ping never reaches it
    // (auto-response answers it without waking the object). This must live
    // in SQLite storage rather than an instance field — an instance field
    // resets to 0 on every construction, so a Durable Object eviction
    // between the pings and the assertion would make a regressed guarantee
    // silently read back as 0 and pass for the wrong reason. Storage
    // survives eviction, so the assertion is honest regardless of whether
    // the object stayed resident.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);
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
    // No tags: `getWebSockets()` is always called unfiltered elsewhere in
    // this class (there is exactly one channel per Durable Object, so
    // per-channel tag filtering has nothing to do), and tags are not read
    // back anywhere.
    this.ctx.acceptWebSocket(server);

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
      throw new RelayChannelMismatchError(
        'Relay channel does not match Durable Object identity.',
      );
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
      // Fully self-contained per socket: a `send` failure must never stop
      // later sockets in this loop from receiving the frame, and a `close`
      // failure on the way out of the `catch` must not escape either —
      // `recordEvent` above already committed the event, and
      // `INSERT OR IGNORE` means a GitHub retry will not re-broadcast it,
      // so a socket skipped here because of an uncaught exception would
      // miss this event permanently.
      try {
        socket.send(frame);
        deliveredClients += 1;
      } catch {
        failedClients += 1;
        try {
          socket.close(1011, 'Relay delivery failed.');
        } catch {
          // Best-effort teardown of an already-broken socket. Nothing more
          // to do — the loop must continue regardless.
        }
      }
    }

    return v.parse(broadcastResultSchema, {
      connectedClients: sockets.length,
      deliveredClients,
      failedClients,
    });
  }

  private recordEvent(row: EventLogRow): void {
    // One transaction for the insert and its prune, so a broadcast costs a
    // single durable commit instead of one per statement.
    this.ctx.storage.transactionSync(() => {
      const inserted = this.ctx.storage.sql.exec(
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
      // `INSERT OR IGNORE` writes nothing on a duplicate `deliveryId` (a
      // GitHub redelivery). Pruning is only meaningful after a row was
      // actually added, so skip it on a no-op insert instead of paying for
      // the prune's two extra statements on every redelivery.
      if (inserted.rowsWritten > 0) {
        this.pruneEventLog();
      }
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
    // `webSocketMessage` only runs for a frame `setWebSocketAutoResponse`
    // did NOT answer itself — i.e. anything that is not a byte-exact match
    // for the canonical ping (see the field-order note on
    // `clientControlFrameSchema` in protocol.ts). A correctly implemented
    // client's keepalive never lands here, so this insert is not
    // unconditional production overhead; it only runs for a malformed or
    // non-canonical client message. Cost class is the same as the
    // event-log insert path below regardless.
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT (name) DO UPDATE SET value = value + 1`,
      webSocketMessageCounterName,
    );
    if (message instanceof ArrayBuffer) {
      ws.close(1003, 'Text frames only.');
      return;
    }

    const attachment = v.safeParse(
      connectionAttachmentSchema,
      ws.deserializeAttachment(),
    );
    if (!attachment.success) {
      // This is the designed-for scenario for hibernating sockets: they
      // survive redeploys, and the attachment schema has no migration path
      // for a changed shape (`version` is a hardcoded literal). Without
      // this log, a shape change kills every hibernating socket with no
      // trace — consistent with `webSocketError` below, which already logs
      // on attachment-parse failure.
      console.error(
        JSON.stringify({
          message: 'relay WebSocket attachment is invalid, closing',
          issues: attachment.issues.map((issue) => issue.message),
        }),
      );
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
    if (!attachment.success) {
      // Same invisible-teardown risk as the `webSocketMessage` case above:
      // without this log, a socket whose attachment fails to parse closes
      // with no trace anywhere.
      console.error(
        JSON.stringify({
          message: 'relay WebSocket closed with an invalid attachment',
          code,
          wasClean,
          issues: attachment.issues.map((issue) => issue.message),
        }),
      );
      return;
    }

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
