# Autopilot Product-Closure Implementation Plan

Status: in progress; Packages 1–3 implemented, Packages 4–8 not started

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
4. On the first actionable event, Neondeck creates one PR-owner Neon agent instance and
   one isolated managed worktree at the exact PR head SHA. Both are durably bound
   to the watch and the primary checkout is never edited.
5. Neondeck dispatches a bounded event turn to that same agent instance with a factual,
   authoritative environment envelope. Later feedback, CI changes, and PR state
   changes are dispatched to the same agent instance and workspace rather than creating
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
  → create/reuse PR-owner agent instance and exact-SHA worktree
  → bounded event turn in that same agent instance
  → prepared diff
  → policy and verification
  → approval or safe push
  → PR result delivery
  → wait for the next event in the same agent instance
  → on terminal PR state: archive agent instance / cleanup workspace
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
handlers, owner-instance reconciliation, approval routes, and recovery actions may request
advancement, but must not directly invoke the next workflow.

Deterministic stages are bounded Flue workflows with run ids and typed terminal
results. Agent work is a bounded, correlated dispatch into the watch's continuing
PR-owner Flue agent instance. Every state transition is committed in Neondeck SQLite
before an external effect is started. A compare-and-swap state/version update
prevents duplicate observers from dispatching the same next stage or agent turn.

Remove the two current triage-to-prepare continuation paths from
`src/modules/scheduler/pr-watch-events.ts` and `src/server/learning-hooks.ts` after
the coordinator owns that transition.

### One continuing Neon agent instance owns each Autopilot PR

Create a private `pr-autopilot-owner` Flue agent definition with a narrow
capability set. Each configured Autopilot watch gets one addressable Flue **agent
instance** id for that agent. The durable PR controller/state machine owns policy
and progression; the continuing instance owns reasoning continuity about the PR.

Terminology: the `id` passed to `dispatch({ agent, id, input })` is the stable Flue
**agent instance** id: a persistent, addressable dispatch target whose canonical
conversation stream accumulates across dispatches. It is never the per-operation
`DispatchReceipt.dispatchId`. Flue sessions are named conversation branches within
a harness and are a distinct concept; only `chat_session_id` intentionally names
Neondeck's app-owned chat metadata. The durable field that stores this target is
therefore `flue_instance_id` throughout this plan; the stage-attempt row stores the
separate per-dispatch `dispatch_id` returned by Flue.

The owner row may be created during setup, but its Flue instance and managed
worktree are created lazily on the first actionable event. The initial dispatch
contains the full PR, mode, environment, workspace, capability, and event brief.
Every later actionable event is dispatched with the same agent and instance id:

```ts
dispatch({
  agent: 'pr-autopilot-owner',
  id: owner.flueInstanceId,
  input: authoritativeEventEnvelope,
});
```

This is the same continuing-instance pattern already used by scheduled instruction
dispatch and recurring briefings. An event turn is bounded and audited;
the PR-owner instance is not recreated at the end of the turn.

For installed `@flue/runtime` `1.0.0-beta.9`, configure the agent's `compaction`
field with `CompactionConfig`: `reserveTokens` reserves headroom in the model context
window and threshold compaction begins when used tokens exceed
`contextWindow - reserveTokens`; `keepRecentTokens` leaves that recent portion
unsummarized, while older model-visible messages are folded into a summary. This
bounds model input for a turn, not the persisted canonical instance stream, Flue's
transcript storage, or replay/storage cost. The instance must still be able to
outlive a long PR, and any retained-stream/replay-cost policy is a separate explicit
product decision. This is also separate from Neondeck's `staleReasons`
grounding-drift signal (see rotation rules below).

Implementation should reuse the established dispatch and chat-metadata seams in
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
PR-owner Neon agent instance supervises the handoff, and Kilo completion re-enters
the same owner/admission coordinator before the result is sent back to that instance.

### Same-PR turns are serialized and coalesced

Only one reasoning/mutation turn may be active for a PR owner. Events that arrive
while it is busy are durably queued. On settlement, the controller recomputes the
current PR delta, supersedes facts already addressed by the completed turn, and
dispatches one coalesced follow-up envelope to the same agent instance. Two separate PRs
may progress concurrently within the configured global and per-repo limits.

