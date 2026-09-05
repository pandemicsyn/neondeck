# GitHub intake and reconciliation

Increment 4 brings GitHub issues and attributed discussion into the existing
Factory workbench. It ends at human release, awaiting a coding executor. There are
no outbound GitHub comments, status edits, webhook creation, deployment actions,
or coding-agent launches. Keep existing PR Autopilot behavior separate.

## Configure a connection

Open **Factory → GitHub connections**. Select a registered repository, enter its
numeric GitHub repository ID, select either a required label or all issues, and
save the connection. A connection starts disabled. Enable it deliberately once the
mapping and credentials are ready. Multiple enabled mappings for the same remote
repository report attention and cannot admit competing tasks. Connection saves use
a retained configuration fingerprint; stale saves preserve the local form and ask
for review. Changes to a connection invalidate affected releases before replacing
the config file; a failed file write leaves conservative revocation visible.

The secret fields accept **environment variable names only**, for example
`FACTORY_GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN`. Put their values in the private
runtime environment or the runtime home's gitignored `.env`, never in configuration
JSON, issue content, screenshots or tracked files. Restart after changing secret
values. Reuse the existing environment loader; no OAuth or GitHub App setup is
introduced. The GitHub credential needs repository metadata and issue/comment read
access. No write permission is needed by this increment. Readiness indicates local
configuration/credential presence, not a successful live access or exposure test.

## Listener configuration

Build and run with Node 26.4.0 using `npm run build:dashboard` and `neondeck serve`.
The packaged `dist/server.mjs` delegates to the same owned host as the CLI.
Direct systemd/launchd startup loads the runtime home's `.env` before resolving
listeners; supplied process environment wins. No development `.env` fallback is
used by that entry. IPv6 loopback uses bracketed `http://[::1]:<port>` URLs in the
dashboard launcher, service health probe and startup display.

| Variable                   | Default     | Purpose                                                                   |
| -------------------------- | ----------- | ------------------------------------------------------------------------- |
| `NEONDECK_PRIVATE_HOST`    | `127.0.0.1` | Only `127.0.0.1` or `::1` is accepted.                                    |
| `NEONDECK_PORT` / `--port` | `3583`      | Private dashboard/API port.                                               |
| `NEONDECK_INGRESS_PORT`    | Unset       | Enables the separate webhook listener. Must differ from the private port. |
| `NEONDECK_INGRESS_HOST`    | `127.0.0.1` | Set explicitly for the approved reverse-proxy topology.                   |

The ingress app serves only `GET /health` and
`POST /hooks/github/<connection-id>`; unknown paths return 404. It never forwards
to the dashboard, API, agent, report, attachment or static routes. Spoofed Host and
Origin headers do not change that route map. Existing private browser guards are
not authentication. Use an SSH-only path or independently verified authenticated
proxy for dashboard access.

One generated Flue application owns both listeners and the existing scheduler.
The custom host uses Flue 2.0.3's documented non-listening application bootstrap;
it does not rebuild runtime registration. Source recovery starts only after both
binds succeed. A second bind failure closes the first listener and stops the
runtime. Shutdown closes listeners, stops source polling/scheduled services and
MCP connections, and drains Flue, with a bounded process shutdown deadline.

