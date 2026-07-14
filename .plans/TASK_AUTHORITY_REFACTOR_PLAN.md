# Task Authority Refactor Plan

Status: proposed

Related:

- `.plans/ROADMAP.md` Phases 14, 19, and 20
- `.plans/AUTOPILOT_LOOP_WIRING_PLAN.md`
- `.plans/REPO_EDITING_PLAN.md`
- `.plans/EXEDEV_WORKSPACE_MODE_PLAN.md`

## Purpose

Refactor Neondeck's code-changing task model so that a direct user instruction
and an unattended watcher decision are treated as fundamentally different
sources of authority.

A watch is an observation subscription. Autopilot is permission for Neondeck
to initiate work from observed events. A direct instruction in an interactive
session is user-granted authority for a specific task. Linking a session to a
watched repository or PR should provide context, but it should neither grant
autopilot authority nor restrict an explicitly requested task.

The target experience is:

- “Explain this reviewer feedback” reads facts and explains them.
- “Draft a fix” edits and verifies in an isolated worktree, but does not
  deliver the change.
- “Implement/address this reviewer feedback” performs the ordinary work needed
  to update the linked PR when repo policy allows interactive delivery.
- A passive watch continues to notify only.
- A PR explicitly placed on autopilot follows its configured unattended mode.
- Approvals represent meaningful scope expansion or external risk, not the
  spelling of internal Git and shell commands.

## Problem Statement

The current system uses “autopilot policy” for more than unattended initiative.
Repo policy is consulted inside review-fix behavior even when work was requested
interactively. Generic host execution approval is then used as a fallback for
routine Git mechanics. This creates several product and architecture problems:

1. A `notify-only` watch can be interpreted as forbidding work the user just
   requested explicitly.
2. A user can approve a raw command that the executor will reject anyway, such
   as a command containing `&&`.
3. Exact command approval does not survive harmless retries or rewritten commit
   messages, so one logical task can create many approval requests.
4. Approval resolution nudges the continuing agent, but the durable workflow
   does not own a resumable task grant. The agent must reconstruct the retry.
5. Prepared diffs, worktrees, workflow runs, approvals, and session context are
   correlated indirectly instead of belonging to one durable task.
6. The Runtime approval audit surface has become part of the normal product
   path instead of an escalation and diagnostics surface.

This is not solved by broadly preapproving more command strings. Routine repo
work should use typed, scope-aware capabilities. Generic host execution should
remain available for genuinely arbitrary commands and should retain its
hardline safety boundary.

## Product Model

### Observation, initiative, authority, and execution are separate concepts

```text
manual user instruction ──> interactive task grant ─┐
                                                    ├─> shared task workflow
watch event ──> autopilot admission ──> task grant ─┘
                                                              │
                              worktree → edit → commit → verify → deliver
```

- **Observation** answers what Neondeck knows about: a repo, PR, watch, review,
  CI result, schedule, or session link.
- **Initiative** answers who decided that work should start: the user, a watch,
  a schedule, a delegated worker, or a recovery action.
- **Authority** answers what outcome that initiator is allowed to pursue for
  this task.
- **Guardrails** constrain all tasks using objective repo and risk policy.
- **Execution** is the typed action or bounded workflow used to do the work.
- **Escalation** is required only when the task exceeds its granted authority or
  crosses a protected boundary.

### Task origins

Introduce a first-class origin on every code-changing task:

```ts
type RepoTaskOrigin =
  | 'interactive'
  | 'autopilot'
  | 'scheduled'
  | 'delegated'
  | 'recovery';
```

Origin is durable provenance, not a display-only label. It determines which
admission policy may grant authority.

| Origin | Admission source | Expected behavior |
| --- | --- | --- |
| `interactive` | Explicit user message or user-owned UI action | Execute the requested outcome within the linked task scope. |
| `autopilot` | Watch event plus repo/watch autopilot policy | Act only to the configured unattended mode. |
| `scheduled` | Enabled schedule plus schedule task policy | Run only the declared scheduled operation. |
| `delegated` | Parent task grant plus delegation policy | Cannot exceed the parent task’s scope or authority. |
| `recovery` | Explicit recovery action | Run only the selected bounded recovery operation. |

### Requested outcomes

Use outcome semantics rather than inferring authority from individual tools:

```ts
type RepoTaskOutcome = 'inspect' | 'prepare' | 'deliver';
```

- `inspect`: gather and explain facts; no repo mutation.
- `prepare`: edit in an isolated worktree, commit when appropriate, run
  configured checks, and retain a prepared result without remote delivery.
