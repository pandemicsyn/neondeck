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
  validated with Zod. Payloads must be finite, acyclic JSON values before frame
  encoding.

## Secret handling

Store production secrets with `wrangler secret put`. Never commit `.dev.vars`,
environment-specific `.dev.vars.*` files, webhook secrets, bearer secrets, or
signed payload fixtures containing sensitive repository data.

The two secrets must be independent. Do not reuse a GitHub API token, account
password, Cloudflare credential, or other existing credential as either relay
secret.

Secret changes deploy a new Worker version and can disconnect active Durable
Object WebSockets. The implementation accepts one GitHub webhook secret at a
time, so webhook-secret rotation has no dual-secret overlap: coordinate the
Cloudflare and GitHub updates, then redeliver any delivery that failed during
the mismatch window.

## Known limitations

- Version 1 uses one shared WebSocket bearer secret per Worker deployment. It
  does not identify individual clients or provide per-channel authorization.
- Existing WebSocket connections are not reauthenticated after a secret
  rotation.
- There is no payload persistence, replay, acknowledgement, or delivery audit
  log.
- GitHub IP allowlisting, Cloudflare WAF rules, rate limiting, and per-client
  quotas are deployment-level hardening options, not implemented in this
  package.
- A valid client receives the complete GitHub event payload, which may contain
  private repository metadata. Treat the bearer secret accordingly.
- Browser clients are unsupported because the v1 handshake requires an
  `Authorization` header on the WebSocket upgrade.
