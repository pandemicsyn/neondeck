# Close the Decision Loops Plan (revise runs, approvals dispatch, approvers get answers)

Status: **active** — specification for making human decision surfaces dispatch the continuation
they imply, instead of recording an answer and going quiet. Written 2026-07-05 against main at
`77ab999`; grounded in `.plans/DIFF_REVIEW.md` and a code audit of every deck decision surface.

## Purpose

Three deck buttons ask the human a question and then merely file the answer:

1. **Revise** (worst): `requestPreparedDiffRevision` records `revision-requested`, rejects the
   push approval, and stores a `revisionReason` that **no code ever reads** — it is written in
   exactly one place (`src/modules/prepared-diffs/service.ts:451`) and consumed nowhere. Worse,
   neither dashboard entry point even captures a note: the AutopilotPanel `ApprovalRow` revise
   button sends the canned string `"Denied from dashboard Autopilot panel."`
   (`src/server/routes/autopilot.ts:122-129`), and `PreparedDiffRecoveryControls` calls
   `runAutopilotRecovery({ preparedDiffId, recoveryAction })` with no `reason` at all — the API
   field exists end-to-end and the deck never fills it. To act on feedback, the human must
   open a chat session and re-explain what they already decided.
2. **Approve push**: `approvePreparedDiffPush` returns, verbatim, _"Recorded prepared diff push
   approval. Actual push-back is handled by a later workflow."_ Nothing consumes `push-approved`
   automatically — no scheduler job, no poller. The push happens only if Neon acts on some
   future turn or the human clicks "retry push".
3. **Execution approvals**: `resolveExecutionApproval` flips the row to approved/denied. The
   contract is that the requesting agent retries with the `approvalId`
   (`src/modules/execution/run.ts:487`), but nothing tells the requester the answer arrived. If
   that session has ended or moved on, the approval sits unused, invisibly.

The design principle this plan enforces: **a human decision endpoint ends by dispatching the
continuation the decision implies.** Approve means "do it". Revise-with-note means "go do the
revision". The only decisions that should be record-only are the ones whose meaning _is_ "do
nothing" (deny/reject) — and those already work.

The counter-example already in the codebase proves the pattern: learning-candidate **approve**
actually applies (`decideMemoryCandidate(decision: 'apply')` /
`applySkillPatchCandidate`, `src/server/routes/learning.ts:291`). This plan brings the other
three loops up to that standard.

## Ground Rules (verified against main `77ab999`, 2026-07-05)

Machinery that already exists and must be reused, by name:

- **Kilo handoff is the agent-against-worktree primitive.** `kiloTaskStartAction`
  (`neondeck_kilo_task_start`, `src/modules/kilo/actions.ts:64`) starts a background agent task
  from a `prompt` in a declared repo **or a Neondeck-managed worktree** (`worktreeId`), with
  persisted task/event state, abort, status, and **diff endpoints the deck already renders**
  (`KiloTaskDiffReview` from the diff-viewer work). Companion workflows exist:
  `reconcile_kilo_task`, `verify_kilo_result`, `promote_kilo_result`.