- `deliver`: perform `prepare`, then update the linked PR/branch and post the
  configured result communication when delivery guardrails pass.

For a PR-linked interactive session, recommended language semantics are:

- “explain”, “investigate”, “review” → `inspect`
- “draft”, “propose”, “prepare”, “do not push” → `prepare`
- “implement”, “fix”, “address”, “update the PR” → `deliver`

The agent must pass the selected outcome and the originating user event id to a
typed task action. The task card should make that interpretation visible. Repo
configuration can choose the conservative fallback for ambiguous language, but
should not force an additional approval after an unambiguous explicit request.

### Capabilities

A task grant should contain typed capabilities scoped to the task:

```ts
type RepoTaskCapability =
  | 'repo:read'
  | 'repo:edit'
  | 'worktree:create'
  | 'worktree:sync'
  | 'worktree:commit'
  | 'checks:configured'
  | 'pr:push-linked-head'
  | 'pr:comment-result';
```

Each grant is bounded by `repoId`, optional `prNumber`, `sessionId`,
`worktreeId`, task id, allowed push destination, and lifetime. The grant expires
when the task reaches a terminal state or is abandoned.

`git add`, `git commit`, `git push`, and concrete check command strings are
implementation details behind these capabilities. They remain audited but are
not separate interactive approval boundaries when a typed action is operating
within the grant.

## Policy Separation

### Watch policy

Watching means “observe this PR and report meaningful changes.” Adding a watch
must not itself enable code-changing initiative.

Watch records continue to own event watermarks, notification behavior, and
event reconciliation. They provide context to linked sessions and may be used
as an input to autopilot admission.

### Autopilot policy

Autopilot policy applies only when `origin === 'autopilot'`:

- `notify-only`: do not create a code-changing task.
- `prepare-only`: admit a task with outcome `prepare` and no delivery
  capability.
- `autofix-with-approval`: admit a `prepare` task and create one task-level
  delivery escalation after checks pass.
- `autofix-push-when-safe`: admit a `deliver` task when all shared guardrails
  allow it.

Repo-level defaults and per-watch/PR overrides remain useful, but must no longer
govern interactive task admission.

### Interactive task policy

Add a separate per-repo interactive policy. The exact config schema should be
validated during implementation, but it needs to express at least:

```ts
type InteractiveRepoPolicy = {
  ambiguousOutcome: 'prepare' | 'deliver-linked-pr';
  allowManagedWorktreeEdits: boolean;
  allowLocalCommits: boolean;
  allowConfiguredChecks: boolean;
  allowPushToLinkedPr: boolean;
  allowResultComments: boolean;
};
```

Recommended policy for trusted personal repos:

- allow managed-worktree edits, local commits, and configured checks
- interpret explicit “implement/fix/address” requests as delivery requests
- allow ordinary push to the already-linked PR head
- keep force-push, alternate destinations, destructive Git operations, and
  trust-boundary changes outside the grant

Interactive policy is not permission for the agent to initiate work. It defines
how much of an explicit request can be fulfilled without asking the user to
approve its mechanical substeps.

### Shared guardrails

Both interactive and autonomous tasks must use the same objective constraints:

- declared repo and managed-worktree boundaries
- denied paths and approval-required paths
- max file and line limits
- high-risk file classification
- required checks
- allowed push destinations
- GitHub branch permissions
- no force-push by default
- credential and secret boundaries
- concurrency and one-mutation-per-PR locking

The response to a guardrail differs by origin:

- Autopilot cannot expand its own authority. It stops or requests a task-level
  escalation.
- An interactive task may request one explicit scope expansion tied to the
  original task.
- Hardline denies remain denies regardless of origin.

## Durable Task Domain

### Persistence

Add app-state tables using the existing migration workflow.

`repo_tasks` should include:

- id
- origin
- requested outcome and currently authorized outcome
- repo id, PR number, session id, and originating session event id
- watch id, schedule id, parent task id, or recovery source id when applicable
- worktree id and prepared diff id
- workflow name and Flue run id
- status
- grant/capability JSON
- risk and guardrail summary JSON
- requested-at, started-at, updated-at, and terminal timestamps
- compact user-visible summary and last error

Suggested task states:

```ts
type RepoTaskStatus =
  | 'requested'
  | 'admitted'
  | 'running'
  | 'needs-input'
  | 'needs-approval'
  | 'prepared'
  | 'delivering'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'abandoned';
```

`repo_task_events` should record compact state transitions, capability use,
workflow linkage, risk changes, approval linkage, and terminal outcomes.

Existing `worktrees`, `prepared_diffs`, workflow summaries, notifications,
Kilo tasks, and approvals should gain nullable `task_id` linkage rather than
being replaced in the first migration.

