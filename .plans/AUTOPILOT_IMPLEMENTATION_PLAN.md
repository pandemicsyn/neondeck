# Autopilot: Simplified Implementation Plan

Status: minimal loop delivered in PRs #171 and #172; trusted-workspace semantic
correction pending

Companion audit: `.plans/AUTOPILOT_END_TO_END_REVIEW.html`

This document replaces the former admission/coordinator implementation plan. The
HTML audit remains useful evidence about product gaps, but its recommended machinery
is not an implementation requirement where this plan chooses a smaller design.

## Goal

Autopilot should implement this loop:

```text
watch PR
  → meaningful feedback or failing checks appear
  → task the PR's continuing Neon agent with current facts
  → agent evaluates the request and makes a focused change when needed
  → according to mode: prepare, await approval, or autonomously push and respond
    when the owner judges the requested change sane and appropriately scoped
  → continue watching the same PR with the same agent instance and worktree
  → PR merges and configured merge checks are green
  → stop the watch, archive the agent instance, and clean the managed worktree
```

The first actionable event lazily creates one Neon agent instance and one managed
worktree for the PR. Later events reuse both. A process restart must recover those
two identifiers from the watch rather than create replacements.

The primary checkout is never modified.

## Calibrating Principle

> Add durability or coordination only where a race has a real consequence that a
> human will not catch before merge.

This is the guard against rebuilding a general-purpose workflow engine around a
small product loop.

The modes with a human before delivery stay deliberately simple:

- `notify-only`: a human decides what to do.
- `prepare-only`: a human reviews the proposed commit.
- `autofix-with-approval`: a human reviews the exact commit before it is pushed.

`autofix-push-when-safe` is the only path where code can land without a human first.
Here, "safe" describes the requested change, not the mechanics of `git push`: the
continuing owner decides whether the feedback is reasonable, relevant, technically
sound, and appropriately scoped. When it is, the owner performs the complete coding
loop and delivers the result autonomously. When it is absurd, scope-exploding,
ambiguous, or insufficiently validated, the owner declines or escalates instead of
pushing.

The delivery operation still keeps ordinary mechanical guards: use the bound
managed worktree and linked PR head, require a clean committed change, refuse a
stale remote head or decreased mode, and never force-push. Those guards do not
replace the owner's engineering judgment or impose a repository-command allowlist.

## Keep These Existing Foundations

Reuse, rather than replace:

- deterministic PR polling, semantic event fingerprints, and watch controls;
- current GitHub fact readers and bounded comment/review/check payloads;
- managed worktrees and exact-head fetch/synchronization;
- Flue continuing-agent dispatch by stable instance id;
- a trusted repo-scoped coding workspace in the managed worktree, including normal
  file access and whatever repository commands the owner needs to inspect, edit,
  test, format, generate, compile, and commit;
- the existing diff viewer;
- the existing guarded `gitPushHead`/non-force push boundary;
- existing notification surfaces.

Do not route the new loop through legacy Autopilot admissions, stage attempts,
workflow chains, policy-bound prepared-diff objects, or recovery coordinators.

## Minimal Durable State

Store the Autopilot binding on the existing PR watch, or in one one-to-one watch
state record if the current schema makes that cleaner:

```text
pr
mode
owner_instance_id        nullable until the first non-notify actionable event
worktree_id              nullable until the first non-notify actionable event
last_event_fingerprint
status                   watching | working | waiting | blocked | complete
```

That is the logical schema. Do not add an admission table, stage-attempt table,
transition-event table, generation table, or separate durable prepared-diff table.

The durable artifacts already exist where they naturally belong:

- the Flue agent instance holds reasoning continuity;
- the managed worktree holds the code;
- a local commit holds a reviewable proposed change;
- GitHub holds pushed commits, reviews, checks, and responses;
- the watch holds the small amount of coordination state.

Use one conditional update to move an idle watch to `working`. That busy flag is the
same-PR overlap guard; it is not the beginning of a versioned transition framework.

## Mode Is A Delivery-Authority Ceiling

