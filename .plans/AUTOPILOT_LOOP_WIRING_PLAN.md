# Autopilot Loop Wiring Plan

Status: proposed
Related: `.plans/ROADMAP.md` Phases 19–20 (machinery, marked complete)

## Findings — what is wired today

The autopilot *engine* is complete; the *ignition* is missing.

**Wired:**

- **Policy/config**: modes `notify-only` (default), `draft-fix`,
  `auto-fix-no-push`, `auto-fix-push-after-checks`. Global default comes from
  app config `autopilot.defaultMode`; per-repo override lives in repo
  `metadata.autopilot` (`src/modules/autopilot-policy/config.ts`).
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

**Not wired (the gap):**

- Scheduler `watch-pr` jobs (`src/modules/scheduler/dispatch.ts:329`) only
  refresh watch status (green / attention / merged / closed) and emit
  notifications. They never touch event watermarks and never invoke triage.
- `refreshPrWatchEventState` (`src/modules/pr-events/service.ts:1109`) — the
  watermark/delta computation that triage was designed to consume — is only
  reachable via an API route (`src/server/routes/watches.ts:46`) and an agent
  tool. Nothing schedules it.
- `triage-pr-event` is only invoked by `POST /api/autopilot/triage-pr-event`
  or the agent tool. No code path connects watch deltas → triage → fix chain.

Net: autopilot only acts when the user (or Neon in chat) explicitly drives it.
Setting `draft-fix`/`auto-fix` modes in config currently changes what triage
*would* decide, but triage never fires on its own.

## Watch button semantics (current)

- `watch` in the PR side panel runs `/watch-pr repo#N` via a `command-run`
  workflow (`web/src/plugins/GitHubPrList.tsx:488`) → `watchPrAddAction` →
  adds a PR watch record.
- Scheduler `watch-pr` jobs poll (~300s) and emit status-change notifications.
- Watching a PR does **not** enable autopilot for it. Autopilot mode comes
  from repo/app config, and even then nothing auto-dispatches (see gap above).
- Minor bug: `WatchPrButton` derives its "watched" state only from its own
  mutation result, so an already-watched PR shows `watch` again after reload.
  It should read the `prWatches` query.

## Plan

### Phase 1 — Dispatch triage from watch deltas

- In `refreshWatchJob` (or a sibling `watch-pr-events` job type), after
  refreshing a watch: call `refreshPrWatchEventState` to compute watermark
  deltas.
- When deltas are non-empty and the repo's effective autopilot mode is not
  `notify-only`, dispatch the `triage-pr-event` workflow with the structured
  delta payload, admitted through the existing autopilot concurrency policy
  (global / per-repo / one-mutation-per-PR limits).
- `notify-only` repos keep exactly today's behavior.

### Phase 2 — Chain triage decisions per mode

- Triage classification → follow-up dispatch:
  - `draft-fix`: prepare worktree + fix workflow, stop at prepared diff +
    pending approval (surfaces in AutopilotPanel + `ready` notification).
  - `auto-fix-no-push`: continue through `verify-pr-worktree`, stop before push.
  - `auto-fix-push-after-checks`: use `verify-then-push-pr-autofix`
    (`src/workflows/verify-then-push-pr-autofix.ts`) via the same dispatch used
    by dashboard approvals (`src/server/autopilot-push-dispatch.ts`).
- Every hop already records notifications and learning events; no new
  surfacing machinery needed.

### Phase 3 — Per-PR surfacing in the PR list

- Show an autopilot state badge per PR row / side panel: `watching`,
  `triaged`, `fix prepared`, `approval pending`, `pushed`, `blocked` — sourced
  from the existing `autopilotState` query, deep-linking to AutopilotPanel.
- Fix `WatchPrButton` to reflect pre-existing watches (read `prWatches`).
- Optional: per-PR autopilot mode override on the watch record (roadmap
  already anticipates per-PR autopilot mode), so `watch` can offer
  "watch + draft-fix" without changing repo config.

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
