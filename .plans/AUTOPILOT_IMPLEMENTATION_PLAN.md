# Autopilot Product-Closure Implementation Plan

Status: proposed; implementation not started

Companion audit: `.plans/AUTOPILOT_END_TO_END_REVIEW.html`

Roadmap scope: Phases 19–21

Supersedes:

- `.plans/archived/AUTOPILOT_LOOP_WIRING_PLAN.md`
- `.plans/archived/SCHEDULER_ROUTINES_AUTOPILOT_MECHANICS_REVIEW_20260709.md`

Retains as supporting architecture:

- `.plans/KILOCODE_HANDOFF_RESEARCH.md`
- `.plans/REPO_EDITING_PLAN.md`
- `.plans/archived/TASK_AUTHORITY_REFACTOR_PLAN.md`
- `.plans/archived/CLOSE_DECISION_LOOPS_PLAN.md`
- `.plans/archived/BUSYWORK_AUTOMATION_PLAN.md`

## Outcome

Autopilot is complete only when this user journey works without a hidden API call
or manual workflow handoff:

1. A user says, “Put `owner/repo#123` on autopilot in prepare-only mode,” or
   configures the same intent from the dashboard or CLI.
2. Neondeck creates or updates the watch and its explicit per-PR mode, reports
   readiness, and asks whether current feedback should be processed.
3. A meaningful PR event creates one durable admission. Existing feedback is
   processed when requested; the first poll does not silently discard it.
4. On the first actionable event, Neondeck creates one PR-owner Neon session and
   one isolated managed worktree at the exact PR head SHA. Both are durably bound
   to the watch and the primary checkout is never edited.
5. Neondeck dispatches a bounded event turn to that same session with a factual,
   authoritative environment envelope. Later feedback, CI changes, and PR state
   changes are dispatched to the same session and workspace rather than creating
   another agent.
6. The coordinator creates a prepared diff, applies mode and guardrail policy,
   runs configured checks, obtains approval when required, pushes only when safe,
   reports the result on the PR, and cleans up according to policy.
7. The dashboard, CLI, chat, notifications, and future TUI all read and mutate the
   same durable admission. Pause, stop, retry, approve, revise, and abandon have
   accurate effects.

The release gate is the product path, not the existence of individually callable
actions. The full chain must pass through the same APIs and observers used in
production:

```text
explicit setup
  → watch watermark / initial event
  → admission
  → triage
  → create/reuse PR-owner session and exact-SHA worktree
  → bounded event turn in that same session
  → prepared diff
  → policy and verification
  → approval or safe push
  → PR result delivery
  → wait for the next event in the same session
  → on terminal PR state: archive session / cleanup workspace
```

## Current Baseline

Keep these working foundations:

- deterministic PR event watermarks and semantic deltas;
- SQLite admission idempotency and concurrency claims;
- managed worktree isolation, locks, dirty-worktree checks, and cleanup policy;
- repo-edit stale-read protection and patch validation;
- prepared diffs, SHA/policy-bound push approvals, verification facts, and
  guarded push services;
- bounded Kilo tasks and completion reconciliation for explicit `/fix-ci` and
  requested-revision flows;
- typed Hono/API/action surfaces shared by the dashboard and future TUI;
- workflow observations, summaries, notifications, and learning hooks.

The missing production chain is currently:

```text
watch delta → triage → prepare worktree → STOP
```

The deterministic review and CI fix actions accept caller-supplied replacements
or patches. No watcher continuation currently starts a coding model, supplies the
patch, verifies its result, or advances the admission to delivery.

## Product And Architecture Decisions

### One durable coordinator owns progression

Add one `advanceAutopilotAdmission(admissionId)` service. It is the only component
allowed to select and reserve the next stage. Scheduler code, workflow observation
handlers, owner-session reconciliation, approval routes, and recovery actions may request
advancement, but must not directly invoke the next workflow.

Deterministic stages are bounded Flue workflows with run ids and typed terminal
results. Agent work is a bounded, correlated dispatch into the watch's continuing
PR-owner Flue session. Every state transition is committed in Neondeck SQLite
before an external effect is started. A compare-and-swap state/version update
prevents duplicate observers from dispatching the same next stage or agent turn.

Remove the two current triage-to-prepare continuation paths from
`src/modules/scheduler/pr-watch-events.ts` and `src/server/learning-hooks.ts` after
the coordinator owns that transition.

### One continuing Neon session owns each Autopilot PR

Create a private `pr-autopilot-owner` Flue agent definition with a narrow
capability set. Each configured Autopilot watch gets one addressable session id for
that agent. The durable PR controller/state machine owns policy and progression;
the continuing session owns reasoning continuity about the PR.

The owner row may be created during setup, but its Flue session and managed
worktree are created lazily on the first actionable event. The initial dispatch
contains the full PR, mode, environment, workspace, capability, and event brief.
Every later actionable event is dispatched with the same agent and session id:

```ts
dispatch({
  agent: 'pr-autopilot-owner',
  id: owner.flueSessionId,
  input: authoritativeEventEnvelope,
});
```

This is the same continuing-session pattern already used by scheduled instruction
dispatch and recurring briefing sessions. An event turn is bounded and audited;
the PR-owner session is not recreated at the end of the turn.