A mode is not merely text in the agent prompt, but it should not cripple the owner
as a coding agent. Every mode that prepares a change receives the same trusted
repo-scoped coding workspace rooted in the managed worktree. The owner may inspect
and edit files and run arbitrary repository commands such as tests, formatters,
typechecks, generators, and language-specific compilers. Commands are not limited
to a preconfigured `requiredChecks` list.

The hard capability boundary is external delivery:

| Mode                     | Agent turn | Workspace and delivery authority                                                                                                            |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `notify-only`            | No         | None; emit a notification only                                                                                                              |
| `prepare-only`           | Yes        | Full repo-scoped coding workspace and commit; no push or PR response                                                                        |
| `autofix-with-approval`  | Yes        | Watcher turn: full coding workspace and commit, but no push/response. A direct-human turn while waiting adds push and PR-response authority |
| `autofix-push-when-safe` | Yes        | Full coding workspace plus guarded push and PR response; the owner decides whether the requested change is sane enough to deliver           |

The coding environment must be rooted in the managed worktree and must not mutate
the primary checkout. Prefer a workspace/sandbox boundary that withholds GitHub and
push credentials from ordinary commands, while trusted application tools own the
bound push destination and PR response. Do not rebuild a per-command allowlist,
verification workflow, or language-specific command registry around the owner.

Choosing `autofix-push-when-safe` is the operator's grant of autonomous engineering
authority. The continuing owner's judgment—not a deterministic file-count,
line-count, file-class, or configured-check classifier—decides whether a particular
requested change is sane enough to deliver. Repository policy may choose the mode
and bound the destination, but the delivery tool must not second-guess the owner's
semantic decision with the retired diff-risk approval gates.

### The task-origin subtlety

A dispatched continuing Neon agent is addressed by `instanceId`, not by a workflow
`runId`. Consequently, `currentTaskOrigin()` reads the turn as interactive. Existing
`runId`-based origin checks in `neondeck_repo_commit` and `neondeck_repo_push` cannot
distinguish an Autopilot owner from a human interactive session.

Therefore:

- origin detection is not an Autopilot authority boundary;
- watcher-generated turns never receive delivery authority unless the mode is
  `autofix-push-when-safe`;
- in `autofix-with-approval`, only a direct human turn to an owner that is waiting
  for review receives push and PR-response authority; the operator's presence is the
  authority boundary, and the agent follows the actual message—plain approval pushes
  the held commit, while “fix this first, then push” may edit, validate, commit, and
  push in that same turn;
- `notify-only` does not dispatch a coding turn;
- delivery tools are rebuilt for every dispatch from current watch
  state and the known dispatch source (`watch-event` or `direct-human`), without
  relying on `currentTaskOrigin()`;
- the guarded autonomous-push tool re-reads the current mode immediately before pushing,
  because a mode decrease during a running turn must fail closed.

Prompts explain the mode, engineering judgment, and desired behavior. The workspace
provides normal coding capability; the delivery tool registry enforces who may push
or respond.

## The Poll And Turn Loop

For each watched PR:

1. Fetch current PR head, state, requested changes, unresolved/new feedback, and
   configured check facts.
2. If the PR is merged or closed, apply the terminal lifecycle below.
3. If the watch is `working`, do nothing. If it is `waiting`, keep the worktree
   steady and do not dispatch watcher events until the human approves, requests a
   revision, or discards the prepared change. Do not create an event queue.
4. Compare the meaningful current-event fingerprint with
   `last_event_fingerprint`.
5. If nothing meaningful changed, wait for the next poll.
6. In `notify-only`, notify, record the fingerprint, and keep watching.
7. Otherwise, ensure the watch has exactly one `owner_instance_id` and one managed
   `worktree_id`.
8. If the worktree has no unpublished prepared commit, fetch and synchronize it to
   the exact current PR head SHA.
9. Atomically change `watching` to `working`, attach the managed coding workspace
   and current mode's delivery tools,
   and dispatch one bounded turn to the recorded agent instance.
10. On success, record the handled fingerprint and return to `watching`, unless a
    prepared commit requires human attention; then set `waiting` and notify with a
    link to the worktree diff and continuing owner conversation.
11. On uncertainty or failure, set `blocked`, retain the worktree, and notify the
    user with the useful error and next action.
12. The next poll after a settled turn fetches fresh PR facts. An event that arrived
    while the agent was working is naturally observed then; no coalescing subsystem
    is required.