Ordinary feedback, CI, commit, and mergeability changes never rotate the instance.
Instance rotation is an explicit recovery path only: corrupted/unavailable instance,
operator request, or a proven context-limit failure. Rotation archives the old
instance, increments `generation`, creates a replacement, and seeds it with an
audited compact handoff plus current authoritative facts. It is visible in the
operator history and must not happen silently.

#### Grounding drift (`staleReasons`) must re-ground safely, not rotate by default

Extract `readStaleReasons` from `src/modules/sessions/store.ts` into a shared,
baseline-aware `src/modules/sessions/stale-reasons.ts` service. It accepts a database,
one or more source cursors, and the exact `contextMemoryIds` included in the caller's
grounding; it returns the same typed reasons for chat metadata and Autopilot owners.
The chat row reader delegates to it, while the owner reader supplies its own persisted
cursors. This avoids duplicating the current private query and makes its
relevant-memory filter implementable for both consumers.

The signal is orthogonal to model-visible context length. For Autopilot, it scans and
classifies **every** `config_history` row after `grounding_config_history_id`, ordered
by its stable integer id, and every relevant `memory_events` row after the persisted
`(created_at, id)` cursor, ordered by that pair. It must not look only at the latest
row: a later benign change must never hide an earlier post-baseline model/provider/
skill/soul or unknown-config change. It stays stale until a later accepted dispatch
actually carries a replacement grounding snapshot.

Add `grounding_memory_ids_json` to the owner row. The deterministic envelope builder
must use the same memory-selection service as chat context, include those selected
memory facts and ids in the authoritative envelope, and record an immutable
`groundingSnapshot` artifact containing: the `config_history` high-water **id**, the
selected memory ids, the relevant-memory `(created_at, id)` high-water cursor, and an
envelope hash. Persist the snapshot artifact id/hash on the reserved stage attempt
before dispatch, and link the returned receipt's `dispatch_id` to that same attempt.
It may never claim to re-ground memory whose ids were not in that envelope.

After Flue accepts the dispatch and returns the per-operation `dispatch_id`, perform a
CAS update keyed by owner id, generation, stage attempt, snapshot artifact id/hash,
and receipt `dispatch_id`. It advances `grounding_config_history_id`, the relevant
memory cursor, and `grounding_memory_ids_json` together to the snapshot values. Do not
use wall-clock settlement time or collapse the sources into one timestamp: a config or
memory change arriving after its source snapshot remains stale for the next turn. If
dispatch is rejected, the receipt cannot be durably linked, or the CAS fails, retain
the prior cursors; recovery must recompute drift and reconcile the reserved attempt.
The snapshot, receipt link, and baseline update are audited.

The PR owner must not reuse the briefings throw-on-stale reuse gate. Branch on a
classified reason and envelope coverage instead:

- `memory` drift re-grounds in the same agent instance only when the next envelope
  includes the selected current memory facts and ids described above.
- `repo` drift re-grounds in the same agent instance only for an explicit recognized
  `config_history` action/target mapping whose affected repository, Autopilot mode,
  policy, workspace, and push-target facts are present in the envelope. The initial
  mapping includes `config_add_repo`, `config_update_repo`,
  `config_update_repo_autopilot_policy`, and `config_remove_repo`; an affected or
  deleted owner repo blocks rather than dispatching. The Autopilot mode mutation is
  `config_update_repo_autopilot_policy`, not `config_update_repo`. For that mapping,
  a mode/policy decrease or stop applies immediately and blocks any later external
  effect; an increase cannot become effective through re-grounding or the baseline
  CAS. It requires the separately recorded operator decision and applies only to a
  later admission, preserving the active admission's mode snapshot.
- Generic `config` drift re-grounds in place only when an explicit registry classifies
  that action/target and the envelope declares every affected authoritative fact.
  Unknown or future `config_history` actions, missing coverage, or an unclassifiable
  target must conservatively block with a recovery choice or perform an audited
  instance rotation; they must never be silently cleared merely because an envelope
  was sent.
- `model`, `provider`, `skill`, and `soul` drift alter fundamental capabilities and
  trigger an audited instance rotation with a compact handoff and current facts.

A bare `staleReasons.length > 0` check is never a rotation trigger, and no drift type
may clear the baseline before the applicable authoritative envelope is accepted.

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

