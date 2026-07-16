# Dashboard Event Transport: One Multiplexed Stream + Client Hub

Status: implemented (durable transport refactor)

Related:

- `.plans/OTHER_PEOPLE_PR_REVIEW.md` (the review flow whose overlay exposed this)
- PRs #115 / #116 / #117 (review-flow work)

## Problem

The dashboard opens **6–7 long-lived SSE connections** when Reviews is active,
against the browser's ~6-per-origin HTTP/1 cap. The report iframe request then
queues behind them indefinitely — the "white overview" — and the same starvation
explains earlier popout/workbench sluggishness. This is **not** a Vite-dev
artifact: the local/production server is plain HTTP/1 (`@hono/node-server`'s
`serve()` = `http.createServer`, no http2), so it affects shipped builds too.

Grounded connection count (call sites):

| Stream                        | Openers                                                                    | Count   |
| ----------------------------- | -------------------------------------------------------------------------- | ------- |
| `openConfigEventStream`       | `App.tsx:70`                                                               | 1       |
| `openChatSessionEventStream`  | `App.tsx:85`, `session-view.tsx:164`                                       | **2**   |
| `openNotificationEventStream` | `controller.tsx:56`                                                        | 1       |
| `openPrReviewEventStream`     | `ReviewsPanel.tsx:55`, `command-controls.tsx:82`, `GitHubPrReview.tsx:245` | **2–3** |

Plus **Flue's own** Durable Streams long-poll from `useFlueAgent`
(`session-view.tsx:85`), which also consumes a connection we do not control.

## Flue alignment (checked)

This design is consistent with the framework, not fighting it:

- **App-owned custom routes are sanctioned** (`docs/guide/routing.md`). Our event
  endpoints are ordinary Hono routes mounted alongside `flue()`.
- **Flue provides no server→browser push for app-domain events.** `channels.md`
  handles inbound provider webhooks only and states long-lived push is
  application infrastructure. So an app-owned SSE bus is the intended path.
- **We do not replace Flue's realtime.** `@flue/react` (`useFlueAgent` /
  `useFlueWorkflow`) observes agent conversations and workflow runs over Flue's
  Durable Streams layer. Our config / notification / session-index / pr-review
  events are app-domain broadcasts, not agent/workflow observation, and stay
  app-owned. We deliberately do **not** shoehorn them onto Flue's Durable Streams
  layer.