Never advance the fingerprint before an event is successfully notified, prepared,
or delivered. A blocked failure must not spin on every poll.

## Agent Turn Contract

Every turn is sent to the same `owner_instance_id` and includes current,
authoritative facts:

- repository and PR identity;
- managed worktree path and the fact that code is already checked out there;
- current PR head/base SHA and intended remote branch;
- new or changed feedback/check evidence and stable identifiers;
- current mode and the exact delivery authority available in this turn;
- repository instructions and useful configured command hints, without treating
  them as an exhaustive allowlist;
- prior local prepared-commit state, if any;
- an instruction to make the smallest justified change, commit it when a change is
  warranted, and report blockers rather than guess.

Current facts override stale facts in the conversation. Flue compaction may bound
model-visible context using the normal agent configuration; Neondeck does not build
a separate grounding cursor, snapshot, hash, or rotation protocol.

Ordinary feedback, commits, mode changes, or restarts reuse the same instance.
Replace an instance only through an explicit operator repair when it is actually
unavailable or corrupt.

## Worktree And Head Rules

- Create the managed worktree lazily at the exact current PR head.
- Reuse it for the life of the watch.
- Before a new agent turn, fetch and synchronize to the current exact PR head only
  when doing so will not overwrite an unpublished prepared commit.
- If a prepared commit exists and the remote PR head changes, do not overwrite or
  silently reset it from the watcher. Keep the owner `waiting`; the human can ask
  the managing agent to rebase, revise, discard, or explain the conflict.
- While an owner is `waiting`, watcher polls may observe PR state but cannot mutate
  or synchronize the worktree. This keeps the reviewed local commit steady until
  the human resolves it.
- Never edit the primary checkout.
- Never force-push.

The non-force push itself protects against a concurrently advanced remote branch.
If it is rejected, retain the local commit and notify rather than constructing an
automatic rebase/reconciliation state machine.

## Reviewable Change: A Commit, Not A Durable Effect Record

For `prepare-only` and `autofix-with-approval`, the agent's completed work is a
normal commit in the managed worktree.

That commit is the review artifact:

1. Read the worktree base and `HEAD`.
2. Render `git diff <base>…<HEAD>` in the existing diff viewer.
3. Present the exact `HEAD` SHA to the reviewer.

Do not create a separate prepared-diff object, verification-status state machine,
policy-hash-bound approval, or push-dispatch workflow.

### `prepare-only`

Notify the user and show the commit diff. Autopilot never receives or performs a
push in this mode.

### `autofix-with-approval`

Approval is another message in the continuing PR-owner conversation, not a separate
mechanism:

1. The agent commits the proposed change and says it is ready for review.
2. The watch enters `waiting`; the worktree is held steady and watcher events cannot
   start another turn or synchronize it.
3. The human reviews the on-demand worktree diff.
4. If satisfied, the human tells the same agent, for example, “Approved—commit and
   push.”
5. That direct-human turn retains the full coding workspace and receives push and PR
   response authority. A plain approval pushes the held commit as-is; a request such
   as “approved, but fix the typo first, then push” can edit, validate, commit, and
   push in that same turn.

The human message is the authority grant, and the durable Flue conversation records
the request, approval, and result. There is no approve action, approval row,
reviewed-SHA record, or push-dispatch workflow.

PR feedback can never impersonate approval: it enters through a `watch-event` turn,
which has no push tool in this mode. A direct human message is distinguishable at the
dispatch boundary and is the only waiting-mode turn that can receive push authority.

If the remote branch advanced while the worktree was held, the normal non-force push
fails. The agent can rebase with its coding workspace or explain the blocker, as it
would in a normal git session. This is not a race that needs an approval state
machine.

## Autofix Push When The Change Is Safe

`autofix-push-when-safe` is fully autonomous. "Safe" means the owner judges the
requested engineering change sane and sound. The owner must inspect the feedback in
repository context, reject or escalate unreasonable scope, choose proportionate
validation, and use its normal coding workspace to run whatever commands the repo
requires. A missing `requiredChecks` configuration is not itself a blocker and
running a fixed configured list is not a push precondition.