| Mode                     | Owner turn | Local commit | Verify                      | Approval                                  | Push                          | Comment                      |
| ------------------------ | ---------- | ------------ | --------------------------- | ----------------------------------------- | ----------------------------- | ---------------------------- |
| `notify-only`            | no         | no           | no                          | no                                        | no                            | notification only            |
| `prepare-only`           | yes        | no           | optional policy diagnostics | no push approval                          | never                         | prepared-diff notification   |
| `autofix-with-approval`  | yes        | yes          | required                    | exact SHA/policy approval                 | after approval                | after push or terminal block |
| `autofix-push-when-safe` | yes        | yes          | required                    | none unless policy downgrades to approval | automatic when all gates pass | after push or terminal block |

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
flue_instance_id             nullable until first actionable event; unique stable
                             Flue agent-instance dispatch target, never dispatch_id
chat_session_id              nullable link to app-owned session metadata
worktree_id                  nullable until first actionable event
generation                   starts at 1; increments only on explicit rotation
grounding_config_history_id  last fully grounded config_history integer id
grounding_memory_event_at    last fully grounded relevant memory-event timestamp
grounding_memory_event_id    tie-breaker id for the memory-event cursor
grounding_memory_ids_json    exact relevant memory ids included in the baseline
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
and persists the Flue instance/chat session and managed worktree transactionally
around idempotent creation. Restart recovery reads this mapping and reuses it; it
never guesses ownership from a title or starts a replacement instance merely because
the process restarted.

The config and relevant-memory cursors plus `grounding_memory_ids_json` mirror the
app-owned chat metadata semantics without reusing a chat row as the owner baseline.
They are advanced only together by the accepted-dispatch CAS contract in the
grounding-drift rules above.

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
flue_instance_id             stable owner target populated for agent turns
owner_generation             populated for agent turns
event_sequence               populated for agent turns
dispatch_id                  per-operation Flue DispatchReceipt id; unique when present
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

The instance id is expected to repeat across ordinary admissions; the attempt id
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
- Ordinary new feedback reuses the recorded Flue instance and managed worktree;
  only explicit instance rotation may change the instance id/generation. Grounding
  drift re-grounds only under the classified, complete-envelope rules above;
  `model`/`provider`/`skill`/`soul` drift rotates, while unknown generic config drift
  blocks or rotates and is never silently cleared.
- A workflow cannot advance an admission unless its run id matches the active
  stage attempt.
- Admission mode is snapshotted at creation. A later authority increase applies
  only after an explicit operator decision; a decrease or stop applies
  immediately.
- New PR commits supersede an unpushed stale attempt and create/reconcile a new
  admission in the same owner agent instance rather than patching against the wrong SHA.
- Events received during an active turn remain queued and are coalesced against
  fresh PR facts before the next dispatch to that same agent instance.
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
watch, admission, attempt, owner generation, event sequence, policy version, and
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
Neon agent instance; the next envelope must identify the new path and why it changed.

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
  agent instance and its optional app-owned chat metadata, and removes an eligible Neondeck-owned worktree after the
  configured grace period.
- Explicit stop may also archive the owner and clean its worktree. Cleanup failure
  remains visible and retryable; it never causes a replacement PR-owner agent instance.

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
   agent instance after active effects have settled.

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
- rotate a failed/corrupt owner agent instance with an audited handoff;
- stop Autopilot.

Recovery-option query errors render as errors, never as an empty control area.

## Setup And Operator Surfaces

### Chat

- Export `neondeck_autopilot_watch_pr_configure` to the display assistant.
- Add explicit runtime guidance and examples for “autopilot this PR,” “watch only,”
  mode changes, processing existing feedback, pause, stop, and status.
- Export the missing watch-list action.
- Return a single setup summary containing watch id, mode, process-existing choice,
  PR-owner status/agent-instance id when allocated, readiness, first planned action, and
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
  event, PR-owner agent instance/generation, active admission, and pause/resume/stop.
- Notifications deep-link to the exact admission, prepared diff, approval, or
  recovery action.

### Canonical Autopilot panel

The active queue is derived from active admissions only. Join PR owner/agent instance,
worktree, prepared-diff, workflow, check, approval, and notification facts onto
that row; do not append each source as another queue item.

Provide:

- one active row per admission/PR event;
- stage, mode, priority, poll state, attempt count, next retry, and block reason;
- direct links to the guarded Flue run, worktree, prepared diff, checks, and PR;
- one stable owner-agent-instance link, generation, busy/queued event state, and
  explicit instance-rotation history;
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

Status: implemented. The exit gate is covered by the coordinator, migration,
and scheduler/observer race tests; later packages remain intentionally out of
scope.

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