### Authority resolver

Add one domain service that computes an effective task grant:

```text
origin admission
  ∩ requested outcome
  ∩ interactive/autopilot/schedule/delegation policy
  ∩ repo guardrails
  ∩ workspace boundary
  ∩ credential and branch permissions
= effective task grant
```

The resolver should return structured reasons and required escalations. No
agent prompt or UI client should recreate this logic.

### Idempotency

- Interactive task creation is idempotent by originating session event id.
- Watcher task creation remains idempotent by admission/event fingerprint.
- Delegated work is idempotent by parent task plus delegation id.
- Only one active mutation task may own a PR/worktree lock by default.
- Retrying a workflow resumes the same task and grant.
- Prepared-diff refresh supersedes the previous snapshot while retaining audit
  history and task identity.

## Workflow Architecture

### Shared task workflow

Manual and autonomous paths should converge after task admission:

1. Create or adopt a managed worktree.
2. Acquire the task/PR mutation lock.
3. Fetch deterministic repo, PR, review, and check facts.
4. Plan and apply changes through repo-edit actions.
5. Evaluate the resulting diff against shared guardrails.
6. Commit through the app-owned Git service and the task’s
   `worktree:commit` capability.
7. Run configured checks through typed check definitions.
8. Recompute risk and effective delivery authority.
9. Deliver, request one task-level escalation, or retain a prepared result.
10. Post the configured result comment, release the lock, and close the task.

Flue workflows should remain finite, inspectable work units. The continuing
display-assistant agent owns the conversation, while app state owns the durable
task and Flue owns workflow execution history.

### Manual session path

Add a typed action such as `neondeck_repo_task_start` that accepts:

- origin `interactive`
- originating session/event identity
- repo/PR context
- requested outcome
- user-request summary
- optional structured reviewer/check target

It creates the task grant and invokes the appropriate bounded workflow. Manual
reviewer-fix behavior must not pass through watcher admission or consult
autopilot mode to decide whether the task may exist.

### Watcher path

The watcher continues to detect and reconcile events. Its autopilot admission
step creates a task only when the effective repo/watch mode permits it. Once
created, that task uses the same task workflow and shared guardrails as an
interactive task.

### Typed execution first

Routine operations must use app-owned services:

- file reads and edits through repo-edit
- worktree lifecycle through worktree services
- selected-path staging and commits through repo-edit Git services
- configured checks through named repo check definitions
- linked-branch push through the PR delivery service
- result comments through the GitHub service

Generic `neondeck_execution_run` remains for commands that do not map to typed
task capabilities. It must not be the normal implementation path for commit,
push, or configured verification inside a managed task.

## Approval And Escalation Model

### What requires escalation

Create a task-level escalation only when one of these occurs:

- the task needs an outcome beyond the user or autopilot grant
- the diff enters a configured high-risk class
- the task needs a denied-by-default operation that policy permits a user to
  override
- delivery targets something other than the linked PR head
- a new dependency, migration, CI/deployment change, credential operation, or
  destructive Git operation is required
- an arbitrary host command is required outside configured task capabilities

### What does not require escalation

Do not request approval for:

- ordinary reads and edits inside the task’s managed worktree
- staging paths changed by the task
- creating the task’s local commit
- running configured checks
- retrying an idempotent task step
- changing the wording of a commit message
- pushing to the linked PR head when an interactive `deliver` grant or safe
  autopilot grant already includes that effect

### Approval identity

Approvals attach to task id, requested capability/scope expansion, policy hash,
and relevant commit/diff identity. They do not attach primarily to raw command
text.

Requirements:

- dedupe identical pending escalations
- automatically supersede obsolete requests after task/diff changes
- resume the owning task/workflow directly after resolution
- never create an approval for an operation the executor will structurally
  reject
- preserve exact user, dashboard, API, or policy provenance
- support “allow for this task” and explicit durable repo-policy changes as
  separate decisions

Execution approvals remain a separate lower-level mechanism for arbitrary host
commands. An execution approval must link to the task when one exists, and a
command rewrite must not silently become a new task-level scope request.

## Dashboard And Chat UX

### Task-first interaction

Add an operator-visible task card/timeline showing:

- origin and who initiated it
- repo, PR, worktree, and session
- requested and authorized outcome
- current phase
- files changed and risk summary
- checks and delivery state
- one clear escalation when needed

Normal interactive work should be controlled in the linked chat/task context.
Runtime remains the audit, policy, and debugging surface.

### Surface separation