Implementation should reuse the established dispatch/session seams in
`src/modules/scheduled-tasks/dispatch.ts`, `src/modules/briefings/service.ts`, and
`src/modules/sessions/service.ts` rather than inventing a second agent runtime or a
new ephemeral `harness.session()` for every admission.

The agent initially reuses the configured display-assistant model selection, but
has separate stable instructions and no config/watch/push/comment actions, no MCP
tools, and no generic raw shell. It retains its own Flue conversation history so a
later review comment can build on the earlier diagnosis and fix. Dynamic mode,
head, feedback, checks, workspace, and authority facts are never frozen into the
system prompt: each new event envelope is authoritative over older transcript
facts.

Kilo remains an explicit or repo-policy-opted delegated worker. The automatic
watched-PR path must not silently choose Kilo. When Kilo is selected, the same
PR-owner Neon session supervises the handoff, and Kilo completion re-enters the
same owner/admission coordinator before the result is sent back to that session.

### Same-PR turns are serialized and coalesced

Only one reasoning/mutation turn may be active for a PR owner. Events that arrive
while it is busy are durably queued. On settlement, the controller recomputes the
current PR delta, supersedes facts already addressed by the completed turn, and
dispatches one coalesced follow-up envelope to the same session. Two separate PRs
may progress concurrently within the configured global and per-repo limits.

Ordinary feedback, CI, commit, and mergeability changes never rotate the session.
Session rotation is an explicit recovery path only: corrupted/unavailable session,
operator request, or a proven context-limit failure. Rotation archives the old
session, increments `generation`, creates a replacement, and seeds it with an
audited compact handoff plus current authoritative facts. It is visible in the
operator history and must not happen silently.

### The model proposes; deterministic services enforce

The Neon PR owner may read/search files, inspect a diff, and run only configured
unattended diagnostics. It submits exactly one scoped edit plan through a new
workflow-only action such as `neondeck_autopilot_submit_fix`.

That action must:

- bind the submission to the active admission, stage attempt, worktree, head SHA,
  source-event fingerprint, and one-time token;
- reject primary-checkout paths or a stale/superseded worktree;
- accept bounded V4A patches or explicit replacements only;
- route review and CI edits through the existing deterministic fixer/repo-edit
  services;
- independently compute the resulting diff and policy classification;
- create or update the prepared diff;
- commit only when the selected mode calls for a local commit;
- record addressed review/check ids and the patch hash without persisting secrets
  or an unbounded prompt transcript.

A PR-owner turn without a valid submission is a failed/no-op stage. The
coordinator never infers success from prose.

### Watching and autonomy are separate, explicit intents

Plain “watch this PR” remains notify-only. Enabling Autopilot requires an explicit
mode. A composite setup action makes the common request easy without making watch
creation itself an authority escalation.

Add a shared service/action/route contract:

```ts
type ConfigurePrAutopilotInput = {
  ref: string;
  mode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  processExisting: boolean;
  paused?: boolean;
  confirm?: boolean;
};
```

Recommended name: `neondeck_autopilot_watch_pr_configure`.

Increasing autonomy or relaxing guardrails requires confirmation. Reducing
authority, pausing, or stopping does not. The service patches one watch override by
stable id instead of replacing the entire overrides array.

### Mode behavior is observable and testable

| Mode | Owner turn | Local commit | Verify | Approval | Push | Comment |
| --- | --- | --- | --- | --- | --- | --- |
| `notify-only` | no | no | no | no | no | notification only |
| `prepare-only` | yes | no | optional policy diagnostics | no push approval | never | prepared-diff notification |
| `autofix-with-approval` | yes | yes | required | exact SHA/policy approval | after approval | after push or terminal block |
| `autofix-push-when-safe` | yes | yes | required | none unless policy downgrades to approval | automatic when all gates pass | after push or terminal block |

No mode may collapse to “empty checkout prepared.” In `prepare-only`, prepared
means a reviewable proposed change exists.

### Rollout remains conservative until the product-path gate passes

Until the final integration gate passes, fresh runtime homes remain effectively
notify-only and product copy must describe the current limitation. At final
rollout:

- onboarding recommends `prepare-only` as the repo policy;
- a plain watch still receives an explicit notify-only watch override;
- an explicit Autopilot request uses the selected mode or the repo’s suggested
  prepare-only mode;
- existing runtime homes are not silently upgraded to more authority.

## Durable Data Model

### Add `autopilot_pr_owners`

This is the long-lived ownership record. There is one current row per Autopilot
watch, while admissions remain the event-by-event audit and delivery units.

```text
id
watch_id                     unique
repo_id
pr_number
flue_agent                   pr-autopilot-owner
flue_session_id              nullable until first actionable event; unique
chat_session_id              nullable link to app-owned session metadata
worktree_id                  nullable until first actionable event
generation                   starts at 1; increments only on explicit rotation
status                       awaiting-event | active | draining | archived | failed
current_head_sha
last_dispatched_sequence
last_settled_sequence
last_event_at
created_at
updated_at
archived_at
```