Status: implemented and recovery-hardened on 2026-07-19. Packages 3–8 remain
unstarted. Conversation comments are retained as non-mutation candidate-reasoning
inputs; Package 4 owns their semantic interpretation in the continuing PR owner.

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
- per-item new/changed fingerprints, addressed filters, and exact durable
  Neondeck-delivery suppression without trusting author type or body markers;
- one durable pending intake before watermark acknowledgement, complete-fact gates,
  restart replay, aggregate item/byte/time fetch budgets, and versioned seed-only
  upgrade behavior;
- opaque watch generations that rotate on baseline reset/rearm, CAS every
  post-fetch watch update, and bind admission to the exact still-pending intake
  generation so remove/reset races fail before notification or dispatch;
- explicit process-existing synthetic delta;
- fetch/verify exact same-repo and fork head before worktree creation;
- create the owner worktree on first actionable work and reuse/sync it for later
  events;
- no partial worktree record on fetch failure;
- match the registered repository remote, validate all ref/remote components, and
  keep option parsing terminated for exact-head fetches;
- fixtures for existing feedback, first-poll race, old-thread reply, fork head, and
  inaccessible private fork.

Exit gate: an already-stuck PR can intentionally create exactly one admission and
one owner worktree at the current GitHub head SHA; a later event reuses that
worktree and synchronizes it to the new exact head. Removing or resetting the
watch before admission supersedes the retained intake without notification or
dispatch; Package 7 owns stop/recovery after an admission transaction commits.

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

Implementation status: complete. `readAutopilotReadiness` now emits typed,
separate local, GitHub API, exact-fetch, Git-push, comment, author/committer,
check-command, and `gh` facts through runtime status, targeted doctor/CLI, the
read-only local API, onboarding guidance, and Runtime Overview. One shared Git
runner bounds and disables prompts for worktree sync, exact PR fetch, local diff
fetch, repo-edit push, scheduler/docs Git, and exe.dev remote checkout commands.
HTTPS readiness proves helper/askpass credential retrieval without retaining the
secret, validates that credential against the intended repository, and binds its
actor to the separately reported API actor; SSH reachability remains an explicit
unbound-identity warning. The immediate pre-push gate consumes the same typed
decision before any push side effect. Same-repo and fork targets are derived from
authoritative PR head/permission facts, option parsing is terminated for remote
arguments, and no readiness path performs a dry-run or real push. Fake helper and
askpass success/hang fixtures cover redaction, recursive causes, timeout, and
process-group termination.

### Package 4: continuing Neon PR-owner agent instance

Primary files:

- new `src/agents/pr-autopilot-owner.ts`
- new `src/modules/autopilot/owner/instance.ts`
- new `src/modules/autopilot/owner/dispatch.ts`
- new `src/modules/autopilot/owner/envelope.ts`
- new `src/modules/autopilot/owner/queue.ts`
- `src/modules/autopilot/actions.ts`
- `src/modules/autopilot/review-feedback.ts`
- `src/modules/autopilot/ci-fix.ts`
- new `src/skills/neon-autopilot-fix/SKILL.md`

Deliverables:

- lazy, idempotent instance creation and durable watch/owner/instance linkage;
- `compaction: CompactionConfig` set on the `pr-autopilot-owner` agent with explicit
  `reserveTokens` and `keepRecentTokens`, plus tests that it bounds model-visible
  input only and does not claim to bound persisted canonical stream or replay cost;
- deterministic initial brief and authoritative continuation envelopes;
- bounded agent capability set with serialized/coalesced event turns;
- one-time submit-fix action;
- review and CI event envelopes grounded in complete facts;
- prepared-diff creation and mode-specific commit behavior;
- shared baseline-aware stale-reason service that scans all post-cursor config and
  relevant-memory events; persisted separate config and memory cursors plus relevant
  memory ids; snapshot artifact-to-attempt/receipt linkage; `memory` and explicitly
  classified/covered `repo` or generic `config` drift re-ground in place through the
  accepted-dispatch CAS, while unknown generic config drift blocks or rotates and
  `model`/`provider`/`skill`/`soul` drift rotates;
- no-op, truncated facts, out-of-policy patch, stale SHA, missing submission, model
  failure, and late-result tests;
- restart-safe same-instance dispatch, explicit generation/rotation recovery, and
  guarded instance/turn inspection links for operators.

