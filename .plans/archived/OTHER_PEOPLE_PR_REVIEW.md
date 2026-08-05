# Reviewing Other People's Pull Requests

## Status

Issue brief based on the `/review-pr` flow observed on July 14, 2026 with `pandemicsyn/neondeck#101`, a pull request not authored by the local GitHub user.

## Problem

Neondeck can review an arbitrary pull request and successfully produces local reports and Neon draft comments, but the dashboard does not provide a coherent way to reach or use those results when the pull request is not already present in the GitHub queue.

The backend capability exists. The user-facing handoff is broken across Chat, GitHub, Reports, notifications, and development routing.

## Observed Issues

### 1. Chat reports admission as completion

`/review-pr <url>` runs the outer `command-run` workflow, which admits a nested `review-pr-for-human` workflow. The Chat card is marked `completed` as soon as the nested workflow is queued and displays only its run ID.

The card does not observe the nested run, transition through its actual state, or update when review artifacts are ready. In the observed run, the real review finished about 31 seconds after Chat reported completion.

This makes `completed` misleading: it means "queued successfully," not "review completed."

### 2. The GitHub dashboard cannot surface the reviewed PR

The GitHub queue currently searches configured repositories for open pull requests authored by the logged-in GitHub user. A review requested by URL can therefore succeed while the reviewed PR remains absent from the dashboard.

The dashboard copy says it includes authored, assigned, and review-requested PRs, but the current query implementation only produces the `authored` relation.

The standalone review workbench can already fetch an arbitrary repository and PR number. It should not depend on the PR being present in the queue.

### 3. Report links are broken in local development

The Reports panel opens `/reports/:id` in a new tab. The Vite development server proxies `/api` but not `/reports`, so Vite serves the dashboard SPA for that path instead of forwarding the request to the Neondeck backend.

The visible result is that clicking **open** appears to load the same dashboard again. The backend report HTML route itself exists and works when accessed directly on the backend origin.

### 4. Reports are a dead-end index

The Reports panel lists the generated `PR Overview` and `Review Issues` artifacts, but it does not:

- preview or expand their contents;
- provide a working report link in development;
- link to the associated review workbench; or
- explain that Neon also seeded local draft comments.

Even after finding the reports, the user has no discoverable path from those rows to the actionable review surface.

### 5. The useful completion link is transient

The review workflow creates a `PR review ready` notification containing an `Open review` target. That notification is currently the only connected path from workflow completion to the standalone review workbench.

If the user misses the notification, neither the Chat transcript nor the Reports panel preserves that action.

### 6. The safety boundary is not explained at the point of use

`review-pr-for-human` creates local reports and local Neon-origin draft comments. It does not submit a GitHub review. Submission remains an explicit human action from the review workbench.

That is the correct safety boundary, but the queued Chat result and Reports rows do not explain it or tell the user what to do next.

## Root Causes

- Workflow admission and workflow observation are treated as the same user-visible event. Chat waits for the outer command result but does not follow the nested Flue run.
- The GitHub list is being used as the discovery surface for review results even though its queue is scoped to user-related PRs.
- Review artifacts carry report and review URLs, but those actions are not propagated back into the persistent Chat result or report rows.
- Local development routing does not proxy the non-API `/reports` backend route.
- The experience is spread across short-lived notifications and unrelated dashboard tabs without a persistent result surface.

## Relevant Implementation Areas

- `src/modules/commands/handlers/queue.ts`
- `src/modules/pr-review-assist/service.ts`
- `src/modules/github/queue.ts`
- `src/runtime-home/app-db/schema.ts` (new `pr_reviews` table)
- `web/src/features/flue-chat/components/session-view.tsx`
- `web/src/plugins/GitHubPrList.tsx`
- `web/src/plugins/ReportsPanel.tsx`
- `web/src/features/pr-review/PrReviewPopoutPage.tsx`
- `web/vite.config.ts`
- new: `web/src/plugins/ReviewsPanel.tsx`

---

# Implementation Plan (settled UX)

> This section is the authoritative design and supersedes the earlier
> "Desired Experience" framing where they differ. Design decisions below were
> confirmed with the product owner.

## The experience

Reviewing other people's PRs is a **frequent, first-class task**. The design goal:
the review you start is the review you return to, with no clicking around to find it.

**Entry points — one action, three front doors.** `/review-pr` in chat is the
primary path; the Reviews panel's **+ Review a PR** button is the secondary path; the
API is the small remainder. All three call one `startPrReview(ref)` service, so
nothing reimplements the flow.

**Lifecycle the user sees:**

1. Start via chat (`/review-pr <url>`) or panel (**+ Review a PR** → paste URL /
   `owner/repo#101`). The review appears **immediately** in the Reviews panel as
   `In progress`, and chat-initiated reviews also render a live card in the
   conversation.
2. Chat card and panel row are **two views of one durable `pr_reviews` record**; they
   transition `reviewing → ready` in place, no refresh, no toast-racing.