Setup creates the owner row in `awaiting-event`. The first actionable event creates
and persists the Flue/chat session and managed worktree transactionally around
idempotent creation. Restart recovery reads this mapping and reuses it; it never
guesses ownership from a title or starts a replacement session merely because the
process restarted.

### Extend `autopilot_admissions`

Retain the existing unique `(watch_id, event_fingerprint)` identity and add:

```text
owner_id
event_sequence
prepared_diff_id
fixer_kind                  neon-owner | kilo | null
version                     integer, incremented by every transition
stop_requested_at
completed_at
archived_at
last_outcome_json
```

Use this canonical state vocabulary:

```text
triage-admitted
triaged
prepare-admitted
prepared
owner-turn-admitted
owner-turn-running
fix-prepared
verify-admitted
verified
approval-pending
push-admitted
pushed
comment-admitted
completed
cleanup-pending
archived
blocked
manual-review
failed
stopped
superseded
```

`prepared` means the exact-SHA owner worktree and event envelope are ready.
`fix-prepared` means a prepared-diff artifact exists.

### Add `autopilot_stage_attempts`

```text
id
admission_id
stage
attempt_number
workflow
run_id
flue_session_id              populated for agent turns
owner_generation             populated for agent turns
event_sequence               populated for agent turns
dispatch_id                  populated when returned by Flue
status                       reserved | running | completed | blocked | failed | cancelled
input_fingerprint
artifact_json                bounded ids, SHAs, summaries, and policy facts
error
started_at
finished_at

UNIQUE(admission_id, stage, attempt_number)
UNIQUE(run_id)
UNIQUE(dispatch_id)
```

This table is the durable bridge between Flue observations and admission state. It
also prevents a late terminal observation from an older attempt from advancing a
newer retry.

The session id is expected to repeat across ordinary admissions; the attempt id
and event sequence are what distinguish bounded turns. `artifact_json` stores only
bounded result ids, SHAs, summaries, and policy facts.

### Add `autopilot_admission_events`

Append one bounded audit row for every transition and operator decision:

```text
id
admission_id
from_state
to_state
reason
workflow
run_id
data_json
created_at
```

Do not store raw GitHub tokens, git credentials, full model transcripts, or full CI
logs in these tables. Store ids, hashes, truncation metadata, and links to the
existing guarded facts/run surfaces.

Generate the migration with:

```sh
npm run db:generate -- --name autopilot_product_closure
npm run db:check
```

## Coordinator Contract

Create focused modules under `src/modules/autopilot/coordination/`:

```text
advance.ts             choose and reserve the next transition
dispatch.ts            map one reserved stage to one Flue workflow
settle.ts              validate a terminal result and record artifacts
reconcile.ts           repair stale/missing observations and expired attempts
retry.ts               classify retryable versus permanent blocks
stop.ts                stop/supersede semantics and cleanup handoff
transitions.ts         exhaustive state/mode transition table
schemas.ts             stage inputs, outputs, and durable artifact schemas
```

Required invariants:

- Exactly one active mutating stage or agent turn per PR owner.
- Every admission belongs to the watch's current owner and receives a monotonic
  event sequence.
- Ordinary new feedback reuses the recorded Flue session and managed worktree;
  only the explicit rotation path may change the session id/generation.
- A workflow cannot advance an admission unless its run id matches the active
  stage attempt.
- Admission mode is snapshotted at creation. A later authority increase applies
  only after an explicit operator decision; a decrease or stop applies
  immediately.
- New PR commits supersede an unpushed stale attempt and create/reconcile a new
  admission in the same owner session rather than patching against the wrong SHA.
- Events received during an active turn remain queued and are coalesced against
  fresh PR facts before the next dispatch to that same session.
- A stage may be retried only when its recorded artifact proves the previous
  external effect did not complete, or when that effect is idempotent.
- Push and comment delivery have idempotency keys based on admission, commit SHA,
  and operation.
- Terminal admissions do not count toward concurrency and move to history rather
  than remaining in the active queue.

Retry policy:

- transient GitHub/network/runner errors: bounded exponential backoff at roughly
  30 seconds, 2 minutes, 10 minutes, and 30 minutes;
- maximum five automatic attempts per stage;
- policy, credentials, missing feedback, and unapproved execution are permanent
  blocks until facts/config/operator input changes;
- an attached run that has no terminal observation by the configured stage timeout
  becomes failed/manual-review and releases capacity;
- no retry sets `next_attempt_at` to “now” in an endless polling loop.

The scheduler tick calls reconciliation and advancement for due admissions. It does
not contain stage-specific business logic.

## PR-Owner Event Envelope Contract

Build every envelope deterministically in
`src/modules/autopilot/owner/envelope.ts`. The first envelope is a complete
bootstrap brief; later envelopes contain new facts plus enough current state to
invalidate anything stale in the transcript. Every envelope begins with owner,
watch, admission, attempt, session generation, event sequence, policy version, and
current-head identifiers, and explicitly says that it is authoritative over older
mutable facts. It must include:

### Workspace

- absolute managed worktree path and `worktreeId`;
- explicit statement that code is already checked out on disk at the exact PR head
  SHA;
- explicit statement that the primary checkout must not be edited;
- repo id/full name and local source repo path;
- current branch/detached state, base ref/SHA, head owner/repo/ref/SHA;
- fork status, maintainer-modify permission, and intended push destination.
- whether this is the initial assignment or a continuation, and any worktree path
  replacement since the prior turn;

