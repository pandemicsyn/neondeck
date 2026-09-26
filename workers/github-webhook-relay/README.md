# GitHub webhook relay

A standalone Cloudflare Worker that verifies GitHub webhook deliveries and
broadcasts them to authenticated WebSocket clients. Each channel is coordinated
by a hibernating Durable Object.

This package is intentionally isolated from the Neondeck runtime. It has its own
lockfile, configuration, commands, deployment, and wire protocol. Nothing in
this package enables or configures a Neondeck client.

## Runtime shape

The Worker exposes three routes:

| Method | Route                                | Purpose                          |
| ------ | ------------------------------------ | -------------------------------- |
| `GET`  | `/healthz`                           | Unauthenticated liveness check.  |
| `POST` | `/channels/:channel/webhooks/github` | Signed GitHub webhook ingress.   |
| `GET`  | `/channels/:channel/ws`              | Authenticated WebSocket upgrade. |

Channels are public routing identifiers, 1–64 characters long, made of ASCII
letters, digits, underscores, and hyphens, and must start with a letter or
digit — a channel beginning with `_` or `-` is rejected with `404`. A channel
is not a credential. The same channel name in both URLs routes the webhook and
clients to the same Durable Object.

## Local development

Use Node 26 and run commands from this directory:

```sh
fnm exec --using=26.4.0 npm ci
cp .dev.vars.example .dev.vars
fnm exec --using=26.4.0 npm run check
fnm exec --using=26.4.0 npm run dev
```

Set strong, different values for both entries in `.dev.vars`.
`WS_CLIENT_SECRET` must be 16–256 visible ASCII characters;
`GITHUB_WEBHOOK_SECRET` must be at least 16 characters and is used as UTF-8 HMAC
key material. `.dev.vars` and environment-specific variants are ignored by Git.

The default maximum webhook body is 1 MiB. `MAX_WEBHOOK_BYTES` may be adjusted
in `wrangler.jsonc` up to the code-enforced 5 MiB ceiling. The lower cap is
intentional: signature verification, UTF-8 decoding, JSON parsing, and schema
validation must all fit safely within the Worker memory limit. Oversized
deliveries receive `413`.

## Cloudflare deployment

On the first deployment, Wrangler cannot use `secret put` because the Worker
does not exist yet, while `secrets.required` prevents deploying without both
secrets. Create an ignored, owner-readable `.dev.vars.production` file:

```text
GITHUB_WEBHOOK_SECRET=<production-webhook-secret>
WS_CLIENT_SECRET=<production-client-secret>
```

Then authenticate, validate, and atomically create the Worker with its required
secrets:

```sh
fnm exec --using=26.4.0 npx wrangler whoami
fnm exec --using=26.4.0 npm run check
fnm exec --using=26.4.0 npx wrangler deploy --secrets-file .dev.vars.production
```

Delete the local production secrets file after deployment if it is not needed
for your release process. Never pass secret values on the command line or store
them in `wrangler.jsonc`.

For later rotations, use interactive `wrangler secret put`. A secret update
deploys a new Worker version and may terminate existing Durable Object
WebSockets; clients must reconnect and use the new WebSocket secret.

`GITHUB_WEBHOOK_SECRET_PREVIOUS` gives the GitHub webhook secret an overlap
window: set it to the outgoing value while rotating, and the relay accepts a
signature verified against either secret. To rotate without a mismatch
window:

1. `wrangler secret put GITHUB_WEBHOOK_SECRET_PREVIOUS`, set to the current
   (soon-to-be-outgoing) `GITHUB_WEBHOOK_SECRET` value.
2. `wrangler secret put GITHUB_WEBHOOK_SECRET`, set to the new value.
3. Update the GitHub webhook's secret to the same new value.
4. Once GitHub deliveries are confirmed passing with the new secret, run
   `wrangler secret delete GITHUB_WEBHOOK_SECRET_PREVIOUS` to close the
   overlap window.

`WS_CLIENT_SECRET` has no such overlap mechanism: rotating it disconnects
every client at once, and clients must reconnect with the new value.

## GitHub webhook setup

Create a repository, organization, or GitHub App webhook with:

- Payload URL:
  `https://<worker-host>/channels/<channel>/webhooks/github`
- Content type: `application/json`
- Secret: the exact value stored as `GITHUB_WEBHOOK_SECRET`
- SSL verification: enabled
- Events: only the events consumers need

The Worker requires `Content-Length`, `Content-Type`, `X-GitHub-Delivery`,
`X-GitHub-Event`, `X-GitHub-Hook-ID`, and `X-Hub-Signature-256`. It verifies the
HMAC-SHA256 signature over the untouched body before decoding JSON.

A successful synchronous broadcast attempt returns:

```json
{
  "relayed": true,
  "protocolVersion": 1,
  "deliveryId": "8c2f4fb8-1a2b-4f4d-92cf-a0d9a7ab53f0",
  "deliveredClients": 2
}
```

This response is `200`, including when `deliveredClients` is zero. It means the
best-effort fan-out attempt completed; it does not mean any client durably
processed the event.

## HTTP response contract

`GET /healthz` returns `200` with:

```json
{ "ok": true, "service": "github-webhook-relay" }
```

All HTTP error bodies use this schema:

```json
{ "error": "Human-readable message.", "code": "machine_readable_code" }
```

| Route                    | Status | Meaning                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook                  | `200`  | Synchronous best-effort fan-out completed.                                                                                                                                                                                                                                                     |
| Webhook                  | `400`  | Required headers, length, UTF-8, JSON, or payload shape is invalid.                                                                                                                                                                                                                            |
| Webhook                  | `401`  | HMAC signature is invalid.                                                                                                                                                                                                                                                                     |
| Webhook                  | `413`  | Declared or streamed body exceeds the configured limit.                                                                                                                                                                                                                                        |
| Webhook                  | `500`  | Required Worker configuration is invalid.                                                                                                                                                                                                                                                      |
| Webhook                  | `503`  | Durable Object lookup, validation, or broadcast failed.                                                                                                                                                                                                                                        |
| WebSocket                | `101`  | Authenticated upgrade succeeded.                                                                                                                                                                                                                                                               |
| WebSocket                | `400`  | The Durable Object rejected the connection request itself; passed through as-is rather than reported as an outage. This is defense-in-depth only — the public route already validates channel, method, and `Upgrade` before calling the Durable Object, so external callers cannot trigger it. |
| WebSocket                | `401`  | Bearer authentication failed; includes `WWW-Authenticate`.                                                                                                                                                                                                                                     |
| WebSocket                | `426`  | `Upgrade: websocket` is missing; includes `Upgrade`.                                                                                                                                                                                                                                           |
| WebSocket                | `500`  | Required Worker configuration is invalid.                                                                                                                                                                                                                                                      |
| WebSocket                | `503`  | Durable Object lookup or `fetch` failed, it returned a `101` without a paired WebSocket, or it returned a non-101 status other than `400` (mapped to `503` rather than passed through).                                                                                                        |
| Either channel route     | `405`  | Wrong method; includes the route's `Allow` header.                                                                                                                                                                                                                                             |
| Unknown or invalid route | `404`  | Route or channel name is not recognized.                                                                                                                                                                                                                                                       |

## WebSocket clients

Connect to:

```text
wss://<worker-host>/channels/<channel>/ws
```

The HTTP upgrade must include:

```text
Authorization: Bearer <WS_CLIENT_SECRET>
Upgrade: websocket
```

The secret is accepted only in the `Authorization` header. Query-string
credentials are not supported. This v1 handshake is intended for server-side or
CLI clients that can set custom upgrade headers; browser WebSocket clients are
not supported.

Add `?since=<deliveryId>` to replay events broadcast while disconnected:

```text
wss://<worker-host>/channels/<channel>/ws?since=<last-seen-deliveryId>
```

See [PROTOCOL.md](./PROTOCOL.md) for the complete frame contract, including
the `github.webhook.replay` frame shape and the `replay.truncated` signal.

## Delivery semantics

Version 1 deliberately has small, explicit guarantees:

- Events are broadcast only to clients connected to that channel when the
  signed webhook arrives.
- The relay never persists the GitHub payload. Each Durable Object keeps an
  append-only log of routing facts only (delivery ID, event, action,
  repository, PR number, received time) for roughly the last 24 hours or 1000
  events per channel, whichever is smaller, purely to support replay on
  reconnect — see [Replay on reconnect](./PROTOCOL.md#replay-on-reconnect).
  There is no queue, no client acknowledgement, and no backpressure.
- GitHub redelivery can produce duplicate frames. Consumers must deduplicate on
  `deliveryId`; a GitHub redelivery uses the original delivery ID.
- Socket send failures are isolated from other clients. A completed fan-out is
  still best-effort and may report fewer delivered clients than connected
  clients.
- Channel ordering follows serialized Durable Object request handling, but the
  protocol does not promise durable global ordering or sequence numbers.
- A disconnected or reconnecting client can replay events up to the retention
  window above. Past that window, or on a cursor the log never recorded, the
  connection receives a `replay.truncated` frame instead and must fall back to
  a full refresh from GitHub.

## Observability

Workers Logs and sampled traces are enabled. Structured logs include channels,
delivery IDs, event names, connection IDs, and delivery counts. Payload bodies,
webhook signatures, bearer credentials, and configured secrets are never
logged.

See [SECURITY.md](./SECURITY.md) for trust boundaries and known limitations.