- **Prepared-diff regeneration is one call.** `ensurePreparedDiffForWorktree(worktree, {
resetDecisionState: true })` (`src/modules/prepared-diffs/service.ts:45`) reuses the existing
  record, supersedes stale push approvals ("Prepared diff was regenerated; previous push
  decision is no longer current."), and returns the record to `prepared` — i.e. re-enters the
  exact review loop the DIFF_UI work built.
- **The push workflow is safe to chain.** `pushPrAutofix` (`src/modules/autopilot/push.ts:156`)
  re-checks everything itself: verification passed, autopilot policy, GitHub branch
  permissions, clean committed worktree, and takes a lock. Invoking it after approval cannot
  bypass a gate; at worst it returns `push-blocked`, which already has a recovery UX.
- **Workflows are invocable from server code and the dashboard.** The dashboard calls
  `flue.workflows.invoke('watch-pr', { input, wait })` (GitHubPrList); the scheduler invokes
  workflows from job executors via `invoke(module.default, { input })`
  (`src/modules/scheduler/dispatch.ts:89`).
- **Sessions can receive durable command events.** `createChatSessionCommandEvent`
  (`src/modules/sessions/service.ts:601`, route `POST /sessions/:id/command-events`, durability
  fixed in #69) is the mechanism for handing a session something to act on. Execution approval
  records already carry `sessionId` (`run.ts` `insertApproval` calls).
- **`fixPrReviewFeedback` is a deterministic applier, not an agent.** Its input requires an
  explicit `replacements`/`patch` plan (`src/modules/autopilot/schemas.ts:451`). Turning a
  free-text revision note into a change plan is agent reasoning — which is why the revision run
  must go through Kilo (or a chat session), not through this action directly.
- **Trust posture (unchanged):** verdicts and resolutions are user-owned; Neon's PR write is
  `neondeck_pr_comment` only; prepared-diff pushes require explicit human approval. Closing
  these loops adds **no new model-callable capability** — every dispatch below is triggered by
  a human click and lands its output back in human review.

## Non-Goals

- **No auto-push without a human approve.** Loop 2 dispatches the push only _after_ the
  explicit approval click, and the deterministic gates in `pushPrAutofix` stay authoritative.
- **No automatic revision retries.** A revision run starts from a human click, runs once, and
  returns to review. If the result is wrong, the human clicks revise again. No loops.
- **No new agent tools/actions.** `neondeck_kilo_task_start` is already registered; the new
  routes are user-surface-only with safety entries, mirroring the PR-review-actions posture.
- **Deny/reject paths stay record-only.** Denying an execution, rejecting a learning candidate,
  and abandoning a prepared diff mean "do nothing"; they already do exactly that.
- **No general task queue.** The autopilot "queue" stays a derived view; dispatch uses the
  existing workflow/Kilo/job machinery.

## Loop 1 — Run revision (the centerpiece)

### UX (`web/src/plugins/AutopilotPanel.tsx`)

- **Every revise path captures a note.** Clicking revise (ApprovalRow) or "Request revision"
  (recovery controls) opens an inline composer: textarea for the revision note, a
  **"run revision now" checkbox (default checked)**, and Confirm/Cancel. The note is required
  when "run now" is checked (an agent can't act on an empty instruction); optional otherwise.
  The canned `"Denied from dashboard Autopilot panel."` string is deleted.
- **A `run-revision` recovery action** appears on prepared diffs in `revision-requested` (so a
  recorded-but-not-run revision can be started later, including ones recorded from chat).
- **Run state is visible on the row.** While a revision run is active the PreparedDiffRow /
  ApprovalRow shows a `revision running` badge, the Kilo task status line, and a "view task
  diff" affordance reusing `KiloTaskDiffReview`. On completion the row flips back to the normal
  prepared-diff review state (new diff, approve/revise again).

### Backend (`src/modules/prepared-diffs/revision-run.ts` + autopilot route)

New service `runPreparedDiffRevision({ preparedDiffId, reason?, approverSurface? })`:

1. Load the prepared diff; require status `revision-requested` (record the revision first if
   the composer submitted note+run in one call — the route accepts both), require the retained
   worktree to exist (`readWorktreeRecord`), and take the worktree lock
   (`lockWorktree`, `lockOwner: 'revision-run'`) — the lock is the single-flight guard against
   double clicks.
2. Start a Kilo task via the existing `startKiloTask` with `worktreeId` and a structured
   prompt containing: the revision note **verbatim**, PR identity (`repoFullName#prNumber`,
   title), the prepared-diff summary and changed-file list, the latest verification
   status/failure text, and explicit bounds: _modify only this worktree, commit locally, never
   push, keep changes scoped to the revision note._
3. Record linkage and state: transition the prepared diff to a new status
   **`revision-in-progress`** and store `summary.revisionRun = { kiloTaskId, reason,
startedAt }`. (New status touch points, enumerated: `prepared-diffs/schemas.ts` status
   picklists, `assertTransition` matrices, `autopilot/state-mappers.ts` queue/next-step
   mapping, `autopilot/notifications.ts` recovery-action availability,
   `autonomous-audit/index.ts` status mapping. `abandon` must accept the new status so a stuck
   run can be killed.)
4. **Reconcile on completion.** Extend the existing Kilo reconcile path
   (`reconcile_kilo_task` / kilo notifications): when a completed task's `worktreeId` belongs
   to a prepared diff in `revision-in-progress`:
   - task succeeded with committed changes → `ensurePreparedDiffForWorktree(worktree, {
resetDecisionState: true, summary: { revisionRun: { ...linkage, outcome: 'completed' } }})`
     → status `prepared`, prior push decisions superseded, fresh approval row appears —
     **the loop re-enters review**; release the lock; `ready` notification
     ("Revision run finished — new diff awaiting review").
   - task failed / aborted / produced no commit → status back to `revision-requested`,
     `revisionRun.outcome = 'failed'` with the task's error, release the lock, `attention`
     notification. The note is retained; the human can rerun or abandon.
     No new poller: this rides the existing task-completion observation.
5. **Audit**: workflow-summary row `prepared_diff_revision_run` (preparedDiffId, kiloTaskId,
   reason, outcome), same mechanism as the PR-review submit audit.

Routes + safety: `POST /api/autopilot/prepared-diffs/:id/run-revision` (and the reason-carrying
revise composer reuses the existing request-revision route with `reason` finally populated).
Safety entries: safeMutation, `auditTarget: prepared_diffs/kilo_tasks`, **user-surface-only**
wording — no action/tool registration.

### Why Kilo and not a chat handoff

A chat session (SessionReferenceButton + command events) keeps a human in the loop of the
_execution_, which defeats the point — the human already gave their instruction in the note.
Kilo is the existing bounded background executor with task state, abort, and deck-rendered
diffs; its result cannot leave the worktree without passing back through prepared-diff review.
A chat session remains the escape hatch for revisions too ambiguous for a one-shot run — that
path exists today and is unchanged.

## Loop 2 — Approve push dispatches the push

- After `approvePreparedDiffPush` succeeds (both callers: the ApprovalRow resolve route branch
  at `src/server/routes/autopilot.ts:111` and the direct prepared-diff approve route), the
  server invokes the `push-pr-autofix` workflow with the `preparedDiffId` — fire-and-record
  (do not block the HTTP response on the push): capture `{ runId }` into the approve response
  (`data.dispatchedPushRunId`) and a workflow-summary row.
- **Gate behavior unchanged and load-bearing**: `pushPrAutofix` re-validates verification,
  policy, branch permissions, and worktree cleanliness. Two outcomes need surfacing:
  - verification not yet passed → the dispatch reports `push-blocked`/not-ready; the approval
    row shows _"approved — push waiting on verification"_ with the existing `retry-verify`
    recovery button. Optional (recommended) config knob
    `autopilot.pushOnApproval: 'push' | 'verify-then-push' | 'off'`, default
    `'verify-then-push'`: when verification is pending, dispatch `verify-pr-worktree` first and
    chain the push through the existing verify→push recovery semantics.
  - push blocked by policy/permissions → existing push-blocked notification + recovery UX; the
    approve response message names the block instead of the current silence.
- UI: ApprovalRow approve invalidates autopilot state (already does) and renders the dispatch
  outcome message; the queue rows already reflect `pushed`/`push-blocked`.
- Audit: the existing push workflow summaries cover it; add the approval→dispatch linkage
  (`approvalId`) to the workflow summary input.

## Loop 3 — Execution and MCP approvals answer the requester

Full-dashboard audit (2026-07-05, every plugin in `web/src/plugins/` + `web/src/features/` and
every mutation route in `src/server/routes/`) found one more member of this family: **MCP tool
approvals** (`resolveMcpApprovalWithPaths`, `src/domains/mcp/store.ts:493`, resolved from the
RuntimeOverview panel) follow the same record-and-wait contract. They are _better_ instrumented
than execution approvals — the schema already has `status: 'used'` + `used_at`
(`store.ts:325`) set on consumption — but nothing notifies the requester on resolve. Every
other decision surface checked is closed: learning candidate approve applies; skill patch
apply/reject/restore operate; Kilo start/abort/review/verify/promote operate; learning
review-chat/pr-batch buttons `invoke()` their workflows; watch/memory/worktree/repo-edit/config
buttons are direct operations; notification read/resolve is record-only _by design_ (the
notification is the record).

- On **approve** in `resolveExecutionApproval`, when the approval record has a `sessionId`:
  post a session command event (`createChatSessionCommandEvent`) — _"Execution approval `<id>`
  approved for `<command>`; retry with approvalId"_ — so an active session consumes the answer
  on its next turn, plus an `addNotification` (`ready`) for the deck. Deny posts the denial
  event too (the requester should stop waiting), but dispatches nothing.
- **Make unconsumed approvals visible.** Add `consumed_at` to `execution_approvals` (Drizzle
  `db:generate` migration); set it in `run.ts` when an authorization succeeds against the
  approval (`readApproval` hit at `run.ts:487` → the `{ ok: true, approval }` return). The
  deck's approvals surface shows _"approved 20m ago — not yet used"_ for approved rows with
  `consumed_at IS NULL`, which is the tell for "the requester is gone; this decision went
  nowhere."
- No auto-rerun of the command: the requesting agent owns the retry (that contract is sound);
  the fix is that the requester now _learns_ the answer, and the human can _see_ when nobody
  did.
- **MCP approvals get the same nudge**: on resolve with a requesting-session linkage, post the
  session command event + notification. Consumption tracking already exists (`used`/`used_at`);
  mirror the execution-approvals "approved — not yet used" row treatment in RuntimeOverview so
  both approval families read identically. Align execution approvals' new `consumed_at` naming
  with MCP's existing `used_at` (pick one term; `used_at` is already shipped, prefer it).

## Delivery: three PRs, independently shippable, in priority order

1. **PR 1 — Run revision.** Reason composer (both entry points) + `runPreparedDiffRevision`
   service/route/safety + `revision-in-progress` status (all touch points enumerated above) +
   Kilo reconcile hook + row run-state UI + audit row. Tests: transition matrix (including
   abandon-during-run and double-click lock contention), prompt content includes note/context
   verbatim, reconcile success → `prepared` with superseded approvals, reconcile failure →
   `revision-requested` + lock released, route validation, safety-table entries.
2. **PR 2 — Approve dispatches push.** Workflow invocation from both approve paths + config
   knob + response/row messaging + approval→push audit linkage. Tests: approve invokes the
   workflow (injected invoker), blocked outcomes surface in the response, `off` knob restores
   record-only, HTTP response does not await the push.
3. **PR 3 — Execution + MCP approval nudge.** Session command event + notification on resolve
   for both approval families + `used_at` migration and set-on-use for execution approvals
   (MCP already has it) + deck "not yet used" surfacing for both. Tests: event posted to the
   right session (and skipped when `sessionId` is null), used_at set exactly on authorization
   success, unused-approval query, MCP resolve nudge parity.

Verification per PR: `npm run check`; targeted vitest suites; manual deck pass recorded in the
PR description — for PR 1 the full loop on a real test PR: prepare → inspect → revise with note
→ watch the run → review the regenerated diff → approve → (with PR 2) watch the push land.

## Risks

- **Kilo output quality.** A one-shot background run may misread a terse note. Mitigations:
  the prompt carries the diff summary, changed files, and verification failures; the output is
  still human-reviewed before any push; the chat path remains for ambiguous revisions. Accept
  that some runs will need a second note — that is still strictly better than re-explaining in
  chat from scratch.
- **Double dispatch.** Worktree lock single-flights revision runs; `pushPrAutofix`'s own lock
  and idempotent gates cover approve double-clicks; `resolveExecutionApproval` already rejects
  non-pending rows.
- **Status-machine churn.** `revision-in-progress` touches five files (enumerated in Loop 1);
  the transition tests in PR 1 are the guard. Do not ship the status without the abandon
  escape hatch.
- **Workflow invocation from route handlers** must stay fire-and-record — a hung agent run
  must never hold an HTTP response or a UI spinner. Row state comes from polled task/workflow
  state, matching how Kilo rows behave today.
- **Notification fatigue.** One notification per terminal outcome (run finished / run failed /
  push blocked / approval unused is a passive row state, not a notification).

## Definition of Done

- Clicking revise captures a typed note and, by default, immediately starts a revision run
  against the retained worktree; when it completes, a regenerated prepared diff (prior push
  decisions superseded) is waiting in the same review surface — no chat session, no manual
  correlation, no leaving the deck.
- A recorded-but-not-run revision can be started later from the row; a running revision can be
  aborted/abandoned; a failed run says why and keeps the note.
- Approving a prepared diff results in the push happening — or a visible, named blocked state
  with recovery actions — with no further human action.
- Approving a blocked execution notifies the requesting session, and approvals nobody consumed
  are visibly flagged on the deck.
- Neon gains no new model-callable capability; every new route has a user-surface-only safety
  entry; revision runs and approval-dispatched pushes appear in audit history.
- `npm run verify` passes; the transition, dispatch, and consumption tests run in CI.