### Requested work

- event kind and stable event fingerprint;
- full non-truncated requested-changes review body;
- new or changed unresolved thread comments with ids, authors, paths, positions,
  bodies, and reply context;
- relevant general PR conversation comments;
- failing check ids, names, conclusions, annotations, bounded logs, and explicit
  log-unavailable/truncation facts;
- already-addressed ids that must not be repeated.
- the prior turn's durable outcome, still-open feedback/check ids, and events
  coalesced or superseded since that turn;

### Authority and safety

- snapshotted mode, policy hash, file/line limits, denied and approval-required
  globs, required checks, and allowed push destination;
- whether a local commit is allowed for this mode;
- commands allowed for unattended execution and which useful commands would block;
- GitHub API readiness, git credential readiness, commit identity readiness, and
  whether `gh` is installed/available through mediated execution;
- exact available tools/actions and the one required submit-fix action;
- explicit prohibitions on push, PR comments, config mutation, primary-checkout
  edits, force push, and authority expansion.

### Expected result

- keep the smallest fix that addresses the cited evidence;
- run only relevant preapproved diagnostics;
- call `neondeck_autopilot_submit_fix` once with a bounded patch/replacement plan,
  addressed ids, tests attempted, and remaining blockers;
- return a concise summary, but understand that only the submitted durable artifact
  determines success.

If any required feedback or log payload is truncated, the PR owner must block
rather than guess. The operator surface should link to the missing fact and
recommended recovery. The transcript provides continuity, but it never grants
authority and it is never the source of truth for current SHA, mode, policy,
workspace, unresolved feedback, checks, or allowed actions.

## GitHub Event And Worktree Corrections

### Initial-event semantics

`ConfigurePrAutopilotInput.processExisting` controls baseline behavior:

- `false`: seed watermarks and act only on later changes;
- `true`: seed watermarks and create one synthetic `initial-actionable-state`
  delta containing current requested changes, unresolved feedback, conversation
  requests, and failing checks.

An explicit natural-language Autopilot request should default
`processExisting=true`; a plain watch defaults false. The result must say which
choice was applied.

### Feedback coverage

Update the GitHub fact and watermark schemas to retain:

- requested-changes review bodies;
- general PR issue/conversation comments;
- review-thread comments and replies;
- author, created/updated time, file/line context, and resolution state;
- per-item fingerprints for new/changed feedback;
- addressed/replied delivery ids.

Only new or changed actionable ids enter an admission. A reply or bot-authored
result must not re-admit all older unresolved threads. Neondeck-authored comments
are ignored as triggers unless a later explicit policy says otherwise.

### Fetch before worktree creation or reuse

Before `git worktree add`:

1. Resolve the exact PR head repo, ref, SHA, and authenticated clone/fetch target.
2. Fetch the same-repo pull ref or fork head ref into a bounded temporary ref.
3. Verify `headSha^{commit}` exists locally and matches the GitHub fact.
4. Create the detached managed worktree at that SHA.
5. Record the fetch source and resolved SHA on the worktree event.

Do not rely on `fetch --all` after worktree creation. Fork/private-fork failures are
plain-language readiness blocks and retain no partially registered worktree.

The first actionable event creates the owner worktree. Later events reuse it: take
the PR-owner lock, require a clean or durably known Neondeck state, fetch the new
head, and synchronize to the exact SHA before dispatch. If the workspace is
unrecoverable, a recovery action may replace the worktree while retaining the same
Neon session; the next envelope must identify the new path and why it changed.

## Readiness And Credential Contract

Add `readAutopilotReadiness({ repoId, prNumber?, mode? })`, expose it through the
runtime doctor, setup action response, local API, CLI, and Autopilot panel.

Readiness checks:

- runtime home and worktree directory are writable;
- source repo exists and is a valid git checkout;
- PR head SHA can be fetched without an interactive prompt;
- GitHub API credential can read PRs, reviews, checks, annotations, permissions,
  and comments;
- selected delivery mode has required contents/comment permissions;
- `git` push credential can perform a non-mutating authenticated remote lookup for
  the intended repo/fork;
- git commands set `GIT_TERMINAL_PROMPT=0` and use explicit timeouts;
- commit identity is configured or a documented Neondeck bot identity is supplied;
- required check commands are configured and preapproved for unattended execution;
- `gh` availability and authentication are reported separately from token-backed
  API readiness;
- fork `maintainerCanModify` and actual push target agree.

Readiness never performs a real push. API-ready and git-push-ready are separate
facts. Setup may succeed in notify-only mode with delivery warnings, but an autofix
mode must clearly report which later stage will block.

## Verification, Approval, Delivery, And Cleanup

### Verification

- Run checks against the current worktree HEAD and persist that SHA.
- A non-preapproved unattended command produces a configuration block, not a fake
  pending execution approval that the user cannot resolve.
- A new commit invalidates prior verification and push approval.
- Expose check run URLs, commands, start/end times, output summaries, and blocking
  reasons in the operator API.

### Approval