Before a future exe.dev deployment, read its [documentation index](https://exe.dev/llms.txt)
and [proxy guide](https://exe.dev/docs/proxy). Select the webhook port explicitly
with `ssh exe.dev share port <vm> <ingress-port>` before making that proxy public.
Never select the private port. exe.dev documents private access by default and
separate visibility for additional ports. Actual routing, authentication and
anonymous probes of all private paths must still be verified on the approved
instance. This implementation has not deployed, configured sharing, changed SSH,
or contacted an operator VM.

## Receipt and source behavior

Subscribe only to relevant `issues` and `issue_comment` events. The receiver checks
HMAC-SHA256 against original bytes before parsing, requires a valid signature and
delivery ID, binds the signed repository identity to current mapping, and excludes
pull requests and unrelated actions. It reads at most 1 MiB within five seconds,
including bodies without Content-Length. Persistence must succeed before the 202
response. Replayed connection/delivery IDs reuse the receipt; changed bytes under
the same ID conflict. No GitHub fetch or model work runs in the request.

The deterministic recovery loop re-fetches repository identity and the current full
issue. Stable numeric remote identities deduplicate work. It never fetches URLs
supplied by source content. Older timestamps cannot overwrite newer source state;
differing content at equal timestamps advances the local source version and asks
for review. Full bodies up to 65,536 characters are retained. Invalid/oversized
content becomes visible attention, never a silent 600-character excerpt.

Source closure pauses work and invalidates release. Reopening returns to shaping;
old authority never revives. Local reopen cannot claim a remote issue is open.
Source content is read-only in Neon: use **Sync source**, or edit the brief. Draft
and release concurrency fences remain active while reconciliation runs.

**Sync source** persists a requested reconciliation. Periodic recovery also repairs
missed webhooks. Each pass has a 45-second deadline and a 12-provider-request budget,
processing one due delivery and rotating through configured connections durably.
Within a connection, admitted issues rotate; discovery uses 25-item `state=all`
pages and persists completed item offsets/page checkpoints. A failed or incomplete
page never advances beyond its processed input. The naive discovery cycle repeats
a full scan from the beginning, providing complete overlap to repair moving-page
misses; this costs more reads than an incremental timestamp watermark. It has no
claim of a provider snapshot. Finite, quiescent repositories converge over passes.
Transient/rate-limit failures back off, with structured retry metadata; auth,
missing-source and mapping failures remain visible independently of draft readiness.
Unavailable individual issues transfer to a durable retry receipt before discovery
advances, so they cannot starve later issues. Rate limits and other failed reads
retain the current cursor. Persisted page identities survive moving provider pages
and process restarts; due retry receipts are selected oldest-due first.

## Attributed discussion and human review

Comments retain remote ID, author, body, timestamp, local revision and deletion
state. Incomplete pagination never implies deletion. After a completed pass, unseen
IDs are individually checked; only a confirmed missing comment becomes a tombstone.
The retained body remains inspectable with the deletion label. Comment material
changes invalidate the accepted source version and flag human review.

Before planning starts, replies remain visible under **Source and repository**.
After a human starts the persistent planner, the app records an attributed context
intent and delivers it through the existing Flue receipt/recovery path. A retry
uses the same identity; it cannot create a second effective conversation delivery.
These context turns have no application tools, sandbox or declared delegates
(Flue's inert built-in `task` entry remains in its roster). They cannot propose a
spec, release, publish or impersonate `local-operator`. Only a subsequent explicit
human planning request or human draft save adopts changes. Comments do not retriage
already-shaped tasks. Refresh captured planning context explicitly when it is stale.

Outbound effects and echo suppression belong to increment 5. Future suppression
must match confirmed owned comment ID and revision, not all bot authors or a marker.

## Validation and evidence

Tests cover raw signatures/replays/size limits, identity and mapping, source ordering,
closure/reopen, paginated recovery/rate limits, comment attribution and confirmation,
release authority, actual Flue context receipt replay across runtime restart, and
owned listener lifecycle. The installed-package smoke verifies both ports, private
route exclusion, shutdown and public bind failure rollback. Synthetic UI evidence
uses `FACTORY_GITHUB_FIXTURE=1` with `scripts/factory-planning-fixture.ts` and the real
workbench plus deterministic model/provider responses. It is not live GitHub proof.

Run `fnm exec --using 26.4.0 npm run check` and `npm run verify` with the same explicit
Node selection. Evidence manifests record the exact frozen source and actual results.
Dedicated reviews, manager acceptance, publication and deployed exposure acceptance
are separate gates; no document assertion substitutes for them.

Provider contracts: [GitHub signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks),
[issue REST reads](https://docs.github.com/en/rest/issues/issues), and
[issue-comment REST reads](https://docs.github.com/en/rest/issues/comments).

## Read health and bounded discussion

Transient connectivity, rate-limit, deadline and shutdown read failures stay in
retry/health state. They do not change source versions or withdraw a release when
no new context was observed. An unavailable source, invalid content or confirmed
identity/context change still requires human review. Discovery retains identity
and admission fields before fetching full content per issue; an oversized issue
gets a durable attention receipt while valid later issues continue.

Global GitHub state contains connection and sync health, not discussion bodies.
The work-scoped `/api/factory/work/:id/comments` endpoint returns at most ten
retained comments, newest first, with an opaque row cursor for older pages. The
workbench offers newer/older controls and polls only the selected task/page.
External discussion remains attributed context without approval authority.
