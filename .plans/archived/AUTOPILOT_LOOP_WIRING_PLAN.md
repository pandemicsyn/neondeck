# Autopilot Loop Wiring Plan

Status: superseded and archived by `.plans/AUTOPILOT_IMPLEMENTATION_PLAN.md`

Historical note: this document intentionally stopped the coordinator at worktree
preparation. Keep it as implementation history; do not use it as the current
product-closure plan.

Related: `.plans/ROADMAP.md` Phases 19–20

## Findings — what is wired today

Watch-delta-to-triage ignition and durable worktree-preparation admission are implemented.

**Wired:**

- **Policy/config**: modes `notify-only` (default), `prepare-only`,
  `autofix-with-approval`, `autofix-push-when-safe`. Global default comes from
  app config `autopilot.defaultMode`; repo policy changes use the typed,
  confirmation-aware autopilot-policy action.
- **Workflows**: `triage-pr-event` → `prepare-pr-worktree` →
  `fix-pr-review-feedback` / `fix-pr-ci-failure` → `verify-pr-worktree` →
  `push-pr-autofix` / `comment-pr-autofix-result`, plus prepared diffs,
  approvals, revisions, and recovery — all invocable via
  `/api/autopilot/*` and `/api/prepared-diffs/*`
  (`src/server/routes/autopilot.ts`).
- **Surfacing**:
  - Dashboard **AutopilotPanel** (in `config/dashboard.json`) shows Queue,
    Prepared, Approvals, Checks, Recent, Adapters; approvals are resolved there
    (`POST /autopilot/approvals/:id/resolve`).
  - **Notifications**: `notifyAutopilotState`
    (`src/modules/autopilot/notifications.ts:204`) writes to the notifications
    store (`ready` when a fix is prepared/pushed, `attention` when blocked) and
    surfaces on the dashboard notification feed.
  - **PR comments**: `comment-pr-autofix-result` posts results back to GitHub.
  - **Learning**: handled-PR events feed the learning operator
    (`recordHandledPrApiResult`).
- **Chat**: Neon (display-assistant) has the full tool set and guidance
  (`src/agents/display-assistant.ts:72`), so chat-driven autopilot works today.

**Wired since the scheduler PR-event dispatch extraction:**

- Scheduler `watch-pr` tasks refresh event watermarks, compute meaningful
  deltas, resolve effective policy server-side, and atomically claim a durable
  autopilot admission before invoking `triage-pr-event`.
- Terminal triage observations advance durable admissions to bounded
  `prepare-pr-worktree` workflows when the result requests preparation.
- Failed, limited, and stale handoffs reconcile through the SQLite admission
  state machine. Completed preparation with missing durable facts is held for
  manual review rather than replayed.

**Deliberate boundary:**

- The coordinator advances watcher triage to durable worktree preparation.
- Subsequent fix, verification, push, and comment workflows remain bounded,
  explicit operations. Push additionally requires a matching prepared-diff
  approval bound to the exact commit SHA and current policy hash.

## Watch button semantics (current)

- `watch` in the PR side panel runs `/watch-pr repo#N` via a `command-run`
  workflow (`web/src/plugins/GitHubPrList.tsx:488`) → `watchPrAddAction` →
  adds a PR watch record.
- Scheduler `watch-pr` jobs poll (~300s) and emit status-change notifications.
- Watching a PR does **not** enable autopilot by itself. When the effective
  repo/watch mode permits it, meaningful watch deltas automatically admit
  durable triage and may continue to worktree preparation.
- Minor bug: `WatchPrButton` derives its "watched" state only from its own
  mutation result, so an already-watched PR shows `watch` again after reload.
  It should read the `prWatches` query.

## Plan

### Phase 1 — Dispatch triage from watch deltas (complete)

- In `refreshWatchJob` (or a sibling `watch-pr-events` job type), after
  refreshing a watch: call `refreshPrWatchEventState` to compute watermark
  deltas.
- When deltas are non-empty and the repo's effective autopilot mode is not
  `notify-only`, dispatch the `triage-pr-event` workflow with the structured
  delta payload, admitted through the existing autopilot concurrency policy
  (global / per-repo / one-mutation-per-PR limits).
- `notify-only` repos keep exactly today's behavior.

### Phase 2 — Durable triage-to-prepare coordinator (complete)

- Triage results that request preparation atomically reserve the next admission
  slot and invoke one `prepare-pr-worktree` workflow.
- Admissions are idempotent by watch/event fingerprint, enforce global,
  per-repo, and same-PR capacity, and expose state/run/worktree linkage to the
  operator queue.
- Later mutation stages remain explicit rather than promising an unbounded
  autonomous fix/push chain.

### Phase 3 — Per-PR surfacing in the PR list

- Show an autopilot state badge per PR row / side panel: `watching`,
  `triaged`, `fix prepared`, `approval pending`, `pushed`, `blocked` — sourced
  from the existing `autopilotState` query, deep-linking to AutopilotPanel.
- Fix `WatchPrButton` to reflect pre-existing watches (read `prWatches`).
- Optional: per-PR autopilot mode override on the watch record (roadmap
  already anticipates per-PR autopilot mode), so `watch` can offer
  "watch + prepare-only" without changing repo config.

### Phase 4 — Notification affordances

- Prepared-diff notifications should deep-link to the approval action
  (approve / request revision) rather than just naming the diff.

### Phase 5 — Tests

- Scheduler dispatch tests with fixture deltas asserting: triage invoked only
  for non-`notify-only` repos, concurrency limits respected, `notify-only`
  yields notification-only behavior.
- Smoke test: watch delta → triage → prepared diff → notification, using the
  existing fixture-backed autopilot smoke harness.

## Open questions

- Cadence: reuse the watch-pr job interval (~300s) for delta refresh, or a
  separate slower cadence to limit GitHub API spend?
- Should the `watch` button default to the repo's configured mode, or always
  start `notify-only` until the user opts the PR in? (Recommend: repo mode,
  since config is the stated source of truth.)