- `prepare-only` creates no push approval.
- `autofix-with-approval` creates one pending push approval only after a committed
  prepared diff exists and verification policy is satisfied or explicitly marked
  as awaiting verification.
- `autofix-push-when-safe` creates no pending approval unless policy intentionally
  downgrades the result to approval-required.
- Every approval is bound to prepared diff, exact commit SHA, policy hash,
  operation, approver surface, and timestamp.
- Successful push, revision, abandon, supersession, or stop resolves/supersedes the
  corresponding approval.

### Push

- Revalidate mode, policy hash, branch permission, exact GitHub head, clean
  worktree, intended commit, and current verification immediately before push.
- Use noninteractive git credentials and a timeout.
- Never force-push in this product-closure scope.
- Persist `pushedCommitSha` as the canonical delivered SHA on the prepared diff and
  admission.

### PR result delivery

- Use `pushedCommitSha`, not the pre-fix PR head SHA, for post-push freshness.
- Post one idempotent top-level result summary per admission/commit.
- Reply to addressed review threads with the relevant fix/check summary when the
  GitHub API supports the thread target.
- Do not automatically resolve a thread unless reply delivery succeeded and an
  explicit repo policy enables resolution.
- Record delivery ids and failures so retry does not duplicate comments.
- A comment failure blocks only delivery/cleanup, not the already completed push.

### Cleanup

- Add a real `cleanup-autopilot-worktree` bounded workflow/action.
- A successful push completes its admission but does not delete the PR owner's
  workspace. The same managed worktree remains available for later PR feedback.
- Failed, blocked, and prepared owner worktrees are retained for inspection.
- Adopted or user-created worktrees are never automatically deleted.
- A merged or closed PR moves the owner to `draining`. Once configured post-merge
  checks have settled, Neondeck disables/removes the watch, archives the owner
  session metadata, and removes an eligible Neondeck-owned worktree after the
  configured grace period.
- Explicit stop may also archive the owner and clean its worktree. Cleanup failure
  remains visible and retryable; it never causes a replacement PR-owner session.

## Pause, Stop, Supersession, And Recovery

Pause means no new watch polling/admissions; it does not pretend an active mutation
has stopped. The UI must show both polling and active-stage state.

Stop means:

1. disable/delete the watch according to the user’s choice;
2. set `stop_requested_at` and prevent any next-stage dispatch;
3. abort an active Kilo task when applicable;
4. if the installed Flue runtime exposes a supported workflow cancellation API,
   cancel the active Neon turn; otherwise allow the bounded turn to finish but
   discard its late transition and prohibit external delivery;
5. release/revoke worktree locks;
6. supersede pending approvals;
7. retain or clean the worktree according to an explicit confirmation;
8. move active admissions to `stopped`, mark the owner `draining`, and archive its
   session after active effects have settled.

Recovery API and UI must expose, when valid:

- inspect worktree;
- retry current stage;
- retry after new commit;
- rebase/resync;
- retry verification;
- approve/deny push;
- retry push;
- retry result delivery;
- request and run revision;
- abandon;
- manual follow-up;
- cleanup;
- rotate a failed/corrupt owner session with an audited handoff;
- stop Autopilot.

Recovery-option query errors render as errors, never as an empty control area.

## Setup And Operator Surfaces

### Chat

- Export `neondeck_autopilot_watch_pr_configure` to the display assistant.
- Add explicit runtime guidance and examples for “autopilot this PR,” “watch only,”
  mode changes, processing existing feedback, pause, stop, and status.
- Export the missing watch-list action.
- Return a single setup summary containing watch id, mode, process-existing choice,
  PR-owner status/session id when allocated, readiness, first planned action, and
  confirmation requirements.

### CLI

Add a cohesive command group:

```text
neondeck autopilot watch <ref> --mode <mode> [--process-existing]
neondeck autopilot list
neondeck autopilot status <ref>
neondeck autopilot pause <ref>
neondeck autopilot resume <ref>
neondeck autopilot stop <ref> [--cleanup]
neondeck autopilot retry <admission-id>
```

Keep `watch-pr` as the notify-only shorthand.

### Onboarding and dashboard layout

- Ask whether Autopilot should be configured and explain each mode in outcome
  language.
- Include `AutopilotPanel` in recommended Cockpit and Classic layouts.
- Do not configure repo/watch authority from dashboard layout presets.
- Show readiness before accepting an autofix mode.

### PR and watch UI

- Add “Autopilot” beside “Watch” in the PR side panel.
- Autopilot opens a mode/process-existing/readiness confirmation rather than
  issuing a hidden command string.
- Active Watches shows effective mode, polling state, last poll, last actionable
  event, PR-owner session/generation, active admission, and pause/resume/stop.
- Notifications deep-link to the exact admission, prepared diff, approval, or
  recovery action.

### Canonical Autopilot panel

The active queue is derived from active admissions only. Join PR owner/session,
worktree, prepared-diff, workflow, check, approval, and notification facts onto
that row; do not append each source as another queue item.

Provide:

- one active row per admission/PR event;
- stage, mode, priority, poll state, attempt count, next retry, and block reason;
- direct links to the guarded Flue run, worktree, prepared diff, checks, and PR;
- one stable owner-session link, generation, busy/queued event state, and explicit
  rotation history;
