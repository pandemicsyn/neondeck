# GitHub Webhook Relay Integration Plan

Status: proposed; supersedes the integration-free shape of PR #133 (`codex/github-webhook-relay`)
Prerequisite: rebase `codex/github-webhook-relay` onto `main` before any phase below — see [Prerequisite](#prerequisite--rebase-onto-main)
Prior art: PR #133 review (2026-08-16), `workers/github-webhook-relay/{README,PROTOCOL,SECURITY}.md`

## Problem

Neondeck's only source of GitHub truth is the REST/GraphQL API. Every read
terminates at `githubFetch` in `src/modules/github/client.ts`. The scheduler
loop ticks every 60s (`src/server/scheduler-loop.ts`), but the two refreshers it
drives self-throttle to three minutes:

| Constant                          | Location                               | Value |
| --------------------------------- | -------------------------------------- | ----- |
| `githubQueueRefreshIntervalMs`    | `src/modules/github/queue-snapshot.ts` | 3 min |
| `prReviewRemoteRefreshIntervalMs` | `src/modules/pr-reviews/service.ts`    | 3 min |

The client is already efficient: ETag conditional requests with 304
short-circuits, in-flight request dedup, a concurrency cap of 8, and a 45s queue
cache. Rate limit is not the constraint.

**The constraint is a three-minute latency floor on noticing that anything
changed at all.** That is what the relay exists to fix.

## Design decisions

These were settled during the 2026-08-16 design discussion and should not be
relitigated without new evidence.

### 1. The relay signals _when_, never _what_

A webhook envelope carries one event's payload. What the dashboard renders is a
`GitHubQueueSnapshot` composed from cross-repo search, `fetchPullRequestDetail`,
`fetchCheckSummary`, review threads, comments, and watermarks. That cannot be
reconstituted from `pull_request.synchronize`. The relay also has no binding to
the user's GitHub token, so it cannot fetch anything on their behalf.

The relay is a **cache-invalidation signal**. On a relevant event, neondeck
calls the refresher it already has with `{ force: true }`. The GitHub call still
happens; it happens because something changed instead of because a timer fired.
ETags keep the confirming fetch cheap.

### 2. No new event bus

`src/server/events/event-stream.ts` already fans ~10 module-level pub/sub
sources onto SSE, and `refreshGitHubQueueSnapshotOnce` already does content-hash
change detection (`changed = next.revision !== previous.revision`), emitting
only on real change.

The relay client therefore publishes **nothing of its own**. It calls
`refreshGitHubQueueSnapshot(paths, {}, { force: true })`; if content actually
changed, the existing `github-queue-change` SSE event fires on its own. Zero new
dashboard wiring. The relay never touches the render path.

### 3. Hibernating WebSocket, not HTTP polling

A cursor-polled HTTP endpoint was considered and rejected on cost. Durable
Objects hibernate after **10 consecutive idle seconds**. Polling the DO every
20s leaves it resident 10s out of every 20 — a 50% duty cycle billed as
duration the whole time. Polling faster than 15s means it never hibernates.

At 128 MB per object that is roughly **162,000 GB-s/month per channel** to
deliver nothing, against a free allowance near 313,000 GB-s/month.

A hibernating WebSocket accrues no duration while idle and wakes only on real
deliveries. PR #133 already uses `setWebSocketAutoResponse`, which answers the
canonical ping without waking the object — the correct primitive.

Corollary: if an HTTP catch-up endpoint is ever added, it must read from D1, not
from the DO. Reads that touch the DO reintroduce the wake cost.

### 4. Correctness never depends on the relay

The timer keeps running. A user who never deploys a worker gets exactly today's
behavior. A user whose socket is asleep, dropped, or misconfigured degrades to
today's behavior. This is what makes the client shippable without forcing a
Cloudflare deployment on anyone.

Replay is an optimization. The **forced refresh on every connect and reconnect**
is the correctness guarantee.

## Prerequisite — rebase onto `main`

**This blocks Phases 3 and 4 outright and should be done before Phase 1.**

The branch is ~150 PRs behind: it forks from `main` at #106, and `main` is now
at #267. Every integration point this plan targets is post-#106 work that does
not exist on the branch:

| Path                                     | Needed by |
| ---------------------------------------- | --------- |
| `src/server/scheduler-loop.ts`           | Phase 4   |
| `src/server/events/event-stream.ts`      | Phase 3   |
| `src/modules/github/queue-snapshot.ts`   | Phase 3–4 |
| `src/modules/github/event-budget.ts`     | Phase 4   |
| `src/modules/pr-events/watch-refresh.ts` | Deferred  |

Every `src/` path referenced in this document is accurate against `main` @
`49f4f02`, **not** against the pre-rebase branch. Reading them there returns
nothing.

### Conflict expectation

Low. The PR touches 29 files, of which only two live outside
`workers/github-webhook-relay/`, and both are single-line additive changes:

- `.prettierignore` — adds `workers/github-webhook-relay/worker-configuration.d.ts`
- `vitest.shared.ts` — adds `workers/github-webhook-relay/**` to `baseExclude`

`git merge-tree --write-tree origin/main HEAD` currently succeeds, so the rebase
is expected to be mechanical. Re-verify before starting; `main` moves.

### Steps

```bash
git fetch origin main
git rebase origin/main
```

Then, in the same pass:

1. Bump `compatibility_date` in `workers/github-webhook-relay/wrangler.jsonc`
   (currently `2026-07-16`).
2. Drop the unused `nodejs_compat` flag — no Node API is used, and it costs
   startup time.
3. Add this document to `.plans/README.md` under "Active Or Deferred Work".
   That index file does not exist on the pre-rebase branch; it arrives with the
   rebase, so the entry cannot be written until this step completes.

### Verification

```bash
npm ci && npm run check
```

```bash
cd workers/github-webhook-relay && npm ci && npm run check
```

The worker's `check` script already chains format, lint, `wrangler types
--check`, TypeScript, tests, and a `wrangler deploy --dry-run`. Confirm the
table paths above now resolve before starting Phase 3.

Publishing the rebase rewrites the PR branch, so it needs
`git push --force-with-lease`. Confirm no other worktree has
`codex/github-webhook-relay` checked out first — this repo runs many concurrent
agent worktrees (`git worktree list`).

### What can proceed without it

Phases 1 and 2 are confined to `workers/github-webhook-relay/` and
`.github/workflows/`, and touch no `src/` path. They can be developed
pre-rebase if there is a reason to parallelize, but land them after the rebase
to keep the branch linear and reviewable.

## Phase 1 — worker: durable event log

The DO is declared `new_sqlite_classes` in `wrangler.jsonc` and currently stores
nothing. A laptop that sleeps loses every event in the gap.

1. In `src/relay-room.ts`, add an append-only SQLite table:
   `(seq INTEGER PRIMARY KEY, deliveryId TEXT UNIQUE, event TEXT, action TEXT, repository TEXT, prNumber INTEGER, receivedAt TEXT)`.
   Store routing facts only — **not** the full payload. The client re-fetches
   from GitHub regardless, and not persisting payloads keeps the relay out of
   scope for private repository data at rest.
2. Prune on write: retain ~24h or ~1000 rows, whichever is smaller.
3. Accept `?since=<deliveryId>` on the WebSocket upgrade. On accept, replay rows
   after that delivery as normal frames, then resume live. Unknown or expired
   cursor replays nothing and sets a `replayTruncated: true` flag on the first
   frame so the client knows to force a full refresh.
4. Extend the upgrade forwarding in `src/index.ts` to carry the cursor through
   to the DO (currently it constructs a bare internal request).
5. Stop flattening DO errors to 503. `webSocketUpgradeResponseSchema.parse()`
   throws on any non-101, so `RelayRoom.fetch`'s own `400 invalid_request`
   surfaces as "relay unavailable" — a routing bug is indistinguishable from an
   outage. Pass the DO response through when it is not a 101.
6. Accept an array of webhook secrets and try each on verify. One secret means
   rotation has a guaranteed signature-mismatch window, which SECURITY.md
   currently documents as unavoidable. It is ~5 lines to remove.

### Phase 1 acceptance

- Replay test: connect, disconnect, deliver N webhooks, reconnect with cursor,
  assert exactly the missed N arrive in order.
- Eviction test extended to cover replay across `evictDurableObject`.
- Pruning test: assert bounded growth past the retention limit.
- **Hibernation test:** assert the DO stays hibernated across N canonical pings.
  This guards decision 3 and is the test most likely to catch a regression that
  silently reintroduces duty-cycle billing.

## Phase 2 — CI

PR #133's 23 tests never run. `vitest.shared.ts` adds
`'workers/github-webhook-relay/**'` to `baseExclude`, root `npm run lint` does
not list the path, and no workflow mentions `workers` at all —
`.github/workflows/pr-checks.yml` runs only `lint`, `typecheck:app`, and
`build:dashboard`.

The package isolation is deliberate and correct. It needs its own job:

```yaml
- run: cd workers/github-webhook-relay && npm ci && npm run check
```

Gate on `paths: ['workers/github-webhook-relay/**']` so it only runs when the
worker changes.

## Phase 3 — client: relay connection

New module `src/modules/github/relay-client.ts`, started alongside
`startSchedulerLoop` from `src/server/create-app.ts:271`.

1. Config: relay URL + client secret, both optional. Absent means the module is
   inert and nothing else changes.
2. Connect with `Authorization: Bearer <secret>` and the last-seen delivery
   cursor, persisted so it survives a process restart.
3. Reconnect with exponential backoff and jitter, capped around 5 min.
4. **On every connect and reconnect, force one full refresh** regardless of what
   replay returns. This is decision 4 and is not optional.
5. On a live frame, force-refresh the affected surface. Start coarse — call
   `refreshGitHubQueueSnapshot(paths, {}, { force: true })` for any PR-shaped
   event. Targeted invalidation via `pr-events` watermarks is a later
   refinement, not v1.
6. Debounce: coalesce bursts within ~2s into one refresh. A push with 30 commits
   fans out to many events and must not become many GitHub fetches.
7. Keepalive **must be the byte-exact canonical ping**. `setWebSocketAutoResponse`
   matches literally; a whitespace variant falls through to `webSocketMessage`
   and wakes the DO on every keepalive, restoring the duty-cycle cost decision 3
   exists to avoid. Import `pingFrameText` semantics rather than hand-rolling
   the string.
8. Expose a health signal (`connected` + `lastFrameAt`) for Phase 4.

## Phase 4 — adaptive refresh interval

Make `githubQueueRefreshIntervalMs` and `prReviewRemoteRefreshIntervalMs`
resolve from relay health rather than being module constants:

- relay connected and healthy → 15 min
- relay absent, disconnected, or stale → 3 min (today's value)

Recheck on every scheduler tick so a dropped socket restores the fast interval
within 60s. This is where the actual API-volume saving lands; Phases 1–3 buy
latency, Phase 4 buys request budget.

## Deferred

- Targeted per-surface invalidation from webhook event type. Coarse refresh
  first; measure before adding routing complexity.
- Per-client identity and per-channel authorization. One shared bearer secret
  per deployment is correct for the self-deploy single-user model. Revisit only
  if a shared/team deployment is on the roadmap.
- HTTP catch-up endpoint. Only if WS proves unreliable in practice, and only
  D1-backed per decision 3.
- Zod-on-trusted-data cleanup in the worker (`requestTargetSchema`,
  response-object round-trips, `socketFrameSchema` over an
  already-typed `string | ArrayBuffer`, close-code validation that silently
  drops the log). Real overhead on every request, but cosmetic against this
  plan's goals — fold into Phase 1 only if touching those files anyway.

## Open questions

- Channel naming for a single-user install: one fixed channel per install, or
  one per repo? One-per-install is simpler and the DO cost is per-object, which
  argues against per-repo fan-out.
- Does `Content-Length` hard-requirement in `verifyGithubWebhook` hold behind
  every proxy users might front the worker with? Chunked delivery is a flat 400
  today with no diagnostic.