3. When ready, both show a concise result — findings, seeded draft comments,
   report-only count — the trust line ("local drafts, nothing on GitHub until you
   submit"), and **Open review** (primary) plus linked **Overview** / **Issues**
   reports when present.
4. **Open review** launches the existing full-screen popout workbench for exactly
   that PR — already queue-independent, so it works for someone else's PR.
5. In the workbench: PR diff with Neon's draft comments anchored inline, a findings
   sidebar (incl. report-only findings that couldn't be anchored), per-comment
   edit/keep/dismiss, a verdict selector, and **Submit review to GitHub**.
6. **Submit is the whole review**: your verdict (approve / request changes / comment)
   plus the kept/edited draft comments, posted as one GitHub PR review. That single
   click is the only thing that leaves the machine. The record moves to `Submitted`.
7. The panel keeps a **Submitted** section as collapsible history, auto-aging out
   after ~7 days.

## Reviews panel (the canonical home)

A new dashboard plugin, `ReviewsPanel.tsx`, structured as an inbox:

```
Reviews                              + Review a PR
────────────────────────────────────────────────
AWAITING YOUR REVIEW        (from review-requested queue relation)
 • neondeck#101  @pandemicsyn   ✎ Neon draft ready (6)   [Review]
 • api#88        @dave          — no draft yet            [Review]
────────────────────────────────────────────────
IN PROGRESS
 • web#12        reviewing…
NEEDS ACTION (ready, unsubmitted)
 • core#40       6 findings · 4 drafts                        →
SUBMITTED (collapsible, ages out ~7d)
 • infra#7       approved · 2d ago
```

- **Awaiting your review** is powered by adding the `review-requested` relation to the
  GitHub queue (Issue #2). Each row notes whether Neon already prepared a draft, so
  you _pull_ work, not just push it. This is the discovery half of "first-class."
- **Re-review**: when a reviewed PR's head advances past the reviewed SHA, the row
  offers **Re-review**, updating the _same_ record rather than spawning a duplicate.

## Backbone: the `pr_reviews` record

A dedicated panel that shows `In progress` requires the review to exist the moment it
starts — before any completion summary. So a small durable record is created at
`startPrReview` time and is the single thing every surface reads:

- created at start → `status: reviewing`, `ref`, `repoFullName`, `prNumber`, nested
  `runId`, `headSha`, `origin: chat | panel | api`
- updated on workflow completion → `ready`, attach `reportIds`, `reviewUrl`, finding /
  seeded / report-only counts
- updated on workbench submit → `submitted`, verdict, GitHub review url
- `failed` on error

The chat card, panel row, workbench, and API are all views of this record, joined by
its id / `runId`. This replaces the earlier plumbing plan's reliance on the
completion-time workflow summary, which could not represent in-progress or submitted
state.

Add it to `src/runtime-home/app-db/schema.ts` via the existing migration workflow.
**Every status transition publishes a review event** (see Real-time transport).

## Real-time transport — a dedicated `/api/events/reviews` SSE stream

The card and panel follow a review over **Server-Sent Events, not polling.** Neondeck
already has this exact pattern for config, notifications, and chat sessions; add a
fourth instance and nothing new is invented:

- Server: `publishPrReviewEvent` / `subscribePrReviewEvents` /
  `formatPrReviewServerSentEvent` (mirror `src/modules/app-state/notification-events.ts`
  and `src/modules/sessions/events.ts`), plus `createReviewEventRoutes()` mounted at
  `/api/events/reviews` in `create-app.ts` next to the other three.
- Client: `openPrReviewEventStream(onEvent)` in `web/src/api/events.ts`, an
  `EventSource('/api/events/reviews')` listening for a `review-change` event carrying
  the updated `pr_reviews` record.
- `startPrReview` and each transition (`reviewing → ready → submitted / failed`) call
  `publishPrReviewEvent`. The Reviews panel subscribes and re-renders its sections; the
  chat card subscribes and filters to its `reviewId`. Both hydrate from a
  `GET /api/reviews` list on mount, then live-update over the stream.

There is no polling anywhere in this feature.

## Artifacts link from their source (general principle)

Reports (and briefings) are **linked from the entity that produced them**, never
surfaced as loose, disconnected rows:

- PR-review reports (`Overview` / `Issues`) render as **actions on the review row /
  card**, and stop appearing as standalone `ReportsPanel` rows.
- The same rule applies to the briefing: a report a briefing generates should be
  linked from the briefing, not orphaned in a generic list.
- The `ReportsPanel` retains only reports with no first-class home.

## Implementation steps

1. **`pr_reviews` table + `startPrReview(ref)` service.** New app-db table/migration
   and a service that resolves the ref, creates the record (`reviewing`), and admits
   the `review-pr-for-human` workflow, returning `{ reviewId, runId }`. This is the
   single entry point for all three front doors.
2. **Command handler → service** (`commands/handlers/queue.ts`). `reviewPrCommand`
   calls `startPrReview` and returns a **non-terminal** `reviewing` result carrying
   `reviewId` + `runId` (map onto the `running` command status, not `completed`).
3. **Review action updates the record** (`pr-review-assist/service.ts`). On
   completion, update `pr_reviews` by `runId` → `ready` with `reportIds`, `reviewUrl`,
   `trustBoundary`, counts. Write the `failed` transition on the error path. (Also
   pass `runId` into `addWorkflowSummary`, `service.ts:127`, which today omits it.)
4. **Review event stream** — add `publishPrReviewEvent` / `subscribePrReviewEvents` /
   `formatPrReviewServerSentEvent` and `createReviewEventRoutes()` at
   `/api/events/reviews`; add `openPrReviewEventStream` to `web/src/api/events.ts`.
   `startPrReview` and every transition publish. (Do this alongside step 1 so the
   record is observable from birth.)
5. **Reviews panel + list/add API** (`web/src/plugins/ReviewsPanel.tsx`, new routes).
   `GET /api/reviews` returns reviews grouped into Awaiting / In progress / Needs
   action / Submitted; **+ Review a PR** posts to `startPrReview`. Panel hydrates from
   the list on mount, then live-updates via `openPrReviewEventStream`.
6. **Chat card observes + persists** (`session-view.tsx`). Render the live card from
   the `pr_reviews` record, subscribing via `openPrReviewEventStream` filtered to its
   `reviewId`; expose Open review + linked reports + trust line; stays actionable after
   the notification is gone (fixes #1, #5).
7. **Workbench submit → GitHub review** (`PrReviewPopoutPage.tsx` / `GitHubPrReview`).
   Wire the verdict + kept comments into a single GitHub PR review submission; on
   success update the record to `submitted` (publishing the event). Trust line beside
   the submit control (fixes #6).
8. **GitHub queue relations** (`github/queue.ts`). Add `assignee:${login}` and
   `review-requested:${login}` queries and merge relations; this powers the
   Awaiting-your-review inbox and resolves the copy/scope mismatch (fixes #2).
9. **Dev `/reports` proxy** (`web/vite.config.ts:26`). Add `/reports` beside `/api` so
   report HTML loads in dev (fixes #3).
10. **Reports link from source** (`ReportsPanel.tsx`, reports metadata). Thread
    `repoFullName`/`prNumber` through review reports so they render as row/card actions;
    remove PR-review reports from the loose Reports list; apply the same linking to the
    briefing (fixes #4).

## Decisions locked (no open questions)

- **Transport:** SSE via a new `/api/events/reviews` stream. No polling.
- **Submit semantics:** one GitHub PR review = your verdict (approve / request-changes /
  comment) + the kept/edited draft comments. Nothing reaches GitHub before that click.
- **Re-review:** when the PR head advances past `pr_reviews.headSha`, **Re-review**
  resets the same record to `reviewing` and stamps `headSha`; the prior submitted
  verdict is retained in a `previousVerdict` audit field, not lost, and no duplicate row
  is created.
- **Report-only findings:** rendered in the workbench findings sidebar under a
  "Report-only — couldn't anchor to a line" group; they are review content, not errors.
- **Notification:** the `PR review ready` notification stays as a convenience ping that
  deep-links to the review row/card (useful when the dashboard is backgrounded). It is
  no longer load-bearing — the durable record + card + panel are the source of truth.
- **Panel placement:** `ReviewsPanel` ships as a default dashboard panel; users
  rearrange it through the existing dashboard-layout config like any other plugin.
- **Scope:** one PR. Build order below.

## Build order (one PR)

1. `pr_reviews` table + migration; `startPrReview(ref)` service; review event stream
   (steps 1 & 4 together — the record is observable from birth).
2. Command handler → `startPrReview`, non-terminal `reviewing` result (step 2).
3. Review action updates the record on completion/failure (step 3).
4. `GET /api/reviews` + `ReviewsPanel` + `+ Review a PR` (step 5).
5. Chat card renders + subscribes to the record (step 6).
6. Workbench submit → GitHub review (step 7).
7. Queue relations, dev proxy, report-from-source linking (steps 8–10).

## Verification

- `startPrReview` creates a `reviewing` record for chat, panel, and API callers and
  publishes a `review-change` event; the review action transitions it to `ready` (with
  reports/reviewUrl) and to `failed` on error, each publishing.
- Other-author PR: an explicitly reviewed non-authored PR appears in the Reviews panel
  and its **Open review** opens the popout with no GitHub queue entry.
- Submit posts a single GitHub PR review (verdict + kept comments) and moves the record
  to `submitted`; nothing reaches GitHub before that click.
- Re-review after a head advance resets the same record and preserves `previousVerdict`;
  no duplicate row.
- SSE: panel and chat card transition `reviewing → ready → submitted` live over
  `/api/events/reviews` with no refresh and no polling; both hydrate from
  `GET /api/reviews` on mount.
- Dev routing: `/reports/:id` returns backend HTML through the Vite dev server.
- Queue: assigned and review-requested PRs appear and feed the Awaiting section.
