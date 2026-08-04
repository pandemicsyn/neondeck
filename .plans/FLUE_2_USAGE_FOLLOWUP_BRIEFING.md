# Flue 2 Usage Follow-Up Briefing

Status: briefing for post-migration planning

Created: 2026-08-02

Target runtime: Flue `2.0.1`

Primary references:

- [Flue agent hooks](https://flueframework.com/docs/guide/agent-hooks/)
- [Flue tools](https://flueframework.com/docs/guide/tools/)
- [Flue durability](https://flueframework.com/docs/guide/durability/)
- [Flue MCP](https://flueframework.com/docs/guide/mcp/)
- [Migration plan](./FLUE_2_MIGRATION_PLAN.md)

## Executive Summary

Neondeck is using Flue 2 correctly. The migration is complete, its correctness
hardening has passed the full repository verification gate, and the final
documentation-backed review found no remaining P1-P3 correctness issues.

The remaining opportunities are architectural cleanup rather than migration
blockers. They fall into three categories:

1. Remove internal network and synthetic-sandbox indirection that Flue 2 no
   longer requires.
2. Use immutable instance data and the root bounded-agent lifecycle more
   directly in PR review agents.
3. Clean up beta-era terminology and add small defense-in-depth bindings.

The correct ownership boundary remains:

- Flue owns model execution, accepted submissions, conversation history,
  instance-local state, model-facing resources, and short durable Tool
  sequences.
- Neondeck owns product scheduling, domain operations, SQLite state, memory and
  learning audit, security policy, GitHub state, and worktree recovery.

Do not move application orchestration or long-term memory into Flue merely to
make more of the implementation framework-owned.

## How Neondeck Uses Flue Today

| Concern                                           | Current owner                               | Assessment           |
| ------------------------------------------------- | ------------------------------------------- | -------------------- |
| Conversations and model turns                     | Flue agents and submissions                 | Correct              |
| Morning Briefing facts and runs                   | Neondeck SQLite                             | Correct              |
| Autopilot watches, worktrees, and delivery policy | Neondeck services and SQLite                | Correct              |
| Per-turn capability selection                     | Flue hooks plus trusted delivery state      | Correct              |
| Initial review execution                          | Bounded Flue agent and durable harness Tool | Correct but indirect |
| Session-local control state                       | Flue `usePersistentState()`                 | Correct              |
| Long-term memory and learning audit               | Neondeck SQLite                             | Correct              |
| Crash recovery for accepted model work            | Flue durability plus app reconciliation     | Correct              |
| Browser conversations                             | Flue React and SDK clients                  | Correct              |
| MCP authorization and approvals                   | Neondeck policy wrappers                    | Deliberate exception |

The implementation already uses the important Flue 2 primitives:

- `initialData` freezes instance identity and exact-review revisions.
- `useDelivery()` binds briefing and Autopilot turns to trusted delivery facts.
- `usePersistentState()` stores deliberate session snapshots and small recovery
  markers.
- `useAgentStart()` loads asynchronous context before model execution.
- `useAgentFinish()` enforces bounded review and Autopilot terminal behavior.
- Conditional `useTool()` and `useSandbox()` declarations control Autopilot
  capabilities by turn.
- `useDataWriter()` emits validated Morning Briefing data.
- Durable Tools checkpoint short review and delivery side-effect sequences.
- Flue submission events drive application settlement and observability.

The migration PR also completed one correctness-sensitive reviewer context
refactor discovered during dogfooding. Continuing-reviewer control policy is
now stable from the first render; mutable review facts arrive through a
bounded `review-context` signal during `useAgentStart()`. That snapshot now
includes the live GitHub review threads already shown by the review surface,
with explicit truncation metadata and the `headRefOid` returned by the same
GitHub query. Neondeck rejects head changes during pagination and marks every
snapshot as exact, mismatched, or unverified before the reviewer may correlate
thread anchors with the exact-revision workspace. Deferred workspace Tools
resolve only that local workspace and do not reload the live intake context.
The configurable follow-up prompt now exposes stable delivery-guidance tokens,
while mutable facts arrive only through the signal. A mounted Flue faux-provider
test verifies first-turn delivery, refresh on the next question, and the absence
of reserved `instructions` churn. This completed correction is separate from
the opaque-id and bounded-root architecture work below.

## Remaining Recommendations

| Priority   | Recommendation                                                                                    | Nature                        |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| Medium     | Replace internal loopback SDK calls with direct Flue dispatch                                     | Quick architectural cleanup   |
| Medium     | Give continuing reviewers opaque ids plus immutable `initialData`                                 | Instance-identity cleanup     |
| Medium-low | Remove synthetic reviewer sandboxes and conditionally mount the display scratch sandbox           | Capability-surface reduction  |
| Low        | Let the bounded root review agent perform the review directly and terminate through a submit Tool | Agent-shape simplification    |
| Low        | Add stable repo and PR identity to Autopilot owner `initialData`                                  | Defense in depth              |
| Low        | Rename beta-era run, dispatch, and workflow-summary vocabulary                                    | Mechanical conceptual cleanup |

### 1. Replace Internal Loopback HTTP With Direct Dispatch

Current behavior:

- `src/modules/sessions/approval-nudges.ts` creates a Flue SDK client pointed at
  Neondeck's own loopback HTTP listener.
- Delivery depends on the listener port, URL construction, and local API token
  configuration even though the caller and target agent are in one process.

More Flue-native behavior:

- Call `dispatch(DisplayAssistant, { id, message })` directly.
- Use `init(DisplayAssistant, { id })` when the caller benefits from a handle
  that can dispatch, read, or wait.
- Keep the SDK client for browser and genuinely external callers.

Benefit:

- Removes listener-port and token coupling from an internal operation.
- Reduces failure modes and makes the process boundary explicit.

Recommendation: implement as a small standalone cleanup.

### 2. Use Opaque Continuing-Reviewer Ids And Immutable Initial Data

Current behavior:

- `src/agents/pr-reviewer.ts` parses `reviewId` and `headSha` from the Flue
  conversation id.
- The routing id therefore doubles as an application data format.

More Flue-native behavior:

- Give `PrReviewer` an `initialData` schema containing `reviewId` and
  `headSha`.
- Precreate the reviewer instance with an opaque conversation id and
  create-only initial data.
- Hand the opaque conversation id to the dashboard after bootstrap.

Benefit:

- Flue validates the immutable binding when the instance is created.
- An existing instance cannot silently be rebound.
- Routing identity is separated from application identity.
- Agent code no longer parses application data out of ids.

Recommendation: combine with the bounded-review simplification so reviewer
bootstrap and UI handoff change only once.

### 3. Reduce Unnecessary Sandbox Capability

Current behavior:

- `DisplayAssistant` always receives an in-memory filesystem and Bash sandbox.
- PR review agents receive a synthetic `noWorkspace()` sandbox even though
  their repository access comes from exact-revision read-only Tools.

More Flue-native behavior:

- Omit `useSandbox()` entirely from reviewer agents.
- Audit whether display utility or subagent behavior needs scratch files.
- Attach the display scratch sandbox only for a delivery or feature that has a
  concrete requirement for it.

Benefit:

- Removes generic file and shell tools from turns that do not need them.
- Reduces prompt/tool-catalog size and the chance of irrelevant scratch work.
- Removes instructions explaining that the scratch filesystem is not the host
  repository.

Tradeoff:

- Confirm no display subagent or utility path implicitly relies on the
  in-memory scratch environment before making it conditional.

Recommendation: remove reviewer sandboxes first, then narrow the display
sandbox after the dependency audit.

### 4. Simplify The Bounded Initial-Review Agent — Completed 2026-08-03

Current behavior:

1. The root `PrReviewAssistant` model is instructed to call one empty-input
   Tool.
2. The durable harness Tool launches the actual structured review prompt with
   exact-revision workspace Tools.
3. The harness Tool persists artifacts and settles the review.

Dogfooding showed that this was a correctness issue in practice: the nested
prompt had an independent 300-second deadline and its timeout could be recorded
as the durable result of the model-generation step, leaving the review unable
to recover.

More direct Flue shape:

1. Mount the exact-revision read-only Tools on `PrReviewAssistant` itself.
2. Let the bounded root agent perform the review.
3. Mount one schema-backed, terminating `submit_pr_review` Tool.
4. Use `useAgentFinish()` to require either a submitted result or an explicit
   failed/unavailable outcome.
5. Keep the submit Tool durable for report creation, draft seeding,
   settlement, notifications, and learning evidence.

Benefit:

- Removes a redundant model-routing layer.
- Produces a simpler and more inspectable conversation trace.
- Makes the agent's tools and terminal contract visible at the root lifecycle.

Implemented result:

- prepared facts, learning context, model policy, and exact-revision workspace
  binding are frozen before admission in validated `initialData`
- `useAgentStart()` appends the prepared evidence as untrusted conversation
  data before the first model turn; evidence is not promoted into system
  instructions
- exact-revision workspace Tools are mounted directly on the bounded root
  reviewer with a persistent call budget
- `neondeck_submit_pr_review` accepts the structured schema directly, performs
  durable application effects, and terminates the response
- `useAgentFinish()` provides bounded correction when the model omits or
  miscalls the submit Tool, avoids fallible post-success reads, and accepts
  recovery state only for the exact admitted attempt/revision
- the attempt and exact revision are revalidated immediately before mutation
- the whole initial-review submission now has a 30-minute default/ceiling
  instead of a nested five-minute model timeout

### 5. Enrich Autopilot Owner Initial Data

Current behavior:

- The Autopilot owner freezes only `watchId` in `initialData`.
- Repo, PR, revision, mode, capabilities, and event identity arrive through a
  trusted delivery envelope and are checked against the persisted reserved
  turn.

The current checks are already strong.

Possible enhancement:

- Also freeze stable `repoId`, `repoFullName`, and `prNumber` fields in
  `initialData`.
- Keep `headSha`, `baseSha`, mode, capabilities, event fingerprint, and
  approval state delivery-scoped because they change from turn to turn.

Benefit:

- Makes the continuing instance self-describing.
- Adds defense against accidental cross-watch or cross-PR reuse.

Recommendation: add opportunistically when owner instance creation is next
modified.

### 6. Rename Beta-Era Vocabulary

Current behavior retains names such as:

- `dispatchId` when the value is a Flue `submissionId`.
- `runId` for either an application operation or submission correlation.
- `workflowSummary` and `workflow_summaries` for app-owned operation summaries.

Nothing behaves incorrectly, but the names imply removed Flue workflow
concepts and make ownership harder to understand.

Target vocabulary:

- `submissionId` only for Flue submissions.
- `operationId` or a domain-specific id for Neondeck work.
- `operationSummary` for app-owned summaries.
- `workflow` only for a product process where the generic term is intentional,
  not for a removed Flue runtime primitive.

Recommendation: complete before Neondeck has external consumers. Keep it in a
mechanical cleanup phase with a database migration, adapter updates, static
symbol scans, and focused regression tests.

## Deliberate Non-Adoptions

### Keep Product Orchestration In Neondeck

Morning Briefing runs, scheduled tasks, watches, review attempts, learning
decisions, and Kilo operations need product-specific inspection, policy,
reconciliation, and audit. They should remain application-owned.

Use a Flue durable Tool only for a short checkpointed sequence inside one agent
turn. Do not rebuild a general workflow engine from durable Tool steps.

### Keep Long-Term Memory In Neondeck

Flue persistent state is appropriate for compact per-instance state such as a
context snapshot, phase, counter, or recovery guard. It is not a replacement
for cross-session memory scopes, candidates, archives, audit events, or skill
patch history.

### Keep MCP Behind Neondeck Policy

Direct `useMcpConnection()` mounting would be simpler, but it would bypass or
weaken Neondeck's:

- frozen per-session MCP catalog;
- allow/ask/deny gate;
- consumable, argument-specific approvals;
- OAuth and secret boundaries; and
- application-owned audit history.

A future experiment may use `createMcpConnection()` as the transport and
discovery adapter, then filter or wrap its returned Tools behind Neondeck
policy before mounting them. Do not switch directly to unrestricted native MCP
mounting for architectural neatness.

## Suggested Delivery Sequence

### Follow-Up A: Quick Capability Cleanup

- Replace approval-nudge loopback HTTP with direct dispatch.
- Remove reviewer `noWorkspace()` sandboxes.
- Audit scratch-environment consumers and conditionally mount the display
  sandbox.

Exit criteria:

- Internal approval delivery does not require the HTTP listener or API token.
- Review agents expose no generic filesystem or shell Tools.
- Display turns without a scratch requirement expose no sandbox Tools.

### Follow-Up B: Reviewer Architecture

- [ ] Bootstrap continuing reviewers with opaque ids and immutable initial
      data.
- [x] Mount exact-revision Tools directly on the bounded initial-review agent.
- [x] Replace the empty-input harness indirection with a terminating structured
      submit Tool.
- [x] Preserve the durable, idempotent, and abort-safe artifact path.
- [x] Add real Flue lifecycle coverage proving workspace exploration and one
      root structured submission without a nested model operation.

Exit criteria:

- Reviewer ids are opaque and application bindings come from validated initial
  data.
- One bounded root model execution performs the initial review.
- Exact revision and current durability regression suites remain green.

### Follow-Up C: Terminology And Defense In Depth

- Rename workflow, run, and dispatch compatibility vocabulary.
- Enrich Autopilot owner immutable identity.
- Optionally prototype a policy-wrapped `createMcpConnection()` adapter.

Exit criteria:

- Flue submission ids and Neondeck operation ids are unambiguous across schema,
  services, APIs, UI, tests, and docs.
- Autopilot stable instance identity includes its bound repo and PR.
- Any MCP experiment demonstrably preserves current authorization and audit
  behavior before adoption.

## Recommendation

Do Follow-Up A first. It is small, lowers capability and process coupling, and
does not reopen the migration's correctness-sensitive orchestration.

Plan Follow-Up B as one coordinated reviewer change. Follow-Up C can proceed as
mechanical cleanup before the first external release, with MCP remaining an
optional experiment rather than a migration requirement.