The owner should push only when it has enough evidence for the particular change.
For example, it may run focused tests during development and then the relevant
formatter, typecheck, compiler, or build before delivery. A repository with no test
suite may still receive a small sound fix; a risky change with no meaningful way to
validate should be escalated. This is model judgment recorded in the continuing
conversation, not a deterministic verification-status machine.

Immediately before delivery, the narrow push tool must only enforce mechanical
authority and race guards:

1. confirm the watch is still in `autofix-push-when-safe`;
2. confirm the managed worktree and intended linked PR destination;
3. confirm the worktree is clean and `HEAD` contains a committed change;
4. confirm the remote PR head still matches the expected head;
5. use the bound credential and non-force push path;
6. refuse when the mode, destination, credential, or head is uncertain.

On semantic doubt, the owner leaves the commit for review and explains why it did
not deliver. On mechanical doubt, the push tool blocks the external effect and
retains the worktree. Neither case creates another workflow or reconciliation
subsystem.

After a successful push, the agent may use its bounded PR-response tool to summarize
what changed and what checks ran.

## Retry, Restart, And Failure

Keep failure handling understandable:

- A failed turn becomes `blocked` and produces one notification.
- An explicit Retry control, a direct message to the managing agent, or a later
  meaningful PR event may
  move `blocked` back to `watching` after fetching current facts.
- Do not implement automatic multi-step backoff or a generalized retry classifier.
- Do not retry push or comment effects speculatively.
- After a Neondeck restart, a watch found in `working` becomes `blocked`; retain its
  instance and worktree and ask the user to retry after inspection.
- A failed comment does not undo a successful push.

Accepted limitation: a crash after an autonomous push succeeds but before Neondeck
records settlement also restarts as `blocked`. `autofix-push-when-safe` therefore
degrades to needs-human: the operator or managing agent inspects the remote and
decides whether to continue. Do not “fix” this accepted seam by reintroducing effect
journals, push reconciliation, stage attempts, or automatic delivery recovery.

This intentionally prefers a visible human decision over complicated autonomous
reconciliation.

## Terminal Lifecycle

Continue polling after a push. When the PR is merged or closed:

- if the configured merge checks are still running, keep watching;
- when required checks are green or terminal, set the watch `complete`;
- disable/remove the watch;
- archive the Flue owner instance;
- remove only the eligible Neondeck-managed worktree;
- retain a concise activity result for the user.

Cleanup failure is visible and manually retryable. It does not create another agent
instance or restart the watch.

## Setup And UX

One typed setup service is shared by chat, API, CLI, and dashboard:

```ts
type ConfigurePrAutopilotInput = {
  ref: string;
  mode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  processExisting: boolean;
};
```

The user must be able to say, “Put `owner/repo#123` on autopilot in prepare-only
mode,” and receive a truthful summary of the watch, mode, current-feedback choice,
and any missing readiness.

The dashboard needs only one row per watched PR with:

- mode;
- `watching`, `working`, `waiting`, `blocked`, or `complete` status;
- last meaningful activity;
- links to the PR, owner agent, worktree, and current diff when present;
- Pause, Resume, Retry, Review/Open Agent, and Stop. Approval itself remains a
  message in the owner conversation rather than a separate control contract.

Do not rebuild an admission queue, stage history, recovery-option matrix, or a
cross-table canonical state projection.

## Delivery History And Correction Plan

The reset and minimal replacement were deliberately delivered separately. The
semantic correction below is one focused follow-up; it must not reopen the removed
coordinator design.

### PR 1: carefully remove the abandoned engine — completed in #171

- Close unmerged PRs #169 and #170.
- Audit the actual patches from #164, #165, #167, and #168 before changing code. Do
  not assume they can be cleanly reverted as units.
- Prefer forward-deleting the admission/coordinator engine where a revert would
  entangle a foundation. Use a commit revert only for an isolated patch whose removal
  is proven not to remove retained behavior.
- Preserve the useful interleaved foundations identified by the audit:
  - from #165, complete GitHub feedback facts, semantic fingerprints, and exact-head
    worktree fetch/synchronization;
  - from #167, bounded noninteractive Git execution and the small readiness facts
    actually required at setup or safe push;
  - from #168, the continuing PR-owner agent definition and reusable instance,
    envelope, and capability seams where they are not coupled to the engine;
  - generic watch, worktree, diff-viewer, GitHub, Flue dispatch, and guarded-git
    behavior regardless of which PR introduced it.
