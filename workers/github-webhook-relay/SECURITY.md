# Security model

## Trust boundaries

- GitHub ingress is authenticated with `X-Hub-Signature-256` using a dedicated
  HMAC secret. JSON is decoded only after signature verification.
- WebSocket upgrades use a separate bearer secret. Authentication completes
  before the Worker resolves a Durable Object binding.
- Channel names route traffic but grant no authority.
- Worker-to-Durable-Object requests remove the bearer credential before
  forwarding the upgrade.
- RPC inputs, connection attachments, HTTP JSON bodies, and WebSocket frames are
  validated with valibot. Payloads must be finite, acyclic JSON values before
  frame encoding.

## Secret handling

Store production secrets with `wrangler secret put`. Never commit `.dev.vars`,
environment-specific `.dev.vars.*` files, webhook secrets, bearer secrets, or
signed payload fixtures containing sensitive repository data.

The two secrets must be independent. Do not reuse a GitHub API token, account
password, Cloudflare credential, or other existing credential as either relay
secret.

Secret changes deploy a new Worker version and can disconnect active Durable
Object WebSockets. The webhook secret supports a dual-secret overlap during
rotation: setting the optional `GITHUB_WEBHOOK_SECRET_PREVIOUS` lets the relay
verify a signature against either the current or the outgoing secret, so
GitHub and Cloudflare do not need to be updated atomically. See README.md for
the rotation procedure. `WS_CLIENT_SECRET` has no equivalent overlap;
rotating it disconnects every WebSocket client at once.

## Known limitations

- Version 1 uses one shared WebSocket bearer secret per Worker deployment. It
  does not identify individual clients or provide per-channel authorization.
- Existing WebSocket connections are not reauthenticated after a secret
  rotation.
- There is no payload persistence, delivery acknowledgement, or audit log. The
  per-channel event log used for replay stores routing facts only (delivery
  ID, event, action, repository, PR number, received time) — never the GitHub
  payload — and is retained for roughly 24 hours or 1000 events, whichever is
  smaller. It exists only to let a reconnecting client catch up; it is not a
  general-purpose audit trail.
- GitHub IP allowlisting, Cloudflare WAF rules, rate limiting, and per-client
  quotas are deployment-level hardening options, not implemented in this
  package.
- A valid client receives the complete GitHub event payload, which may contain
  private repository metadata. Treat the bearer secret accordingly.
- Browser clients are unsupported because the v1 handshake requires an
  `Authorization` header on the WebSocket upgrade.
