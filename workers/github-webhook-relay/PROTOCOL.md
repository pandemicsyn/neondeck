# Relay protocol v1

All application frames are UTF-8 JSON. Objects are strict: unknown top-level or
control-frame fields are rejected. The embedded GitHub `payload` deliberately
preserves the complete signed JSON object.

## GitHub webhook frame

```json
{
  "version": 1,
  "type": "github.webhook",
  "channel": "default",
  "deliveryId": "8c2f4fb8-1a2b-4f4d-92cf-a0d9a7ab53f0",
  "event": "pull_request",
  "action": "opened",
  "hookId": "12345678",
  "receivedAt": "2026-07-16T14:00:00.000Z",
  "repository": "owner/repository",
  "prNumber": 42,
  "installationId": 123456,
  "payload": {}
}
```

`action`, `repository`, `installationId`, and `prNumber` are `null` when the
GitHub event does not supply them. `prNumber` is derived from
`pull_request.number` or `issue.number` when the original event carried one.
`payload` is the validated, complete GitHub JSON payload. The webhook HMAC is
intentionally not forwarded.

Consumers should reject unsupported `version` values and unknown `type` values.
Use `deliveryId` as the idempotency key.

## Replay on reconnect

Connect with `?since=<deliveryId>` to catch up on events broadcast while
disconnected:

```text
wss://<worker-host>/channels/<channel>/ws?since=8c2f4fb8-1a2b-4f4d-92cf-a0d9a7ab53f0
```

`since` names the last delivery the client already processed. On accept, the
Durable Object looks up that delivery in its event log and sends every later
event first, in order, before resuming live delivery. Replayed events use a
distinct frame type:

```json
{
  "version": 1,
  "type": "github.webhook.replay",
  "channel": "default",
  "deliveryId": "b4e1a3b0-9e1d-4c8b-9b1e-2f6c9a0b7e3d",
  "event": "pull_request",
  "action": "synchronize",
  "repository": "owner/repository",
  "prNumber": 42,
  "receivedAt": "2026-07-16T14:00:05.000Z"
}
```

`github.webhook.replay` carries the same `prNumber` as the live frame but
deliberately omits `payload`, `hookId`, and `installationId`: the Durable
Object's event log persists routing facts only, never the GitHub payload, so
there is nothing to replay it from. Treat a replay frame the same way you
would treat a live one that arrived with no payload — refetch from GitHub if
you need the content.

The event log retains roughly the last 24 hours or 1000 events per channel,
whichever bound is smaller. If `since` names a delivery the log no longer has
— because it was never recorded, or has since been pruned — the connection
replays nothing and instead sends one control frame before any live traffic:

```text
{"version":1,"type":"replay.truncated"}
```

`replay.truncated` means there is a gap: some events may have been missed
that this connection cannot recover. Treat it as a signal to force a full
refresh from GitHub rather than trusting incremental state. A connection
without a `since` parameter never receives this frame — replay only applies
when a cursor was requested.

## Ping and pong

The canonical client ping is:

```text
{"version":1,"type":"ping"}
```

The response is:

```text
{"version":1,"type":"pong"}
```

The exact canonical ping is answered by the Durable Object hibernation API
without waking the object. An equivalent valid JSON ping with different
whitespace is validated and answered after wake-up.

Client text frames are capped at 256 UTF-16 code units (JS string length).
Invalid client JSON, unknown fields, or unsupported messages close with
`1008`; oversized text closes with `1009`; binary frames close with `1003`.

## Close behavior

The server may also close with `1011` when connection attachment state is
invalid or a socket send fails. The configured compatibility date enables
Cloudflare's automatic reciprocal close handling.
