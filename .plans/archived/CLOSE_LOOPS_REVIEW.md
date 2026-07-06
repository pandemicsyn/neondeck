# Static Review: Close the Decision Loops Implementation

Status: **resolved (minor findings)** — quick static review (no tests executed) of the
CLOSE_DECISION_LOOPS_PLAN implementation, commits `20eb7df..9b5fba8` on main (15 commits,
~10k lines), reviewed 2026-07-05.

## Verdict

Faithful to the plan, and in several places **harder than the spec asked**:

- **Loop 1 (revision runs)**: `runPreparedDiffRevision` + `revision-in-progress` status +
  `reconcilePreparedDiffRevisionResult`. Reconcile fires on every completion path — process
  exit, process error, the startup sweep of orphaned running tasks
  (`reconcilePersistedRunningTasks`), and manual reconcile — so crashed runs cannot strand a
  diff. The start path handles the TOCTOU between transition-check and Kilo-start with a
  compensating abort + audit row; duplicate starts are resolved by Kilo's own worktree lock
  (explicitly tested: "does not clobber an admitted revision run when a duplicate start loses
  the Kilo lock"). Both revise entry points now require a note when running, and the canned
  "Denied from dashboard" string is gone. Abandon of an in-progress run aborts the Kilo task
  first and refuses while a task needs reconciliation.
- **Loop 2 (push dispatch)**: `approvePreparedDiffPushWithDispatch` wraps both approve
  callers; `autopilot.pushOnApproval` knob (`push | verify-then-push | off`, default
  `verify-then-push`) implemented exactly as spec'd; new `verify-then-push-pr-autofix`
  workflow validates the prepared-diff/worktree pairing (hardened in `9b5fba8`); dispatch
  failure degrades the response, writes an audit row, and raises an attention notification.
- **Loop 3 (approval nudges)**: goes beyond the spec — approved resolutions don't just record
  a durable session command event, they **dispatch a live agent turn** with the answer
  (`dispatch({ agent, id, input })`), falling back to the recorded event + an attention
  notification when Flue refuses delivery. Denied resolutions are record-only with a "do not
  retry" event, per spec (`da508fa`). Requester session ids are captured automatically at
  approval-creation time via an AsyncLocalStorage Flue execution context
  (`src/modules/flue/execution-context.ts`) for **both** families, with MCP legacy session-id
  normalization/repair (`140f08f`, `d59e4e4`, `85e5ed6`). Execution approvals gained `used_at`
  with **atomic single-use claim semantics** for allow-once (`markApprovalUsed` with
  `WHERE used_at IS NULL` — a second use is rejected with a typed message); both families
  surface "approved … · not yet used" in RuntimeOverview.
- **Trust boundary held**: the model-callable `autopilotRecoveryRunAction` cannot dispatch
  revision runs — `allowRevisionDispatch` is only set by the HTTP route, and an agent-side
  `runRevisionNow` request gets a typed user-surface-only refusal. Safety entry exists for
  `/api/prepared-diffs/:id/run-revision`.
- Test coverage is real: 500+ lines in `prepared-diffs.test.ts` covering the transition
  matrix, duplicate-start, re-entry after success, failure restoration, restart-recovered
  completion (real git fixture repo), abandon-during-run, and needs-reconcile blocking.

## Findings (minor, non-blocking)

1. **[bug, minor] Missing-worktree revision start returns a raw 500.**
   `runPreparedDiffRevision` calls `readWorktreeRecord(loaded.worktreeId, paths)`
   (`src/modules/autopilot/revision-run.ts:67`) purely for validation and discards the
   result — but it is `requireWorktree`, which **throws** `WorktreeError` when the record is
   gone (`worktrees/store.ts:265`), and neither the function nor the route catches it (no
   global Hono `onError`). A prepared diff sitting in `revision-requested` whose worktree was
   cleaned up → "run revision" → unhandled 500 instead of the typed failure every other exit
   path returns. Catch `WorktreeError` and return a `WORKTREE_NOT_FOUND` failure. (The
   record-exists-but-directory-deleted case is fine — Kilo start fails into the handled path.)
2. **[smell] Global env mutation in the request path.**
   `dispatchApprovedPreparedDiffPush` sets `process.env.NEONDECK_HOME = paths.home`
   (`src/server/autopilot-push-dispatch.ts:68`) so dynamically imported workflow modules
   resolve the right runtime home. Benign in production (one home per process) but it's a
   process-wide side effect on every approval; a comment explaining why it is required — or
   threading the home through workflow input — would prevent someone "cleaning it up" into a
   subtle break, or copying the pattern somewhere it races.
3. **[nit] Failed-dispatch retry affordance.** When the approval nudge's Flue dispatch is
   refused, the notification says "use the approval row to retry manually" — but resolved
   approvals are no longer pending, and the row offers no re-nudge button. The durable command
   event still delivers on the session's next turn, so nothing is lost; the message just
   overpromises slightly.
4. **[note] Plan deviation, accepted.** The plan specified explicit
   `lockWorktree(lockOwner: 'revision-run')` single-flight; the implementation relies on
   Kilo's task lock instead — equivalent guarantee, simpler, and covered by the
   duplicate-start test. No action needed; recorded so the plan text doesn't read as unmet.

## Suggested follow-up

Fix finding 1 (one try/catch); add a one-line comment for finding 2; soften the message in
finding 3. None block anything.