- **Watches**: observation state and meaningful deltas.
- **Autopilot**: unattended task admission, autonomous queue, prepared results,
  and delivery decisions.
- **Chat/task card**: user-requested work, progress, and relevant escalation.
- **Runtime**: execution audit, raw approvals, safety policy, and failures.

An interactive task on a watched PR may be referenced from Autopilot for shared
worktree visibility, but it must be labeled `interactive` and must not appear as
an autonomous decision.

### Escalation copy

Ask about effects and scope, not internal commands.

Good:

> This reviewer fix now needs to update `package-lock.json` and install a new
> dependency. Allow that expansion for this task?

Bad:

> Approve `git add ... && git commit ...`?

## Configuration Direction

Keep the current `autopilot` config for unattended initiative, but move shared
risk limits into a clearly shared policy layer over time. Add an `interactive`
repo policy rather than overloading autopilot modes.

Conceptual shape:

```json
{
  "interactive": {
    "ambiguousOutcome": "prepare",
    "allowManagedWorktreeEdits": true,
    "allowLocalCommits": true,
    "allowConfiguredChecks": true,
    "allowPushToLinkedPr": true,
    "allowResultComments": true
  },
  "autopilot": {
    "mode": "notify-only"
  },
  "guardrails": {
    "allowForcePush": false,
    "allowedPushDestinations": ["pull-request-head"]
  }
}
```

This is illustrative, not a committed schema. Preserve compatibility with
existing `metadata.autopilot.limits` while migrating shared limits through
typed config actions.

## Implementation Phases

Each phase should land as a focused change with `npm run check`, relevant
integration tests, and `npm run db:check` when migrations change.

### Phase 0 — Specify invariants and instrument origin

- [ ] Document the distinction between watch, autopilot, interactive tasks,
  guardrails, and execution approvals in README/runtime guidance.
- [ ] Add an origin field to relevant workflow inputs, summaries, and audit
  events without changing behavior.
- [ ] Measure approval count, duplicate approvals, blocked-after-approval
  operations, retries, and completion latency by logical task/session/PR.
- [ ] Add regression coverage proving that unsupported shell commands cannot
  create actionable approval requests.

### Phase 1 — Add the durable task domain

- [ ] Add `repo_tasks` and `repo_task_events` migrations and schemas.
- [ ] Implement task create/read/list/transition services with idempotency.
- [ ] Link worktrees, prepared diffs, workflow summaries, notifications,
  execution approvals, and Kilo tasks to task ids where applicable.
- [ ] Add task lookup APIs/tools for chat, dashboard, and future TUI use.
- [ ] Keep existing APIs compatible while task linkage is nullable.

### Phase 2 — Split authority resolution from autopilot policy

- [ ] Implement the shared task authority resolver.
- [ ] Add typed interactive repo policy config and update actions.
- [ ] Restrict autopilot mode checks to autopilot-origin admission and delivery.
- [ ] Preserve shared limits/guardrails across origins.
- [ ] Add policy explanations that state origin, grant, constraint, and required
  escalation separately.

### Phase 3 — Build the interactive task path

- [ ] Add `neondeck_repo_task_start` and the matching service/API.
- [ ] Route explicit reviewer-fix and CI-fix requests into interactive tasks.
- [ ] Treat the originating user event as the grant provenance.
- [ ] Select/create the linked PR worktree without watcher admission.
- [ ] Use typed repo-edit, Git commit, configured-check, and delivery services.
- [ ] Ensure `notify-only` does not block an interactive task.

### Phase 4 — Converge watcher autopilot on the shared task engine

- [ ] Make watcher admissions create autopilot-origin tasks.
- [ ] Map existing modes to task outcomes and capabilities.
- [ ] Preserve watcher event idempotency and same-PR concurrency behavior.
- [ ] Link existing prepared-diff push approvals to task-level delivery
  escalation.
- [ ] Keep passive watches notification-only.

### Phase 5 — Refactor approvals and resumption

- [ ] Add task-scoped escalation records or extend prepared-diff approvals with
  task scope and capability semantics.
- [ ] Dedupe/supersede stale approvals and reconcile existing duplicates.
- [ ] Resume the owning workflow directly after approval.
- [ ] Validate structural executability before requesting execution approval.
- [ ] Keep arbitrary host execution approval strict and separately auditable.
- [ ] Remove generic shell fallback for routine managed-task commit and push.

### Phase 6 — Deliver task-first UX

- [ ] Add interactive task cards/timeline to linked chat.
- [ ] Add task origin and requested/authorized outcome to operator views.
- [ ] Keep unattended tasks in Autopilot and execution details in Runtime.
- [ ] Deep-link notifications to the owning task and relevant escalation.
- [ ] Make approval controls visually accurate and show ids/scope in audit
  views.