- valid controls for the current state;
- paginated active and history views;
- separate totals for active, waiting approval, blocked, failed, and completed;
- timestamps on activity and working links for check runs;
- accessible names/descriptions, status/live semantics, keyboard operation, and
  at least 44px coarse-pointer targets.

## Work Packages And Merge Order

Each package should be a reviewable PR. Later packages may be stacked, but do not
expose the full-autonomy entry point until Package 7 passes.

### Package 1: truthful contract and durable coordinator foundation

Primary files:

- `.plans/ROADMAP.md`
- `README.md` and Autopilot docs/copy
- `src/runtime-home/app-db/schema.ts`
- `src/modules/autopilot/admissions.ts`
- new `src/modules/autopilot/owners.ts`
- new `src/modules/autopilot/coordination/*`
- `src/server/learning-hooks.ts`
- `src/modules/scheduler/pr-watch-events.ts`
- `src/modules/scheduler/workflow-invocation.ts`

Deliverables:

- correct completion claims and link this plan/audit;
- migration, durable PR owners, expanded states, stage attempts, transition
  events, versioned CAS;
- one coordinator and one workflow registry;
- bounded retry/reconciliation and terminal archival;
- replace duplicate triage continuation while preserving current triage→prepare
  behavior;
- unit tests for every legal/illegal transition, duplicate observer, restart, stale
  run, retry cap, and concurrency release.

Exit gate: existing watch→triage→prepare works through the coordinator and cannot
dispatch twice when scheduler and observer race.

### Package 2: event intake, initial processing, and persistent exact-SHA checkout

Primary files:

- `src/modules/github/reviews.ts`
- `src/modules/pr-events/schemas.ts`
- `src/modules/pr-events/watermarks.ts`
- `src/modules/scheduler/pr-watch-event-deltas.ts`
- `src/modules/watches/*`
- `src/modules/autopilot/worktree.ts`
- `src/modules/worktrees/*`

Deliverables:

- review bodies and conversation comments retained;
- per-item new/changed fingerprints and bot/addressed filters;
- explicit process-existing synthetic delta;
- fetch/verify exact same-repo and fork head before worktree creation;
- create the owner worktree on first actionable work and reuse/sync it for later
  events;
- no partial worktree record on fetch failure;
- fixtures for existing feedback, first-poll race, old-thread reply, fork head, and
  inaccessible private fork.

Exit gate: an already-stuck PR can intentionally create exactly one admission and
one owner worktree at the current GitHub head SHA; a later event reuses that
worktree and synchronizes it to the new exact head.

### Package 3: readiness and noninteractive credentials

Primary files:

- new `src/modules/autopilot/readiness.ts`
- `src/modules/runtime/status.ts`
- `src/modules/worktrees/push-target.ts`
- `src/repo-edit/git.ts`
- CLI doctor/onboarding and local API routes

Deliverables:

- separate API, fetch, git-push, comment, identity, check-command, and `gh`
  readiness facts;
- noninteractive git environment and timeouts for fetch/push;
- fork push-target verification;
- actionable setup/status responses and UI facts;
- credential tests using fake askpass/credential helpers and timeouts.

Exit gate: no unattended git operation can prompt indefinitely, and setup predicts
the same credential outcome as the later push gate.

### Package 4: continuing Neon PR-owner session

Primary files:

- new `src/agents/pr-autopilot-owner.ts`
- new `src/modules/autopilot/owner/session.ts`
- new `src/modules/autopilot/owner/dispatch.ts`
- new `src/modules/autopilot/owner/envelope.ts`
- new `src/modules/autopilot/owner/queue.ts`
- `src/modules/autopilot/actions.ts`
- `src/modules/autopilot/review-feedback.ts`
- `src/modules/autopilot/ci-fix.ts`
- new `src/skills/neon-autopilot-fix/SKILL.md`

Deliverables:

- lazy, idempotent session creation and durable watch/owner/session linkage;
- deterministic initial brief and authoritative continuation envelopes;
- bounded agent capability set with serialized/coalesced event turns;
- one-time submit-fix action;
- review and CI event envelopes grounded in complete facts;
- prepared-diff creation and mode-specific commit behavior;
- no-op, truncated facts, out-of-policy patch, stale SHA, missing submission, model
  failure, and late-result tests;
- restart-safe same-session dispatch, explicit generation/rotation recovery, and
  guarded session/turn inspection links for operators.

Exit gate: two sequential fixture-backed feedback events produce scoped prepared
diffs through the same Flue session id and owner worktree, including across a
Neondeck restart. No caller supplies the patch to the top-level product request,
and no second session is created for ordinary feedback.

### Package 5: verification, approval, push, comment, and cleanup continuation

Primary files:

- `src/workflows/verify-pr-worktree.ts`
- `src/workflows/verify-then-push-pr-autofix.ts`
- `src/workflows/push-pr-autofix.ts`
- `src/workflows/comment-pr-autofix-result.ts`
- new `src/workflows/cleanup-autopilot-worktree.ts`
- `src/modules/autopilot/approvals.ts`
- `src/modules/autopilot/push.ts`
- `src/modules/autopilot/comments.ts`
- `src/modules/autopilot/recovery.ts`
- prepared-diff services

