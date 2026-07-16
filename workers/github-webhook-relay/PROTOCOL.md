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
  "installationId": 123456,
  "payload": {}
}
```

`action`, `repository`, and `installationId` are `null` when the GitHub event
does not supply them. `payload` is the validated, complete GitHub JSON payload.
The webhook HMAC is intentionally not forwarded.

Consumers should reject unsupported `version` values and unknown `type` values.
Use `deliveryId` as the idempotency key.

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

Client text frames are capped at 256 characters. Invalid client JSON, unknown
fields, or unsupported messages close with `1008`; oversized text closes with
`1009`; binary frames close with `1003`.

## Close behavior

The server may also close with `1011` when connection attachment state is
invalid or a socket send fails. The configured compatibility date enables
Cloudflare's automatic reciprocal close handling.