- Remove coordinator/admission progression, stage attempts/events, intake generations,
  owner generations, grounding snapshots/cursors, queues/coalescing, submission
  leases, workflow observation continuation, and their operator queue projections.
- Remove or replace the abandoned schema in one deliberate migration decision:
  rewrite/squash only if those migrations have never shipped; otherwise retain
  migration history and add one forward cleanup migration.
- Update the HTML audit and roadmap so they do not direct future work back toward
  admissions or a coordinator.

Make the reset reviewable with checkpoint commits for each logical package removal.
After every checkpoint, run the build and the targeted foundation tests for plain
watches, GitHub facts/fingerprints, exact-head worktrees, bounded Git execution, Flue
dispatch, and the existing diff viewer. A checkpoint is not complete until those
foundations remain green.

Exit: main has no live admission/coordinator Autopilot path, retained foundations
still build and pass their targeted tests, and no replacement behavior has been
smuggled into the reset diff.

### PR 2: implement the complete minimal loop — completed in #172

#### Stage A: minimal watch ownership and setup

- Add the minimal watch state fields.
- Implement the shared setup/status/pause/resume/retry/stop service.
- Lazily create and persist one owner instance and worktree.
- Expose the natural-language setup path first, with thin CLI/dashboard adapters.

Exit: an explicit setup request creates a usable watch, and two restarts retain the
same owner/worktree identifiers without any admission records.

#### Stage B: one bounded owner turn and review flow

- Implement the poll/busy/fingerprint loop.
- Build mode-specific instructions and tool registries per turn.
- Dispatch feedback and CI facts to the same agent instance.
- Produce a committed worktree change for prepare/approval modes.
- Render the commit through the existing diff viewer.
- Hold the worktree steady while waiting. Give direct-human waiting turns the full
  coding workspace plus delivery authority while watcher turns remain unable to
  push.

Exit: two sequential feedback events reuse the same instance/worktree; a prepared
commit is reviewable without a prepared-diff database object; an explicit approval
message is recorded in the same conversation and pushes the held worktree.

#### Stage C: autonomous judgment, delivery, and terminal cleanup

- Add the narrow push and PR-response tools only to the autonomous watch turn and
  the direct-human approval turn.
- Give the owner a full repo-scoped coding workspace so it can choose and run the
  repository's appropriate validation commands.
- In autonomous mode, deliver sane, appropriately scoped changes without waiting
  for a human; retain and explain changes that the owner judges unreasonable or
  insufficiently validated.
- Keep mechanical push guards for the current mode, bound destination, clean commit,
  exact remote head, credential, and non-force push.
- Continue watching after delivery.
- Stop and clean up after merge/close and settled checks.

Exit: autonomous mode can complete the simple loop without human intervention when
the owner judges the request sound. Unreasonable scope, inadequate validation,
stale head, changed mode, or uncertain credentials produce no push. A
post-push/pre-settlement crash visibly blocks for human inspection rather than
starting automatic reconciliation.

PR #172 completed this structure, but implemented the owner with a configured-check
allowlist and interpreted “safe” as a mechanically verified push. That semantic
mistake is corrected by the follow-up below.

### Follow-up PR: trusted coding workspace and semantic autonomous mode

- Replace the owner’s bounded file/check-only surface with a trusted repo-scoped
  coding workspace rooted in the existing managed worktree.
- Permit ordinary repository commands without a `requiredChecks` allowlist,
  including tests, formatters, typechecks, generators, builds, and language-native
  tooling.
- Keep the primary checkout out of scope and keep push/PR credentials behind the
  mode-specific delivery tools.
- Remove configured-check execution from the push tool. Preserve only current mode,
  bound destination, clean committed `HEAD`, exact remote head, credential, and
  non-force guards.
- Remove deterministic diff-risk approval checks from this autonomous delivery path;
  selecting the mode delegates scope/soundness judgment to the continuing owner.