Deliverables:

- coordinator transitions for each mode;
- approval creation/resolution rules fixed;
- current-HEAD verification and invalidation;
- pushed commit recorded canonically;
- idempotent top-level and thread result delivery;
- real owner-terminal cleanup workflow and grace-period admission;
- restart/retry tests around every external side effect.

Exit gate: all four mode rows in the mode table pass integration tests, including a
real non-force push to a temporary bare remote and comment-delivery fixture.

### Package 6: explicit setup and control surfaces

Primary files:

- `src/modules/watches/actions.ts`
- `src/modules/config/mutations/repos.ts`
- new Autopilot setup service/action/schema
- `src/commands/*`
- `src/cli/*`
- `src/server/routes/autopilot.ts`
- `web/src/plugins/GitHubPrList.tsx`
- `web/src/plugins/ActiveWatches.tsx`
- dashboard presets/onboarding

Deliverables:

- composite setup contract across chat/API/CLI/UI that creates the awaiting-event
  owner binding but lazily allocates session/worktree;
- stable per-watch override mutation and authority confirmation ranking;
- watch list/pause/resume/stop/status/retry entry points;
- process-existing choice and readiness summary;
- Autopilot present in recommended layouts;
- setup contract tests proving all surfaces call the same service.

Exit gate: the exact natural-language request in the Outcome section configures the
watch and mode without direct file editing or a raw API call.

### Package 7: canonical operator state, stop, and recovery UX

Primary files:

- `src/modules/autopilot/state.ts`
- `src/modules/autopilot/state-mappers.ts`
- `src/modules/autopilot/state-schemas.ts`
- `src/modules/autopilot/recovery.ts`
- `web/src/plugins/AutopilotPanel.tsx`
- notification sources/targets/controllers

Deliverables:

- one canonical admission row rather than reconstructed duplicates, joined to its
  stable owner session;
- pagination/history, accurate counts, mode and poll state;
- complete recovery/explicit-session-rotation controls and visible query errors;
- real pause/stop/supersession semantics;
- normalized notification attention accounting;
- accessible labels, live state, timestamps, links, and touch targets.

Exit gate: an operator can understand and control every active/blocked state without
opening SQLite, Flue internals, or a raw route.

### Package 8: product-path verification, docs, and rollout

Primary files:

- `src/autopilot-admissions.test.ts`
- `src/autopilot-workflows.test.ts`
- new product-path integration suite
- `scripts/autopilot-smoke.mjs`
- README, public docs, runtime skill, and onboarding copy
- `.plans/ROADMAP.md` and `.plans/DEVIATIONS.md`

Deliverables:

- one production-shaped watcher→continuing-owner-session→delivery harness;
- restart, retry, idempotency, concurrency, fork, auth, stop, and mode matrix;
- optional credentialed smoke against a disposable test repo;
- accurate setup, modes, permissions, storage, recovery, and disable docs;
- remove stale “Phase 19 workflows will land” copy;
- switch fresh explicit Autopilot setup to recommend prepare-only;
- mark roadmap completion only after the acceptance suite passes.

Exit gate: `npm run verify` and the product-path smoke pass, and every acceptance
scenario below has an automated test or an explicit manual credentialed check.

## Verification Strategy

### Unit tests

- exhaustive transition table by state, mode, and artifact;
- transactional stage claims and duplicate observer races;
- retry classification, backoff, max attempts, stale turn, stop, supersession;
- initial/continuation envelope completeness, authority precedence, and
  secret/redaction rules;
- one-session-per-owner creation, reuse, restart recovery, event serialization,
  coalescing, and explicit rotation generation;
- submit-fix nonce, admission, worktree, SHA, path, and policy binding;
- event body/comment preservation and per-item fingerprinting;
- approval lifecycle and pushed-SHA comment freshness;
- active/history state mapping and pagination.

### Integration tests

Use temporary runtime homes, source repos, bare remotes, worktrees, fake GitHub
facts/mutations, fake credential helpers, fake execution, and a production-shaped
continuing-session fixture. Exercise the coordinator and real Flue dispatch
adapters.

Required cases:

1. Existing requested changes with `processExisting=true` produce one fix.
2. Existing state with `processExisting=false` is only baselined.
3. Feedback arriving before first poll is not lost.
4. Review body-only request reaches the PR-owner session verbatim.
5. Conversation-comment change request triggers once.
6. Replying to one thread does not re-admit every old thread.
7. Same-repo and fork head SHAs are fetched before worktree creation.
8. Review and CI event turns produce prepared diffs without top-level patches.
9. Each mode follows its documented row exactly.
10. Unapproved check command blocks with configuration guidance.
11. Approval is SHA/policy-bound and resolved after push/supersession.
12. Pushed result comment uses the pushed SHA and is idempotent.
13. Restart between every pair of stages resumes once.
14. Two observers cannot double-dispatch; different PRs respect concurrency.
15. Permanent auth failure backs off/blocks rather than polling forever.
16. Pause prevents new admissions; stop prevents all later external effects.
17. Cleanup removes only eligible Neondeck-owned worktrees.
18. Queue/history show one canonical admission, its stable owner session, and all
    valid controls.