Exit gate: two sequential fixture-backed feedback events produce scoped prepared
diffs through the same Flue instance id and owner worktree, including across a
Neondeck restart, and including when a `config_update_repo_autopilot_policy` mode
change lands
between the two events (the second event re-grounds in place and does not rotate).
The fixture also proves that a selected-memory change is re-grounded with its id,
while an unknown config-history action blocks or rotates without advancing the
baseline. No caller supplies the patch to the top-level product request, and no
second instance is created for ordinary feedback.

Implementation status: complete. Package 4 now persists lazy owner generations,
immutable grounding snapshots, one-time fix submissions, and accepted-dispatch
CAS linkage across the Neondeck and Flue persistence boundary. The private
`pr-autopilot-owner` uses explicit model-visible compaction, complete authoritative
review/CI/readiness/authority/workspace envelopes, a five-action capability ceiling,
trusted attempt/token-bound read wrappers, serialized byte-bounded/coalesced turns,
and deterministic prepared-diff integration with effective-mode commit suppression.
Accepted dispatches persist independent config and monotonic SQLite-rowid memory
cursors. Explicit repo-Autopilot policy, execution, worktree, learning, and selected
memory changes re-ground in place; structural repo changes and unknown config block
without advancing the baseline; fundamental model/provider/skill/SOUL changes rotate
with an audited handoff. Fix submission is atomically leased before asynchronous
validation, rechecks the live PR and local worktree heads, and prevents terminal
settlement or restart reconciliation from racing an in-flight deterministic
mutation. The deterministic fixers repeat local-head and effective-mode checks under
their worktree mutation lease, while replacement count, bytes, paths, and conservative
line impact are bounded before editing. Owner-specific reconciliation follows
dispatch ids, retained terminal facts, process-local applying leases, expired
worktree locks, and explicit stage timeouts instead of treating agent turns as
detached workflow runs. Focused fixture-backed
unit/component coverage proves two sequential real prepared fixes reuse the
instance/worktree across reconstructed service closures and a real policy downgrade,
selected-memory in-place re-grounding, same-timestamp memory cursor safety,
unknown-drift blocking, fundamental rotation, scoped reads, early/in-flight terminal
races, one-time/no-op/truncation/policy/size/SHA/model/missing/late handling, and
durable queue coalescing. Per explicit verification constraint, this package did not
run the long integration suite or `npm run verify`; the substituted coverage and its
process-boundary limitation are recorded in `.plans/DEVIATIONS.md`.

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
  owner binding but lazily allocates agent instance/worktree;
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
  stable owner agent instance;
- pagination/history, accurate counts, mode and poll state;
- complete recovery/explicit-instance-rotation controls and visible query errors;
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

- one production-shaped watcher→continuing-owner-agent-instance→delivery harness;
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
- one-instance-per-owner creation, reuse, restart recovery, event serialization,
  coalescing, and explicit rotation generation;
- grounding-drift scanning, snapshot/receipt CAS, and races: all post-cursor config
  rows and relevant-memory events are classified; relevant-memory ids and separate
  config/memory cursors are persisted; `memory` and explicitly classified/covered
  `repo` or generic `config` drift re-ground in place; unknown generic config blocks
  or rotates; `model`/`provider`/`skill`/`soul` drift rotates; a bare
  `staleReasons.length > 0` never forces rotation;
- submit-fix nonce, admission, worktree, SHA, path, and policy binding;
- event body/comment preservation and per-item fingerprinting;
- approval lifecycle and pushed-SHA comment freshness;
- active/history state mapping and pagination.

### Integration tests

Use temporary runtime homes, source repos, bare remotes, worktrees, fake GitHub
facts/mutations, fake credential helpers, fake execution, and a production-shaped
continuing-agent-instance fixture. Exercise the coordinator and real Flue dispatch
adapters.

Required cases:

1. Existing requested changes with `processExisting=true` produce one fix.
2. Existing state with `processExisting=false` is only baselined.
3. Feedback arriving before first poll is not lost.
4. Review body-only request reaches the PR-owner agent instance verbatim.
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
18. Queue/history show one canonical admission, its stable owner agent instance, and all
    valid controls.
19. A second actionable event uses the first event's instance id and worktree id.
20. Restart recovery preserves that instance/worktree mapping.
21. Events arriving while the owner is busy are serialized and coalesced before
    another turn; they never create a second instance.