- Update the owner contract so autonomous mode evaluates whether feedback is sane,
  appropriately scoped, and sufficiently validated; deliver when it is, otherwise
  retain the work and explain/escalate.
- Update product wording and user docs so the autonomous meaning is unambiguous.

Exit: prepare and approval owners can run the same repository-native development
commands as the autonomous owner; only delivery authority differs. Autonomous mode
can implement, validate, commit, push, and respond without a configured-check list
when it judges the requested change sound, while stale-head and mode/destination
uncertainty still prevent delivery.

Run targeted tests during implementation. Add no integration test unless a unit
boundary cannot prove the workspace/delivery seam, and run proportionate final
verification once when the follow-up PR is ready for review.

## Focused Verification

During development, run targeted unit tests only. The required high-value tests are:

- every fixing mode can run arbitrary repo-scoped commands in the managed worktree,
  including representative Node and non-Node validation commands;
- each mode receives exactly its permitted delivery tools;
- an Autopilot `instanceId` appearing interactive cannot bypass the delivery ceiling;
- the busy flag prevents overlapping turns;
- two events reuse the same agent instance and worktree;
- work begins from the exact current PR head;
- an unpublished prepared commit is never overwritten;
- watcher feedback cannot obtain push/response authority in approval mode, while a
  direct human waiting turn does;
- a waiting-for-approval worktree remains unchanged until the human resolves it;
- autonomous mode does not require preconfigured checks and can use repository-native
  tests, formatters, typechecks, generators, and compilers selected by the owner;
- semantic uncertainty leaves the change for review, while mechanical uncertainty
  blocks the push;
- restart preserves bindings and turns an interrupted `working` state into a
  visible block;
- a crash after push but before settlement becomes a visible needs-human block and
  does not trigger automatic effect reconciliation;
- merged/closed plus settled checks stops the watch and cleans only its managed
  worktree.

Add at most one or two focused product-path integration tests if unit boundaries
cannot prove the real Flue dispatch and git-push seams. Do not rebuild the former
26-case acceptance suite.

## Explicitly Cut

The simplified implementation does not include:

- admissions or per-event durable workflow records;
- stage attempts or transition-event logs;
- the former 17-state transition graph;
- a central advancement coordinator or workflow-per-transition model;
- generalized retry, reconciliation, exponential backoff, or effect recovery;
- queued/coalesced same-PR events;
- generation management for routine instance rotation;
- grounding cursors, config/memory snapshots, envelope hashes, or CAS baselines;
- policy-hash-bound prepared diffs or approval records;
- approve actions, reviewed-SHA bookkeeping, or approval dispatch workflows;
- automatic rebase and stale-effect repair;
- a canonical operator admission queue or recovery-action matrix;
- general-purpose distributed workflow machinery.

It also does not include a per-command allowlist, language-specific check registry,
or deterministic verification-status machine for the trusted coding owner.

If a future production incident demonstrates that one omitted mechanism prevents a
real harmful race, add the smallest guard for that demonstrated consequence and a
focused regression test. Do not add machinery for hypothetical completeness.

## Acceptance Criteria

Autopilot is usable when:

- a user can configure it by asking Neondeck;
- meaningful PR feedback or failing checks task one continuing Neon agent;
- that agent knows the repository is checked out in its managed worktree and has
  current PR facts;
- ordinary later events reuse the same agent instance and worktree;
- every fixing mode has a normal repo-scoped coding workspace;
- the current mode and dispatch source determine push and PR-response authority;
- notify and prepare modes cannot push;
- approval is a direct message to the same managing agent; that human turn alone
  receives push authority and operates on the worktree held steady for review;
- autonomous mode judges whether feedback is sane and appropriately scoped, runs
  proportionate repository-native validation, and pushes without human approval when
  satisfied;
- absence of configured checks does not prohibit an otherwise sound autonomous fix;
- uncertainty leaves a reviewable local commit and notifies the user;
- new events are observed on the next poll without an event-coalescing subsystem;
- failures are visible and manually retryable;
- an autonomous post-push crash may require human inspection by design;
- a merged/closed PR with settled checks stops the watch and cleans its managed
  resources;
- the full behavior is proven by a small number of focused tests and described
  truthfully in the product surfaces.