19. A second actionable event uses the first event's session id and worktree id.
20. Restart recovery preserves that session/worktree mapping.
21. Events arriving while the owner is busy are serialized and coalesced before
    another turn; they never create a second session.
22. Explicit session rotation archives generation N, seeds generation N+1 with an
    audited handoff, and is the only ordinary way the session id changes.
23. Merge/close plus configured settled checks archives the owner/session and then
    cleans the eligible managed worktree.

### Smoke tests

`scripts/autopilot-smoke.mjs` must run the product path, not a list of disconnected
workflow unit fixtures. It should:

1. create a temporary repo, bare remote, PR/watch fixture, and runtime home;
2. configure an explicit mode and process-existing behavior;
3. inject actionable feedback or a failed check;
4. run the scheduler/watch dispatcher;
5. wait through the first bounded turn, inject a second event, and assert both
   turns use the same owner session and workspace;
6. assert prepared diff, verification, approval or push, result delivery,
   notifications, admission history, and cleanup disposition;
7. fail if any stage required a manual raw-API invocation.

An optional credentialed smoke may use a disposable GitHub repository, but the
credential-free product-path test is mandatory in CI.

## Acceptance Criteria

Autopilot is usable when all of these statements are true:

- Chat, dashboard, and CLI can explicitly configure one PR’s mode and current-state
  processing through the same service.
- Current feedback is never silently discarded by first-poll baseline behavior.
- The exact PR head SHA is available before worktree creation, including supported
  fork PRs.
- The first actionable event starts exactly one Neon PR-owner session and managed
  worktree; later events and process restarts reuse both.
- Each turn receives a complete authoritative event envelope, while session
  history preserves reasoning continuity across feedback cycles.
- The PR owner cannot edit the primary checkout, push, comment, or expand
  authority.
- Review bodies, new/changed threads, conversation comments, and CI failures reach
  the same PR-owner session with stable ids and complete bounded content.
- `prepare-only` produces a reviewable diff; approval mode waits; safe mode pushes
  only after all gates pass.
- Verification, approval, push, comments, and cleanup continue automatically when
  mode and facts permit.
- GitHub API readiness and git credential readiness are both checked and visible.
- Pause, stop, retry, revise, abandon, manual follow-up, and cleanup have accurate,
  durable semantics.
- The operator queue is canonical, paginated, accessible, and does not count
  historical duplicates as active work.
- A restart or duplicate observer cannot repeat a mutation.
- Same-PR events are serialized/coalesced; ordinary events never create another
  Neon session. Rotation is explicit, audited, and carries forward a compact
  handoff plus fresh authoritative state.
- Merge/close plus configured settled checks disables the watch, archives the
  PR-owner session, and cleans its eligible managed workspace after the grace
  period.
- The production-path integration test and smoke test prove the whole chain.
- README, roadmap, public docs, onboarding, runtime guidance, and UI copy describe
  exactly the behavior the tests prove.

## Finding-To-Package Traceability

| Audit finding | Owning packages |
| --- | --- |
| F1 missing agent/coordinator | 1, 4, 5 |
| F2 first-poll/current feedback loss | 2, 6 |
| F3 fetch-after-worktree/fork failure | 2, 3 |
| F4 hidden and fragmented setup | 6, 8 |
| F5 presets remove Autopilot | 6 |
| F6 missing feedback bodies/comments | 2, 4 |
| F7 pause/stop do not control work | 1, 7 |
| F8 deadlocked admissions/infinite retries | 1 |
| F9 approval, safe-push, comment inconsistencies | 5 |
| F10 API and git credential mismatch | 3, 5 |
| F11 misleading duplicated queue | 7 |
| F12 hidden recovery actions/errors | 7 |
| F13 missing failure/attention accounting | 1, 7 |
| F14 old-feedback replay/watch status mismatch | 2, 7 |
| F15 cleanup/lifecycle gaps | 1, 5, 7 |
| F16 inaccurate docs/completion claims | 1, 8 |
| F17 accessibility/troubleshooting defects | 7, 8 |

## Explicit Deferrals

These are not required to close the reviewed Autopilot product loop:

- GitHub webhooks; polling remains acceptable if latency is documented and the
  scheduler is running.
- Force push.
- A second full agent runtime or raw host shell for the PR owner.
- Per-event Neon session creation or automatic routine session rotation; one
  continuing PR-owner session is the default lifecycle.
- Automatic Kilo selection without explicit user/repo policy.
- Managed `kilo serve` SDK migration.
- Automatic resolution of review threads without an explicit repo policy.
- General-purpose DAG/workflow authoring.
- Provider-specific full-log adapters beyond the current bounded facts, provided
  missing data blocks rather than guesses.

Record any additional deviation or deferral in `.plans/DEVIATIONS.md` with the
affected package, reason, user impact, and follow-up acceptance test.

## Plan Maintenance

- This document is the implementation source of truth for Autopilot product
  closure. The HTML audit remains the evidence and UX report.
- Update package status here as PRs land; do not mark a package complete merely
  because its individual actions exist.
- Keep `.plans/ROADMAP.md` status synchronized with the package exit gates.
- Archive this plan only after Package 8 and the complete acceptance suite land.