22. Explicit instance rotation archives generation N, seeds generation N+1 with an
    audited handoff, and is the only ordinary way the instance id changes.
23. Merge/close plus configured settled checks archives the owner/instance and then
    cleans the eligible managed worktree.
24. A `config_update_repo_autopilot_policy` mode decrease between two events
    re-grounds the same instance without rotation and blocks later external effects;
    its mode increase cannot take effect without a recorded operator decision and a
    later admission. A `model`/`provider`/`skill`/`soul` change between events rotates
    with an audited handoff.
25. A selected-memory change records its ids in the accepted envelope snapshot and
    re-grounds the same instance; an unknown config-history action or missing
    envelope coverage cannot advance the baseline and instead blocks or rotates.
26. Mixed drift order cannot be masked: a model/provider/skill/soul or unknown
    config-history row followed by a benign row still rotates or blocks. A config
    change between the config snapshot and a later memory event, and a receipt before
    snapshot persistence, retain the prior cursors and are reconciled without
    clearing either source's drift.

### Smoke tests

`scripts/autopilot-smoke.mjs` must run the product path, not a list of disconnected
workflow unit fixtures. It should:

1. create a temporary repo, bare remote, PR/watch fixture, and runtime home;
2. configure an explicit mode and process-existing behavior;
3. inject actionable feedback or a failed check;
4. run the scheduler/watch dispatcher;
5. wait through the first bounded turn, inject a second event, and assert both
   turns use the same owner agent instance and workspace;
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
- The first actionable event starts exactly one Neon PR-owner agent instance and managed
  worktree; later events and process restarts reuse both.
- Each turn receives a complete authoritative event envelope, while agent-instance
  history preserves reasoning continuity across feedback cycles.
- The PR owner cannot edit the primary checkout, push, comment, or expand
  authority.
- Review bodies, new/changed threads, conversation comments, and CI failures reach
  the same PR-owner agent instance with stable ids and complete bounded content.
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
  Neon instance. Rotation is explicit, audited, and carries forward a compact
  handoff plus fresh authoritative state.
- Agent `compaction: CompactionConfig` bounds model-visible input at the configured
  threshold; it does not claim to compact/bound the persisted canonical stream,
  transcript storage, or replay cost. Grounding drift re-grounds only through the
  accepted-dispatch snapshot/CAS: `memory` and explicitly classified/covered
  `repo`/generic-`config` drift stay in the instance; unknown generic config drift
  blocks or rotates; `model`/`provider`/`skill`/`soul` drift rotates.
- Merge/close plus configured settled checks disables the watch, archives the
  PR-owner agent instance and optional chat metadata, and cleans its eligible managed workspace after the grace
  period.
- The production-path integration test and smoke test prove the whole chain.
- README, roadmap, public docs, onboarding, runtime guidance, and UI copy describe
  exactly the behavior the tests prove.

## Finding-To-Package Traceability

| Audit finding                                   | Owning packages |
| ----------------------------------------------- | --------------- |
| F1 missing agent/coordinator                    | 1, 4, 5         |
| F2 first-poll/current feedback loss             | 2, 6            |
| F3 fetch-after-worktree/fork failure            | 2, 3            |
| F4 hidden and fragmented setup                  | 6, 8            |
| F5 presets remove Autopilot                     | 6               |
| F6 missing feedback bodies/comments             | 2, 4            |
| F7 pause/stop do not control work               | 1, 7            |
| F8 deadlocked admissions/infinite retries       | 1               |
| F9 approval, safe-push, comment inconsistencies | 5               |
| F10 API and git credential mismatch             | 3, 5            |
| F11 misleading duplicated queue                 | 7               |
| F12 hidden recovery actions/errors              | 7               |
| F13 missing failure/attention accounting        | 1, 7            |
| F14 old-feedback replay/watch status mismatch   | 2, 7            |
| F15 cleanup/lifecycle gaps                      | 1, 5, 7         |
| F16 inaccurate docs/completion claims           | 1, 8            |
| F17 accessibility/troubleshooting defects       | 7, 8            |

## Explicit Deferrals

These are not required to close the reviewed Autopilot product loop:

- GitHub webhooks; polling remains acceptable if latency is documented and the
  scheduler is running.
- Force push.
- A second full agent runtime or raw host shell for the PR owner.
- Per-event Neon agent-instance creation or automatic routine instance rotation; one
  continuing PR-owner agent instance is the default lifecycle.
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