- [ ] Add typed UI controls for per-repo interactive behavior and per-PR
  autopilot enrollment.

### Phase 7 — Migrate, document, and remove compatibility paths

- [ ] Backfill task linkage where reliable; leave unverifiable historic records
  unlinked rather than inventing provenance.
- [ ] Update the built-in Neondeck runtime skill and display-assistant guidance.
- [ ] Update README and operator documentation with the new mental model.
- [ ] Remove manual-review code paths that directly consult autopilot admission.
- [ ] Remove obsolete approval retry/nudge behavior after all task workflows are
  resumable.
- [ ] Record all roadmap deviations and deferred items in
  `.plans/DEVIATIONS.md` during implementation.

## Acceptance Scenarios

### Manual request on a passive watch

Given a PR is watched with `notify-only`, when the user says “implement this
reviewer suggestion” in its linked session:

- one interactive task is created
- the watch mode is shown as context but is not consulted for task admission
- a managed worktree is used
- the change is edited, committed, and checked through typed capabilities
- the linked PR is updated when interactive delivery policy permits it
- no Git execution approval is created
- any required escalation is task-scoped and appears once

### Passive watch event

Given the same PR is `notify-only`, when a new reviewer comment arrives without
a user instruction:

- Neondeck updates watch state and notifies
- no code-changing task or worktree mutation begins

### Autofix with approval

Given the PR is explicitly configured as `autofix-with-approval`, when a bounded
review event arrives:

- one autopilot-origin task prepares, commits, and verifies the fix
- one delivery escalation is created after checks pass
- approval resumes that task and completes delivery
- no raw Git execution approvals are created

### Safe auto-delivery

Given `autofix-push-when-safe` and a low-risk diff that passes all guardrails:

- the task prepares and delivers without user interaction
- the audit trail identifies watcher admission and policy authority

### Meaningful interactive scope expansion

Given an interactive reviewer fix unexpectedly needs a dependency change:

- routine work does not generate approvals
- one task-level request explains the dependency and lockfile expansion
- approval applies to that task scope and resumes the same workflow

### Arbitrary execution fallback

Given a task requires an undeclared diagnostic command:

- one execution escalation links to the task
- approval resumes the same task step
- duplicate retries do not create duplicate requests
- structurally unsupported commands are rejected before approval creation

## Verification Strategy

- Unit tests for origin-aware authority resolution and policy intersections.
- Migration and schema tests for task/event linkage.
- Integration tests for interactive, autopilot, scheduled, delegated, and
  recovery task origins.
- Fixture-backed Flue smoke tests for task creation, workflow resumption,
  prepared-diff refresh, delivery, and terminal cleanup.
- UI tests for task cards, origin labels, inline escalation, deep links, and
  duplicate suppression.
- Regression tests for shell-operator approval loops, exact-command rewrite
  churn, stale prepared diffs, and duplicate watcher/manual work on one PR.
- Full `npm run verify` before completing the final migration phase.

Primary usability metric:

> A normal explicit reviewer-fix request on a trusted linked PR completes with
> zero mechanical execution approvals. An unattended `autofix-with-approval`
> task requires at most one meaningful delivery approval.

## Recommended Decisions

1. Watching and autopilot enrollment remain separate operations.
2. Linking session context never changes task authority by itself.
3. Explicit “implement/fix/address” language on a linked PR requests delivery;
   “draft/prepare/do not push” requests a retained prepared result.
4. Managed-worktree edit, commit, and configured checks are ordinary task
   capabilities, not shell approvals.
5. Interactive delivery to the already-linked PR head is configurable per repo
   and enabled for trusted personal repos.
6. Autopilot policy governs only unattended initiative and autonomous delivery.
7. Shared guardrails remain origin-independent and hardline denies remain hard.
8. Approvals represent capability or scope expansion and resume a durable task.
9. Flue workflows own bounded execution; the display assistant owns the
   conversation; Neondeck app state owns durable task authority and audit.

## Non-Goals

- Do not provide unrestricted shell access to interactive agents.
- Do not make watching a PR equivalent to enabling autopilot.
- Do not allow an autonomous task to approve its own scope expansion.
- Do not bypass hardline denies, credential boundaries, or branch permissions.
- Do not replace Flue workflow/run persistence with app-state task persistence;
  link them and keep their responsibilities distinct.
- Do not require every repo operation to become a single giant workflow. Tasks
  may coordinate several bounded workflows while retaining one grant and audit
  identity.
- Do not infer or backfill authority that was not recorded for historic work.