- **Verified (not assumed):** `@flue/sdk` sits on `@durable-streams/client` (the
  DS layer is even SSE-capable and dedup'd), but every exposed surface is scoped
  to an agent instance or workflow run (`client.agents.observe()`, per-instance
  `streamUrl`). There is **no generic `observe('<topic>')`** for arbitrary app
  data. Routing our events through DS would mean standing up our own DS
  producer/endpoint for app topics — a large new dependency, not a public Flue
  surface. So the two-transport split is confirmed. Our events are also idempotent
  "refresh me" pokes (client re-hydrates from the API on reconnect), so DS's
  durable exactly-once replay would be over-engineering for them regardless.
- **Budget consequence:** because Flue holds its own connection(s), reducing our
  streams to one — not four — is what leaves headroom. This is why we multiplex,
  not merely dedupe.

Mental model after this change: **one Flue client** (agent/workflow realtime) +
**one app event hub** (domain-event realtime). Both singletons.

## Target architecture

Decouple "number of live-updating features" from "number of connections" so this
class of bug cannot recur.

### 1. Server — one multiplexed `/api/events` SSE route

Replace the four separate route modules (`config-stream.ts`,
`notification-stream.ts`, `review-stream.ts`, `session-stream.ts`, each mounted at
`/api/events` in `create-app.ts:101-104`) with a single
`createEventStreamRoutes()` mounted once at `GET /api/events`. It subscribes to
all four in-process emitters and writes each as its existing **named** event:

- `subscribeConfigEvents` → `formatConfigServerSentEvent` (`event: config-change`)
- `subscribeNotificationEvents` → `formatNotificationServerSentEvent` (`event: notification-change`)
- `subscribeChatSessionEvents` → `formatChatSessionServerSentEvent` (`event: chat-session-change`)
- `subscribePrReviewEvents` → `formatPrReviewServerSentEvent` (`event: review-change`)

One `: connected` preamble, one heartbeat, one cleanup that unsubscribes all four
on `cancel`. Reuse the existing `format*ServerSentEvent` / `subscribe*Events`
functions as the fan-in seam, with one intentional framing change: config events
alone retain an SSE `id:` and therefore own the stream-wide `Last-Event-ID`
replay cursor. Notification, session, and review frames deliberately omit `id:`
so a later non-config event cannot replace the config cursor before reconnect.
Their named event types and JSON payload shapes remain unchanged.

Keep the route path `/api/events` (with a distinct sub-path or the bare path) so
the client opens exactly one `EventSource`. Remove the four old sub-routes.

### 2. Client — one event hub

Add `web/src/api/event-hub.ts`:

- Lazily opens **one** `EventSource('/api/events')` on first subscription.
- Maintains `Map<eventName, Set<listener>>`; `addEventListener(name)` on the
  source demuxes to the right listener set.
- `subscribe(eventName, onEvent, onError?)` returns an unsubscribe. Ref-counts:
  closes the source when the last subscriber leaves (or keeps one open for app
  lifetime — dashboard is single-user; either is fine, pick keep-open for
  simplicity and reconnect stability).
- Central reconnect/backoff and the `open`/`error` handling currently duplicated
  per-stream in `events.ts:49-67`.

Rewrite the existing `openConfigEventStream` / `openNotificationEventStream` /
`openChatSessionEventStream` / `openPrReviewEventStream` in `events.ts` as **thin
wrappers over `hub.subscribe(...)`**. Consumer call sites do not change — this is
the seam that keeps the migration zero-churn.

### 3. Overview overlay: loading/failure states (required) + inline render (optional hardening)

**What actually fixes the white overview is steps 1–2.** The blank was pure
connection starvation — the iframe (`PrReviewArtifactsOverlay.tsx:47`, `src=
/reports/:id`) couldn't obtain a connection because the SSE streams held all six.
At ~2 total connections there are ~4 free slots, so the iframe loads normally. So:

- **Required:** give the overlay an explicit **loading** state and a
  **timed-failure** state with **Retry** and **Pop out** actions, so a slow or
  failed report never shows a misleading blank document. Good UX regardless of
  transport.
- **Optional hardening:** switch the iframe to an inline fetch-and-render
  (`GET /reports/:id` as text, or a JSON `/api/reports/:id` via `readReport`) so
  the overview never competes for a connection even if the budget tightens again
  in future. Defer if you want a smaller PR; the loading/failure state is the part
  that must ship. If done, pick the report source explicitly (JSON structured
  render is cleaner than injecting server HTML).

### 4. Guardrail — no raw EventSource in components

After the hub exists, it is the only place allowed to construct an `EventSource`.
Enforce with a lint rule (`no-restricted-syntax` on `NewExpression[callee.name=
'EventSource']` outside `event-hub.ts`) or, minimally, a documented convention.
This is what prevents someone re-introducing stream #2 and re-creating the bug.

## Build order (one PR)

1. **Client hub** (`event-hub.ts`) + rewrite the four `openX` functions in
   `events.ts` as `hub.subscribe` wrappers. No consumer changes. (At this point
   the hub can still target the existing four endpoints — but do step 2 in the
   same PR so it lands at one connection.)
2. **Server fan-in**: `createEventStreamRoutes()` mounted once at `/api/events`;
   delete the four sub-route modules and their mounts (`create-app.ts:101-104`).
   Point the hub at the single endpoint.
3. **Fix the duplicate subscriptions** as a natural consequence: with the hub,
   `App.tsx` + `session-view.tsx` sharing `chat-session-change`, and
   `ReviewsPanel` + `command-controls` + `GitHubPrReview` sharing `review-change`,
   all ride one connection. Verify no component holds its own source.
4. **Reports inline render** in `PrReviewArtifactsOverlay.tsx` + loading/failure
   states.
5. **Guardrail** lint rule/convention.

## Verification

- Unit: multiple `hub.subscribe('review-change', …)` callers result in exactly one
  `EventSource`; unsubscribing the last releases it (or, if keep-open, that
  re-subscribe reuses the same source). Event demux routes each named event only
  to its listeners.
- Integration/manual: with Reviews active + a chat card + workbench open, DevTools
  Network shows **one** `/api/events` EventSource (plus Flue's long-poll), not 6–7.
- The overview overlay renders report content (not a blank iframe) while streams
  are active; loading → content, and failure → Retry/Pop-out.
- Server: one client receives config/notification/session/review events over the
  single stream; unsubscribe/disconnect cleans up all four emitter subscriptions.
- Reconnect: a non-config event after a config event leaves the config replay
  cursor intact and does not trigger a full config-buffer replay.
- `npm run check` (typecheck, lint incl. the new guardrail rule, tests).

## Decisions locked

- **Transport:** app-owned SSE, one multiplexed `/api/events`. Not per-type
  streams, not ref-count-to-four (still crowds Flue's connection), not WebSocket
  (bidirectional unneeded), not HTTP/2 (needs localhost TLS; multiplexed SSE gives
  the same budget relief without it).
- **Do not** route app-domain events through Flue's Durable Streams / `@flue/react`
  observation layer — that layer is for agent/workflow observation and is not a
  general app-event bus.
- **Overview is inline-rendered**, never an iframe.
- **The hub is the only EventSource constructor** (guardrail).

## Non-goals

- No change to Flue's agent/workflow realtime (`useFlueAgent`/`useFlueWorkflow`).
- No server-side per-subscriber event filtering — single-user local dashboard;
  the client demuxes and ignores irrelevant events.
- No new event _types_ or JSON payload changes. Only the non-config SSE `id:`
  framing changes to preserve the multiplexed stream's config replay cursor.
