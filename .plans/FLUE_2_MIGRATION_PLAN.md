# Flue 2 Migration Plan

Status: migration and Flue 2 correctness hardening complete
Integration branch: `flue2`  
Created: 2026-08-01  
Target Flue release at planning time: `2.0.1`

Primary references:

- [Flue 2 migration guide](https://flueframework.com/docs/guide/migration/)
- [Agents](https://flueframework.com/docs/guide/building-agents/)
- [Agent hooks](https://flueframework.com/docs/guide/agent-hooks/)
- [Tools](https://flueframework.com/docs/guide/tools/)
- [Workflows](https://flueframework.com/docs/guide/workflows/)
- [Durability](https://flueframework.com/docs/guide/durability/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Observability](https://flueframework.com/docs/guide/observability/)
- [React](https://flueframework.com/docs/guide/react/)

## Decision

Migrate Neondeck directly from `1.0.0-beta.9` to Flue 2 without preserving
beta Flue state, beta HTTP workflow routes, workflow-run inspection, or
compatibility shims.

Keep Neondeck SQLite as the source of truth for product operations. Use Flue 2
agents, submissions, tools, hooks, and conversation state as the model
execution and conversation layer.

This means the migration is not a one-for-one API rename:

- Flue Actions are removed. Existing action handlers must become plain
  Neondeck services or Flue Tools, depending on who calls them.
- Flue Workflows are removed. Existing workflows must become direct service
  calls, awaited agent handles, dispatches to continuing agents, durable tools,
  or app-owned orchestration.
- Flue workflow run ids are removed. Neondeck operation ids and Flue submission
  ids become the durable correlation model.
- Agent functions re-render before model calls. Neondeck must deliberately
  freeze session context instead of rereading SOUL, memory, skills, models, or
  repo context on every render.

## Branch Strategy

`flue2` is the long-running integration branch for the migration.

- Keep `main` on the working Flue beta implementation until the migration is
  complete and verified.
- Target all Flue 2 migration changes at `flue2`.
- When parallel work is useful, create short-lived branches from `flue2` and
  merge them back into `flue2`, not directly into `main`.
- Regularly merge relevant `main` changes into `flue2` while the migration is
  in progress. Resolve framework-surface conflicts in `flue2` rather than
  adding compatibility layers to `main`.
- Do not merge partially migrated framework code into `main`. Flue 1 and Flue
  2 agent definitions, clients, and workflow surfaces should not coexist in a
  released build.
- Merge `flue2` into `main` only after the completion gates in this plan pass.

The `flue2` branch was created from the current development HEAD rather than
the older `main` tip so it includes the latest PR review timeout and workflow
inspection changes that must be deliberately migrated or retired.

## Scope

In scope:

- package pins, Vite build integration, Flue config, development commands, and
  packaged Node server behavior
- explicit agent routing and route middleware
- all current agent definitions and subagent profiles
- all current Flue Actions and Tools
- all 17 current Flue Workflows
- display-assistant and PR-review React clients
- Flue persistence reset and the Node SQLite adapter
- provider registration, including ChatGPT subscription auth refresh
- workflow observability replacement
- Morning Briefing, Autopilot, PR reviews, memory, and learning
- remaining command, scheduler, watcher, CI-fix, and Kilo paths
- tests, docs, packaging, smoke checks, and migration cleanup

Out of scope:

- importing beta Flue conversations or workflow runs
- supporting old installed Neondeck runtime homes
- a dual Flue 1/Flue 2 runtime
- moving Neondeck product state into Flue persistent state
- moving the Node backend to Cloudflare
- replacing the existing Neondeck MCP trust, OAuth, approval, or audit model
  merely because Flue 2 has native MCP mounting

## Current Baseline

At the start of the migration, Neondeck has:

- `@flue/runtime`, `@flue/react`, `@flue/sdk`, and `@flue/cli` pinned to
  `1.0.0-beta.9`
- `flue build` and `flue dev` package scripts
- the beta auto-router mounted at `/api/flue`
- seven modules containing beta agent definitions, including workflow-host
  agents and learning coordinator/profile definitions
- 17 Flue Workflow definitions
- approximately 150 Flue Action definitions across 26 files
- approximately 48 Tool definitions
- deployment-scoped `FlueProvider` and `useFlueClient` usage
- beta `registerProvider()` provider wiring
- custom workflow run inspection based on `getRun()` and `listRuns()`
- Neondeck app SQLite and Flue SQLite kept separate

The separate databases are the correct foundation and should remain:

| Store           | Remains authoritative for                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neondeck SQLite | repos, watches, scheduled tasks, briefing snapshots, worktrees, approvals, reviews, notifications, memories, learning audit, Kilo tasks, UI/session metadata, and app operation records |
| Flue SQLite     | agent instances, conversation history, submissions, attempts, hook state, tool records, data parts, and Flue recovery bookkeeping                                                       |

## Target Runtime Model

### Continuing agents

Use continuing agents where shared conversation history is intentional:

- `DisplayAssistant` / `display-assistant`
- `PrAutopilotOwner` / `pr-autopilot-owner`
- `PrReviewer` / `pr-reviewer`

Mount these explicitly through `createAgentRouter()` at the existing internal
paths where convenient. Keeping those paths reduces dashboard churn; it is not
a compatibility promise.

### Bounded agents

Use a fresh instance per bounded model operation:

- initial PR review
- conversation learning review
- PR-batch retrospective
- memory curation review
- bounded scheduled instruction when continuity is not requested
- any Kilo result classification that genuinely requires a model

Address bounded instances with an app-owned operation/review id. Use
`init(agent, { id })`, `dispatch()`, and `read()` when the result is required.

### App-owned operations

Introduce or formalize a generic Neondeck operation record for bounded work.
It replaces the product role previously played by Flue workflow runs.

Recommended fields:

- operation id
- operation kind
- domain source id, such as briefing run, review attempt, scheduled task run,
  watch event, learning review, or Kilo task
- status: queued, active, ready, failed, blocked, or aborted
- agent name and instance id when model work is involved
- Flue instance uid when useful
- submission id
- bounded input/result summaries
- error summary
- started, settled, and updated timestamps
- audit/event linkage

Domain tables may continue to serve as their own operation records when they
already contain this information. Do not add a generic table merely to duplicate
a complete domain-specific record.

### Vocabulary

| Beta concept      | Flue 2 / Neondeck replacement                                           |
| ----------------- | ----------------------------------------------------------------------- |
| workflow run id   | Neondeck operation id plus optional Flue submission id                  |
| dispatch id       | submission id                                                           |
| run start/end     | agent start/end and submission settled                                  |
| Action            | plain service or Tool                                                   |
| Workflow          | service call, agent handle, dispatch, durable Tool, or app orchestrator |
| agent config bag  | synchronous agent function plus hooks and statics                       |
| agent profile     | agent function, `defineSubagent()`, or `useSubagent()` declaration      |
| deployment client | one conversation client per mounted agent instance URL                  |

## Design Rules

1. Keep deterministic facts and mutations in Neondeck services.
2. Keep schemas alongside services so Hono routes and Tools reuse the same
   validation and result contracts.
3. A model-callable Tool is not the service implementation. It is an adapter
   that binds authorization and calls a service.
4. Tool arguments are model-selected and are never an authorization boundary.
   Bind repo, watch, worktree, revision, and destination from trusted instance
   or delivery context.
5. Use `initialData` for immutable instance creation data, `useDelivery()` for
   per-message facts, `usePersistentState()` for small instance-local durable
   state, and Neondeck SQLite for product state.
6. All agent functions must be synchronous. Async loading belongs in
   `useAgentStart()`, Tools, or lazy sandbox factories.
7. Explicitly attach a sandbox only to agents that need one. The display
   assistant and reviewer agents should not receive an implicit filesystem.
8. Treat event hooks and durable Tool steps as at-least-once. External effects
   must be idempotent or safely reconcilable.
9. Preserve the worktree as Autopilot's coding isolation and recovery boundary.
10. Preserve stable session context. Active display sessions must not silently
    reread changed SOUL, memory, skills, models, providers, or repo config.
11. Preserve one backend API/event surface for the dashboard and future TUI.

## Per-Feature Design

### Morning Briefing

Current behavior:

1. Neondeck schedules the occurrence.
2. A Flue workflow calls `admitBriefing()`.
3. Neondeck collects and persists a bounded deterministic snapshot.
4. The workflow dispatches the snapshot into a continuing display-assistant
   conversation.
5. Flue workflow and submission observations settle the briefing record.

Target behavior:

1. The scheduler or manual API calls `admitBriefing()` directly.
2. Neondeck selects or creates the canonical briefing conversation.
3. Neondeck collects and persists the exact snapshot and briefing run.
4. Dispatch a trusted signal to `DisplayAssistant` with attributes containing
   `briefingRunId`, `profileId`, and snapshot version.
5. Store the returned `submissionId` on the briefing run.
6. `DisplayAssistant` reads the signal with `useDelivery()`.
7. A guarded `useAgentStart()` callback loads the exact snapshot from
   Neondeck SQLite before the first model turn.
8. A schema-backed Tool/data writer emits a structured briefing part with
   source health, top actions, failures, and the briefing run id.
9. The structured data part is the canonical per-delivery correlation record.
   Do not use response metadata for this: Flue response metadata is scoped to a
   host response, while a briefing signal may join an already-running response.
10. `submission_settled` finalizes the briefing run and idempotently creates the
    ready or attention notification.

Decisions:

- Keep one continuing Morning Briefing conversation per profile.
- Keep daily facts per submission, not in persistent agent state.
- Do not copy the complete snapshot into immutable instance data.
- Do not retain a wrapper workflow just to obtain a run id.
- Treat the persisted queued briefing run as an application-owned outbox and
  use its run id as Flue's dispatch `idempotencyKey`.
- Reconcile both unattached admissions and attached-but-unsettled runs from
  keyed redispatch receipts plus Flue's durable conversation settlement index.
- For configured MCP sources, preserve Neondeck's current login, approval, and
  audit checks. Native `useMcpConnection()` may be evaluated behind that policy
  after the core migration.

Acceptance criteria:

- manual and scheduled briefings enter the intended conversation
- the persisted snapshot remains the exact grounding record
- the dashboard receives validated structured briefing data
- success/failure settles from submission state without workflow observations
- repeated settlement cannot duplicate notifications

### Autopilot

Current behavior already matches the desired product model:

- one stable owner instance per watched PR
- one managed worktree
- one active owner turn
- one pending semantic fingerprint
- mode-specific coding and delivery capability
- deterministic settlement from worktree and GitHub state

Target behavior:

1. Keep `PrAutopilotOwner` as a continuing agent. Do not create an app workflow
   around it.
2. Store immutable watch/repo/PR binding facts in `initialData`.
3. Dispatch each meaningful watch event as a trusted signal with attributes
   for event fingerprint, mode, source, revision, and capability ceiling.
4. Use `useDelivery()` to bind current-turn tools and prevent the model from
   selecting its own authority.
5. Read current app-owned watch state before exposing push or response Tools.
6. Move async owner initialization into `useAgentStart()` and a lazy local
   sandbox factory.
7. Conditionally call `useSandbox()` and `useTool()` based on current trusted
   mode/source/state. No-workspace turns receive no sandbox.
8. Use `usePersistentState()` only for small recovery/control markers. The
   watch and worktree tables remain authoritative.
9. Consider `useAgentFinish()` to prevent an owner from silently stopping with
   a dirty worktree or without a terminal commit/escalation outcome.
10. Settle the owner turn from `submission_settled`, then inspect the actual
    worktree, current watch mode, and current GitHub facts.

Durable Tool candidates:

- PR response/comment: good candidate because Neondeck already uses a stable
  idempotency key.
- push: candidate only after retry logic treats an already-pushed intended SHA
  as successful reconciliation.
- app audit/notification writes: candidate when keyed by a stable operation,
  turn, or tool call id.
- ordinary repository commands: remain normal sandbox tools; the persistent
  worktree is their evidence and recovery boundary.

Recovery decisions:

- Flue 2 Node recovery should reclaim accepted submissions after restart when
  backed by durable SQLite.
- Remove the blanket startup transition that treats every `working` owner as
  interrupted only after recovery tests prove Flue settlement is reliable.
- Continue to fail closed when an external effect is uncertain.
- Always re-read worktree and remote state before enabling another delivery
  attempt.

Acceptance criteria:

- mode/source changes add and remove Tools at turn boundaries
- approval-mode direct messages remain route-policy controlled
- a process restart recovers or durably settles accepted owner work
- a crash around push/comment cannot duplicate or misreport the external effect
- stale head, stale mode, wrong destination, dirty worktree, and missing
  credentials still fail closed
- no second workflow/coordinator engine is introduced

### PR Reviews

#### Initial review

Replace `review-pr-for-human` with one fresh `PrReviewAssistant` instance per
review attempt.

1. Neondeck creates the durable review and attempt record.
2. Create a fresh agent id from the attempt id.
3. Pass review id, attempt id, target, base SHA, and exact head SHA as
   `initialData` using create-only semantics.
4. `useAgentStart()` loads the current persisted facts, memory background, and
   exact-revision workspace.
5. Mount only the exact-revision read-only Tools.
6. Expose a schema-backed `submit_pr_review` Tool that writes a `prReview` data
   part and returns `terminate: true`.
7. Use `useAgentFinish()` to require either a valid structured result or an
   explicit failed/unavailable result.
8. The app uses `init()`, `dispatch()`, and `read()` to await the result.
9. Validate the reply data and persist findings, reports, handoff data, and
   attempt settlement in Neondeck SQLite.

Keep generic subagents disabled for the initial review. Exact-head scope and a
single bounded reviewer remain deliberate constraints.

#### Continuing reviewer

Keep `PrReviewer` as the durable follow-up conversation.

- Treat the conversation id as opaque.
- Move review id and head SHA from id parsing into `initialData`.
- Load review, handoff, draft comments, and workspace in `useAgentStart()`.
- Mount no sandbox; expose only bounded read-only workspace Tools.
- Refuse stale revision conversations exactly as today.
- Migrate the dashboard to `useFlueAgent({ url })`.

Possible follow-up after the migration:

- stream validated revision-bound findings through data parts
- show structured review progress without polling app workflow state

Acceptance criteria:

- initial reviews produce the same validated artifacts without a workflow run
- timeout and failure settle the exact review attempt
- reviewer follow-up remains bound to the reviewed head revision
- no review Tool can escape its bound repo/revision
- no workflow run inspector is required to diagnose review state

### Memory And Learning

Neondeck memory remains app-owned. Flue persistent state is not a replacement
for memory scopes, audit events, candidates, curation, or skill patches.

#### Stable display-session context

Flue 2 re-renders agent functions before model calls. A direct port of current
`memoryInstructionsSync()`, SOUL loading, skill discovery, model selection, and
linked-session reads would silently alter context mid-session.

Target behavior:

1. Declare a versioned `contextSnapshot` with `usePersistentState()`.
2. On the first delivered message, a guarded `useAgentStart()` callback loads
   and persists the deliberate context snapshot.
3. Include rendered SOUL/session guidance, selected memory ids and text, model
   selection, skill catalog version, and relevant linked-context identifiers.
4. Later renders use that stored snapshot.
5. Continue to record loaded memory ids in Neondeck session metadata and mark
   sessions stale when relevant memory/config changes.
6. New sessions or an explicit refresh create a new context snapshot.

#### Learning reviews

Replace conversation reflection, PR-batch retrospective, and memory curation
workflows with fresh `LearningReviewer` instances.

- Put review id, review kind, and allowed memory/repo/skill ids in
  `initialData`.
- Give the model read-only bounded evidence.
- Require structured output through a submit Tool/data writer.
- Let the model propose only. Apply policies, memory writes, candidate writes,
  and skill patches in Neondeck services after validating the result.
- Correlate the learning review with `submissionId`.
- Count completed display-assistant turns from successful
  `submission_settled` events rather than successful HTTP admission.

Acceptance criteria:

- memory changes never silently change an active session prompt
- learning review outputs cannot target memory/repo/skill ids outside their
  creation snapshot
- auto/review/off modes retain current behavior
- skill patch audit and restore behavior remain app-owned
- conversation and PR learning cadence no longer depend on workflow events

## Action-To-Tool Migration

Do not mechanically convert every Action into a Tool.

Classify each current Action into one of four categories:

### Plain service

Use for deterministic behavior called by Hono, CLI, scheduler, tests, or other
application code. Keep Valibot input/output schemas and return the existing
domain result.

Likely examples:

- scheduler tick
- briefing profile/run operations
- session metadata operations
- memory and learning operator UI mutations
- review-surface UI mutations
- most Kilo task/result control operations
- most config mutations

### Model-callable Tool

Wrap a service with `defineTool()` and mount it using `useTool()` when the model
should be able to call it.

Required contract changes:

- `run({ input })` becomes `run({ data })`
- non-string results become `{ output: result }`
- use `terminate: true` only for explicit submit/finish Tools
- bind authorization from instance/delivery context rather than model input

Likely examples:

- deterministic lookups already exposed as Tools
- display-assistant config mutations
- memory learn/rewrite/merge/archive
- watch and scheduled-task changes
- repo/worktree operations
- Autopilot commit/push/respond Tools

### Harness Tool

Use `harness: true` only when a Tool itself must perform scratch model work or
access the current agent sandbox. Prefer a dedicated bounded agent when the
application needs to start, await, inspect, and persist the model operation.

### Durable Tool

Use `durable: true` only for a short checkpointed side-effect sequence with
stable deterministic step names and idempotent/reconcilable effects.

Rules:

- every effectful operation goes inside `step.do()`
- step names are derived from durable ids, never time or randomness
- step results stay small and JSON-serializable
- external effects remain at-least-once and need idempotency
- do not use durable Tools to recreate a general workflow engine

## Workflow Replacement Inventory

| Current workflow                   | Replacement                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `briefing`                         | app service persists snapshot/run, then dispatches to continuing `DisplayAssistant` |
| `command-run`                      | Hono/CLI/model Tool calls command service directly and persists command summary     |
| `curate_learning_store`            | fresh `LearningReviewer` handle plus app-side apply/settle                          |
| `dev-doctor`                       | direct deterministic service; optional display-assistant Tool                       |
| `fix-pr-ci`                        | app-owned CI-fix/Kilo operation; no wrapper workflow                                |
| `handoff_to_kilo`                  | direct Kilo task service and durable Kilo task record                               |
| `promote_kilo_result`              | direct gated app service; model classification remains separate if needed           |
| `reconcile_kilo_task`              | app scheduler/service reconciliation                                                |
| `review-pr-for-human`              | fresh `PrReviewAssistant` handle and structured reply                               |
| `review_conversation_for_learning` | fresh `LearningReviewer` handle                                                     |
| `review_kilo_result`               | direct result service or fresh bounded reviewer when semantic review is needed      |
| `review_pr_batch_for_learning`     | fresh `LearningReviewer` handle                                                     |
| `scheduled-agent-instruction`      | fresh bounded agent handle, or dispatch to explicit continuing session              |
| `scheduler-tick`                   | direct app scheduler service                                                        |
| `summarize_kilo_session`           | direct summary service or bounded reviewer handle if a model is required            |
| `verify_kilo_result`               | direct deterministic execution service                                              |
| `watch-pr`                         | direct watch service and app operation summary                                      |

Delete `busywork-workflow` and `scheduler-workflow` agents once their wrapper
workflows are gone.

## Observability And Dashboard Model

The beta workflow-run dashboard cannot be carried forward because Flue 2 has no
`getRun()`, `listRuns()`, workflow route, run event stream, or React workflow
hook.

Target event correlation:

- agent name
- instance id
- instance uid where useful
- submission id
- operation id
- operation/tool/task ids from Flue events
- domain source id from Neondeck state

Required changes:

- migrate observed event handling to the Flue event v3 envelope
- replace `run_start`/`run_end` projections with agent/submission projections
- treat `submission_settled` as the terminal execution event
- remove `/api/flue/runs/*` and `/api/workflows/runs/*`
- replace guarded raw workflow-run inspection with app-owned operation detail
  plus bounded conversation/submission activity
- rename dashboard concepts from Workflows to Activity or Operations
- keep content redaction and local access controls
- update notifications and learning evidence to use operation/source ids and
  submission ids

Domain schema changes to consider:

- `briefing_runs.dispatch_id` -> `submission_id`
- remove `briefing_runs.workflow_run_id`
- PR review attempts store `submission_id` instead of workflow `run_id`
- scheduled task runs store app run/operation id plus optional submission id
- learning reviews store submission id
- command summaries store operation id rather than Flue run id
- worktree/Kilo ownership fields refer to app operation ids
- replace workflow event/projection tables with submission/activity tables or
  migrate their meaning and names cleanly

There are no users to migrate. Prefer a clean schema and no dual-read/dual-write
compatibility. A forward app migration may still be useful for reproducible
development databases, but it does not need to preserve obsolete rows.

## React And SDK Migration

- Remove the root `FlueProvider`.
- Remove `useFlueClient()`.
- Construct or memoize one conversation client per URL when imperative SDK
  access is needed.
- Use `useFlueAgent({ url })` for display and reviewer conversations.
- Preserve local API auth by wrapping fetch in the conversation client or by
  supplying the supported client transport/auth configuration.
- Route command buttons, CI-fix buttons, scheduler actions, and other bounded
  app operations through typed Hono APIs rather than Flue workflow namespaces.
- Update message rendering to safely narrow `data-*` parts and response
  metadata.
- Remember that `abort()` applies to all unsettled work in one conversation,
  not one submission.

## Build, Routing, Database, And Providers

### Build

- Upgrade `@flue/runtime`, `@flue/react`, `@flue/sdk`, and `@flue/cli` to the
  selected 2.0 release.
- Add `@flue/vite`.
- Add a root `vite.config.ts` with `flue()`.
- Keep `web/vite.config.ts` for the dashboard build.
- Configure the backend dev server to remain on port 3583; Vite's default 5173
  belongs to the dashboard.
- Replace `flue dev --target node` with the root Vite dev command.
- Replace `flue build --target node` with the root Vite build command.
- Keep the generated `dist/server.mjs` package contract or update every CLI,
  desktop-service, pack, QA, and smoke consumer together.
- Change `flue.config.ts` to import `defineConfig` from
  `@flue/runtime/config` and remove retired fields.
- Update the `run:display` script to the module-path/message form.
- Add generated Flue/Vite files to `.gitignore` as required.

### Routing

- Remove the beta `flue()` auto-router.
- Explicitly mount `DisplayAssistant`, `PrReviewer`, and
  `PrAutopilotOwner` with `createAgentRouter()`.
- Register authorization, learning intake, and Autopilot direct-message policy
  as normal Hono middleware before the relevant mount.
- Keep bounded/private agents dispatch-only.
- Delete agent-module `route` exports and workflow `route`/`runs` exports.

### Agent definitions

- Add `'use agent'` to every agent module.
- Export capitalized synchronous functions.
- Pin durable names with string-literal `agentName` statics:
  - `display-assistant`
  - `pr-autopilot-owner`
  - `pr-reviewer`
  - stable names for bounded reviewer/learning agents
- Convert models, instructions, Tools, skills, subagents, sandbox, compaction,
  and durability to hooks/statics.
- Convert existing profiles to agent functions or `defineSubagent()`.
- Move all async runtime builders into hooks and factories.

### Skills

- Remove import attributes such as `with { type: 'skill' }`.
- Import `SKILL.md` directly for packaged skill references.
- Keep ordinary markdown imports as text or wrap them with `defineSkill()`.
- Preserve runtime-home skill validation, collision detection, reload, and
  session-stability behavior.

### Sandboxes

- Give `DisplayAssistant` no sandbox unless a concrete feature requires one.
- Give `PrReviewer` and the initial review agent no general filesystem; use
  exact-revision read-only Tools.
- Give `PrAutopilotOwner` an explicit bounded local sandbox only when current
  mode/source/state grants the workspace capability.
- Create owner environment/home resources lazily inside the sandbox factory.
- Reverify the current local/no-workspace sandbox adapters against Flue 2.

### Database

- Keep `src/db.ts` as the source-root Flue database entry.
- Reverify the `sqlite()` adapter and custom delayed-close wrapper against the
  Flue 2 adapter interface and contract tests.
- Preserve separate Neondeck and Flue databases.
- Delete/reset the beta `flue.db`; do not write a schema 5 -> 8 importer.
- Verify startup reconciliation and lease recovery on Node with the durable
  SQLite adapter.

### Providers

- Replace `registerProvider()` and `ProviderRegistration` with Pi provider
  objects and Flue `setProvider()`.
- Rework built-in provider overrides using Pi model objects.
- Rework generic OpenAI-compatible providers with explicit Pi provider/model
  definitions.
- Adapt `openai-codex` subscription auth to a Pi provider auth resolver.
- Ensure token refresh swaps or updates provider auth without exposing tokens.
- Decide whether the Flue Vite build should narrow shipped providers.
- Preserve existing Neondeck provider readiness, CLI config, and secret
  reference behavior.

## Official Migration Checklist

Track the upstream checklist here. Mark an item complete only when its entire
Neondeck scope is complete.

- [x] 1. Pins: upgrade Flue packages, add Vite plugin dependencies, remove beta
      patches/vendored assumptions.
- [x] 2. Build: add root Vite config, update scripts/config/imports/ignore files,
      preserve port and package entry contracts.
- [x] 3. Routing: add explicit agent mounts and middleware; remove auto-router
      and workflow routes.
- [x] 4. Agents: convert all agents and profiles to synchronous functions,
      hooks, statics, explicit sandboxes, and stable names.
- [x] 5. Tools: remove Actions, convert model-callable adapters, rename
      `input` to `data`, wrap result envelopes, and add durable/harness flags only
      where justified.
- [x] 6. Skills: remove import attributes and verify packaged/runtime skills.
- [x] 7. Workflows: replace all 17 with the smallest correct Flue 2 or
      app-owned primitive.
- [x] 8. Channels and database: confirm channels are not in use, validate the
      Node SQLite adapter, and keep `db.ts` at source root.
- [x] 9. Providers: replace beta registration with Pi providers and
      `setProvider()`.
- [x] 10. Observability: migrate events and correlation to agent/submission
      vocabulary and replace workflow-run inspection.
- [x] 11. Clients: migrate SDK and React to conversation-scoped clients.
- [x] 12. Deployment: reset beta Flue state, update Node build/package/service
      behavior, and confirm Cloudflare-specific class work is not applicable.
- [x] 13. Verify: typecheck, tests, production build, package smoke, recovery,
      and built-artifact inspection.

## Implementation Phases

### Phase 0: Baseline And Branch Protection

- [x] Create the `flue2` integration branch.
- [x] Record current package, unit, integration, build, and package-smoke
      baselines before changing dependencies.
- [x] Capture a small manual acceptance script for chat, briefing, review,
      memory, and Autopilot.
- [x] Identify any changes landing on `main` that must be merged before each
      later phase.

Baseline evidence captured on 2026-08-01 at `ae480bf` with Node `26.4.0` and
npm `11.17.0`:

| Gate                        | Result                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                    | Passed; 905 packages installed. npm reported 3 moderate and 5 high dependency audit findings for later triage.                                      |
| `npm run check`             | Passed; lint emitted existing Vitest-style warnings, import layers and migrations passed, TypeScript/docs checks passed, and 963 unit tests passed. |
| `npm run test:integration`  | Passed; 86 tests across 7 files.                                                                                                                    |
| `npm run test:git`          | Passed; 38 tests across 5 files.                                                                                                                    |
| `npm run build`             | Passed; dashboard, beta Flue Node server, runtime assets, and 15-page Astro site built. Existing large-chunk warnings remain.                       |
| `npm run check:npm-package` | Passed; the package contained 897 files.                                                                                                            |
| `npm run smoke:npm-pack`    | Passed.                                                                                                                                             |
| `npm run format:check`      | Passed.                                                                                                                                             |

The repeatable feature-parity runbook is
[FLUE_2_ACCEPTANCE.md](./FLUE_2_ACCEPTANCE.md). At baseline, `flue2` was six
commits ahead of `main` and `main` had no unique commits. Recheck this relation
before every later phase and before the final merge.

Exit criteria:

- baseline failures are documented
- `main` remains releasable
- all migration work is targeting `flue2`

### Phase 1: Build And Runtime Skeleton

- [x] Upgrade packages.
- [x] Add root Flue Vite config.
- [x] Update `flue.config.ts` and scripts.
- [x] Make an empty/minimal Flue 2 Node server boot on port 3583.
- [x] Preserve production `dist/server.mjs` and packaged startup behavior.
- [x] Configure and validate the Flue 2 SQLite adapter.
- [x] Port provider registration enough for one configured model to run.

Exit criteria:

- Vite dev server boots
- production server builds and starts
- one minimal agent can complete a message with durable SQLite

### Phase 2: Services And Tools

- [x] Inventory every Action by category: plain service, Tool, harness Tool,
      durable Tool, or removed wrapper.
- [x] Extract any remaining business logic from Action handlers into services.
- [x] Convert fact lookup Tools to the Flue 2 contract.
- [x] Convert display-assistant mutation adapters to Tools.
- [x] Add shared helpers for `{ output }` envelopes, logging, authorization
      binding, and tests.
- [x] Remove all `defineAction()` usage.

Exit criteria:

- Hono and CLI paths call services directly
- model-callable paths use Tools
- no business rule exists only inside a Tool adapter

### Phase 3: Agents And Routing

- [x] Convert display assistant.
- [x] Convert Autopilot owner.
- [x] Convert continuing PR reviewer.
- [x] Add bounded PR review and learning agents.
- [x] Convert named display subagents.
- [x] Delete wrapper-only scheduler/busywork agents.
- [x] Add explicit Hono mounts and middleware.
- [x] Pin all agent identities.

Exit criteria:

- all registered agents use `'use agent'`
- no `defineAgent()` or `defineAgentProfile()` remains
- only intentionally HTTP-visible agents are mounted

### Phase 4: Display Chat And Client

- [x] Implement stable display-session context snapshot state.
- [x] Convert display chat to conversation URL clients.
- [x] Remove root `FlueProvider` and `useFlueClient()`.
- [x] Preserve local access-control fetch behavior.
- [x] Convert message rendering for data parts and metadata.
- [x] Route slash-command execution through the Hono API/service surface.

Implementation evidence captured on 2026-08-01:

- display, PR-reviewer, and Autopilot-owner chats use memoized Flue 2 clients
  addressed to one explicit conversation URL
- the conversation client preserves the local session-header convention for
  every request and reconnect; the server's actual boundary is loopback or an
  explicitly trusted host plus same-origin browser mutation checks
- hidden dispatches and diagnostic advisories stay out of the visible chat
  lane; `data-*` and dynamic-tool error payloads remain inspectable
- out-of-band briefing creation refreshes observation immediately and again
  from session/command events
- dashboard commands use the local access-controlled Neondeck Hono service surface;
  no browser code uses the removed deployment client or workflow invocation
  API
- the web TypeScript project, 36 focused chat/reviewer/owner tests, and the
  production web build pass

Exit criteria:

- create, switch, resume, send, stream, history, and abort work
- active session context remains frozen after memory/config changes
- a new session loads the new context

### Phase 5: Operations And Observability

- [x] Add/adjust app operation and submission correlation fields.
- [x] Migrate Flue event storage to event v3.
- [x] Replace workflow run projections and APIs.
- [x] Replace workflow dashboard panels and inspector.
- [x] Update notification correlation and guarded activity detail.
- [x] Update learning evidence ingestion.
- [x] Remove `getRun()`, `listRuns()`, run URLs, and raw workflow routes.

Implementation evidence captured on 2026-08-01:

- app-owned `activity_events` and `activity_submissions` tables project sanitized
  Flue v3 observations by submission, using `submission_settled` as the only
  terminal event and timestamp/id ordering across emitting contexts
- `/api/activity` and bounded submission detail replace raw workflow-run routes;
  the dashboard now presents Activity/Operations without `getRun()`,
  `listRuns()`, workflow URLs, or raw conversation records
- scheduled instructions run through the app scheduler with a persisted
  occurrence-keyed dispatch outbox, stable keyed redispatch, occurrence-scoped
  conversations by default, and restart-safe settlement reads from Flue's
  canonical conversation stream
- notifications, PR assistance, scheduled tasks, and Autopilot learning evidence
  correlate by app operation/source ids plus Flue submission ids; Autopilot owner
  turns settle only from their authoritative top-level submission settlement
- CI-fix dashboard refresh follows app-owned operation summaries rather than
  treating a legacy workflow id as a submission id
- 81 focused tests across 12 files, database migration checks, web TypeScript,
  lint, web/server production builds, and an independent static P1/P2 review
  pass; the remaining whole-app TypeScript failures are confined to workflows
  and learning surfaces assigned to later migration phases
- Flue `guide/durability`, `reference/events`,
  `reference/data-persistence-api`, and `reference/agent-api` informed the
  outbox, ordering, and canonical settlement recovery design

Exit criteria:

- active and failed agent submissions are visible
- domain operations link to submission activity
- no UI depends on a Flue workflow run

### Phase 6: Morning Briefing

- [x] Replace the briefing workflow with direct admission and dispatch.
- [x] Add trusted signal intake and snapshot loading.
- [x] Add structured briefing data parts with per-delivery correlation.
- [x] Migrate settlement and notifications to submission events.
- [x] Update manual, scheduled, dashboard, and chat command paths.

Implementation evidence captured on 2026-08-01:

- persisted briefing runs act as the durable outbox and their run ids are Flue
  dispatch idempotency keys
- startup and next-request recovery reconcile accepted admissions and durable
  settlements without duplicate turns or notifications
- exact stored snapshots and instructions are loaded from trusted signals before
  model work; validated `data-briefing` parts carry per-delivery correlation
- manual, scheduled, dashboard, and `/briefing` paths use the same direct
  admission service, and command-event transitions are monotonic
- 58 focused tests, lint, server and web production builds, and an independent
  static P1/P2 review pass
- live acceptance persisted an exact failure-tolerant snapshot before model
  work, rendered validated `data-briefing`, dispatched a due cron occurrence
  through the same persistent conversation, and retained one notification per
  settled manual/scheduled run across restart reconciliation

Exit criteria:

- all briefing acceptance criteria pass

### Phase 7: PR Reviews

- [x] Replace initial review workflow with bounded agent handle.
- [x] Add structured review submission Tool/data.
- [x] Convert continuing reviewer creation data and async intake.
- [x] Migrate reviewer React client.
- [x] Replace run-id correlation with attempt/operation/submission ids.
- [x] Preserve exact-head workspace and timeout policy.

Implementation evidence captured on 2026-08-01:

- initial review uses a fresh bounded `pr-review-assistant` submission with a
  structured terminal Tool result and app-owned attempt state
- continuing review uses the keyed reviewer agent and the Flue 2 conversation
  client while retaining exact-head authorization and workspace boundaries
- attempts, operations, and submissions replace workflow-run identity across
  recovery, reports, and dashboard state
- focused PR-review validation and an independent static P1/P2 review pass

Exit criteria:

- all review acceptance criteria pass

### Phase 8: Memory And Learning

- [x] Complete stable context snapshot behavior.
- [x] Replace conversation review workflow.
- [x] Replace PR-batch learning workflow.
- [x] Replace curation workflow.
- [x] Migrate cadence triggers to settled submissions.
- [x] Preserve candidate, auto-apply, audit, and restore behavior.

Implementation evidence captured on 2026-08-01:

- display sessions persist a versioned SOUL/model/memory/MCP/skill/link snapshot;
  ordinary renders are read-only, start recording is snapshot-idempotent, and
  briefing transition state is acknowledged only after Flue commits the start
  seam
- conversation, curation, and PR-batch learning use one keyed
  `learning-review-agent` with persisted bounded evidence, structured durable
  Tool output, submission correlation, settlement retry, and restart recovery
- conversation and PR cadence originate from successful settled source
  submissions; cadence checkpoints and claimable admission intents commit in
  the same immediate SQLite transaction, preventing crash loss and duplicate
  ambiguous redispatch
- memory/skill candidates, auto memory effects, review terminal state, and
  their audit events are replay-idempotent and atomic while existing
  off/review/auto, restore, and target-bounding policies remain app-owned
- 143 focused tests across 10 files, database migration checks, web TypeScript,
  lint, formatting, docs production build, filtered Phase 8 server TypeScript,
  and an independent static P1/P2 re-review pass
- live memory acceptance proves revision conflict handling, create/edit/archive/
  restore audit history, frozen prompt context with a visible stale badge, and
  deliberate adoption of edited guidance only in a new session
- live learning acceptance proves `off`, `review`, and `auto` policy behavior,
  proposal-only review candidates, explicit skill-patch apply, exact
  unchanged-target audit restore, Neon-authored auto memory, and completed
  bounded learning-review settlement without unsupported proposals
- Flue `guide/durability`, `reference/agent-hooks-api`,
  `reference/agent-api`, and migration guidance informed the durable Tool,
  lifecycle seam, keyed recovery, and pure-render design

Exit criteria:

- all memory and learning acceptance criteria pass

### Phase 9: Autopilot

- [x] Add immutable owner creation data and trusted event signals.
- [x] Port conditional workspace and delivery Tools.
- [x] Port lazy bounded local sandbox.
- [x] Port/strengthen idempotent comment and push recovery.
- [x] Migrate settlement to submission events.
- [x] Add finish enforcement if it improves terminal reliability.
- [x] Replace or narrow startup interrupted-owner recovery.
- [x] Run crash tests at model, edit, commit, push, response, and settlement
      boundaries.

Implementation evidence:

- the stable owner instance now has validated immutable watch creation data;
  each watcher turn arrives as an exact trusted signal and every direct-human
  delivery is bound to a durable keyed reservation
- a transactional SQLite owner-turn ledger freezes model, instructions,
  learning-memory context, workspace binding, source, mode, and capability
  ceiling before Flue admission; a partial unique index enforces one active
  turn per owner across processes
- conditional Tools and lazy bounded-sandbox declarations derive from the
  frozen turn snapshot, while execution-time authority checks still fail
  closed against current watch, worktree, GitHub, and revision state
- commit, discard, push, and response Tools are durable; comment calls retain
  stable application idempotency keys whose public markers are authenticated
  with the stable local application secret rather than mutable GitHub
  credentials, and safe-push recovery recognizes the exact already-delivered
  commit before recording success without re-pushing
- accepted submissions settle from `submission_settled` observations and a
  reattachable canonical `read(submissionId)` watcher; receipt races attach to
  the reserved turn and interrupted app-side settlement claims are reclaimed
- startup and scheduler recovery replay only reserved turns with the same Flue
  idempotency key, reattach admitted work, and block only orphaned legacy
  `working` watches instead of blanket-blocking every in-flight owner
- finish enforcement gives a no-tool watcher response one durable corrective
  continuation, then permits a grounded no-change result without looping
- 30 focused tests across the owner, watch loop, safe delivery, settlement,
  crash replay, and scheduler recovery surfaces pass with database migration
  checks, filtered Phase 9 TypeScript, formatting, lint, and static sub-agent
  review
- Flue `reference/agent-api`, `reference/agent-hooks-api`, `guide/durability`,
  and `reference/streaming-protocol` informed creation data, delivery cursors,
  lifecycle seams, keyed admission, durable Tool, and recovery design

Exit criteria:

- all Autopilot acceptance criteria pass

### Phase 10: Remaining Workflows And Integrations

- [x] Remove command-run workflow.
- [x] Remove scheduler-tick and watch-pr workflows.
- [x] Remove dev-doctor and fix-pr-ci workflows.
- [x] Remove scheduled-agent-instruction workflow.
- [x] Remove Kilo handoff/reconcile/review/verify/promote/summarize workflows.
- [x] Preserve app-owned Kilo task lifecycle and scheduler run state.
- [x] Evaluate, but do not require, native Flue MCP connections behind the
      existing Neondeck policy layer.

Phase 10 evidence captured on 2026-08-01:

- all remaining `src/workflows/*` modules and the wrapper-only
  `BusyworkWorkflow` agent were removed; source and build configuration no
  longer include a workflow directory
- commands, watch operations, dev diagnostics, scheduler ticks, scheduled
  instructions, Kilo handoff/reconciliation/results, and their durable app
  records continue through existing services, Tools, routes, and direct agent
  admission
- `/fix-ci` now calls the app-owned CI-fix service directly, returns its
  persisted operation-summary identity, and reports synchronous admission
  failures instead of falsely claiming a workflow was queued
- Kilo session summarization remains available as the
  `neondeck_kilo_session_summarize` Tool and
  `POST /api/kilo/sessions/summarize`, backed by the existing task/session
  service, persisted task summary, and a shared `session.summarized` audit
  event
- `npm run smoke:kilo` now exercises the app-owned Kilo services directly
  instead of deleted Flue 1 workflow CLI syntax and passes on Node `26.4.0`
- obsolete workflow safety-policy entries were removed and policy version 7
  describes the remaining Tool/action/route/CLI surfaces
- Flue 2 `guide/mcp` was evaluated. Direct `useMcpConnection()` mounting would
  bypass Neondeck's session-frozen catalog, allow/ask/deny gate, consumable
  per-argument approvals, and app-owned audit trail. The migration therefore
  retains Neondeck's wrapped MCP Tools; `createMcpConnection()` remains a
  possible future transport adapter only if it stays behind that policy layer
- 94 focused command, Kilo, safety, app-route, and MCP tests pass, along with
  TypeScript, lint (existing warnings only), formatting, database migration,
  and static workflow-symbol scans
- independent static sub-agent re-review found no remaining P1/P2 findings

Exit criteria:

- no `defineWorkflow()` or `invoke()` remains
- no wrapper-only agent remains

### Phase 11: Cleanup, Docs, And Release Gate

- [x] Delete beta-only workflow compatibility code. Retain
      `src/modules/flue/execution-context.ts`: it is the Flue 2 `instrument()`
      security/audit bridge, not beta compatibility code.
- [x] Update runtime skills and roadmap language from Actions/Workflows to
      services/Tools/agents/operations.
- [x] Update README, DEVELOPMENT, Astro docs, CLI help, Raycast integration,
      package scripts, QA, desktop service, and smoke scripts.
- [x] Add an appropriate changeset for the completed user-facing migration.
- [x] Complete the live read-only PR-review happy path, continuing-reviewer
      restart/mismatch slice, and a passive `notify-only` Autopilot baseline.
      The clean local runtime, conversation restart/abort, MCP, package,
      read-only GitHub, and automated feature evidence is recorded in
      `FLUE_2_ACCEPTANCE.md`.
- [x] Complete real PR head advancement, same-record re-review, and old-reviewer
      refusal against an authorized disposable PR. The live run exposed and
      fixed a stale Tool window by rejecting old-revision POSTs before Flue
      admission.
- [x] Complete the externally mutating Autopilot scenarios against explicitly
      authorized disposable PRs and the configured provider boundary. Approval
      mode, autonomous safe push/response, failed-closed retry, and restart
      reconciliation evidence is recorded in `FLUE_2_ACCEPTANCE.md`.
- [x] Run the automated completion gates below.

Phase 11 evidence captured on 2026-08-01:

- source and packaged runtime asset discovery share one resolver that handles
  source modules, bundled chunks, the package root, and `dist/runtime-assets`
- the packaged launcher lazy-loads the source app only for direct development;
  `npm run smoke:npm-pack` proves the installed CLI starts the built server,
  reaches health, and loads its shipped skills and migrations
- `npm start` now enters through the CLI launcher, propagates port `3583` to the
  built Flue server, and passed a clean-home `/api/health` probe
- Vitest uses Flue's Markdown import transform with a TypeScript-only filter,
  so real packaged skill imports are exercised without parsing unrelated TSX
- CLI approval resolution now nudges the local access-controlled mounted Flue 2
  conversation URL; live stdio MCP acceptance proved ask, CLI approval,
  identical-argument retry, result delivery, denial, audit, and restart
  persistence
- disabled MCP servers no longer seed cached Tools into newly created sessions;
  already-created sessions retain their frozen roster and fail closed, while a
  re-enabled server supplies its refreshed catalog only to a new session; both
  the focused regression test and live stdio fixture acceptance pass
- live display acceptance additionally proves isolated main/scratch histories,
  durable abort followed by a healthy turn, and `/repo-status` parity between
  the local API and the model-callable typed Tool
- live read-only GitHub acceptance reviewed PR #177 at an exact head, persisted
  validated local findings and reports, resumed its revision-keyed reviewer
  after restart, rejected a mismatched revision, and kept a passive
  `notify-only` Autopilot watch owner/worktree-free across restart
- authorized live PR-review acceptance created disposable PR #245, reviewed
  head `e105c260b7f68f9e3f482ac561419b195be090e6`, advanced it to
  `daaf6c3ebe3843a59c1f4c1959a204ddc2aa3e44`, and re-reviewed the same
  durable record with two new report artifacts and two findings; a stale
  reviewer POST now fails before admission with `409 review_revision_stale`
  and cannot append another settlement
- the live head-advance run also triggered a static authority audit; generic
  approval-mode owner messages now retain edit/commit/discard capabilities but
  gain no push/comment authority without an exact reviewed revision,
  unconfirmed mutating-mode setup performs no watch mutation, and owner-bound
  watches must pass through Autopilot stop/cleanup before removal
- final stop-path hardening removed implicit prepared-commit discard: model,
  API, and dashboard stops retain an unpushed prepared diff unless the user
  explicitly confirms that destructive cleanup with `confirmPreparedDiff=true`
- authorized live `prepare-only` acceptance on PR #245 created one durable
  owner and one managed worktree at exact head
  `daaf6c3ebe3843a59c1f4c1959a204ddc2aa3e44`, exposed no delivery capability,
  committed the one-file fix locally as
  `30a70eee68a257adbb455064861bc3e0978ea6fd`, passed the focused fixture test,
  and left the remote PR head unchanged; restart preserved the completed watch
  and its audit bindings, after which confirmed prepared-diff cleanup and the
  normal watch-removal API completed teardown
- authorized live `autofix-with-approval` acceptance on PR #245 retained that
  durable owner, created a fresh managed worktree after the prior audit record
  was deleted, committed and validated the exact one-file reviewed change as
  `dcb4aaa490456c779fa4ffa5be7bea004affa327`, and proved a generic owner message
  could neither push nor respond; exact revision approval then pushed only that
  commit, with GitHub head, managed-worktree head, and `last_pushed_sha`
  converging on the same value; restart reconciliation produced no duplicate
  push/comment, and typed stop removed the clean worktree before watch removal
- authorized live `autofix-push-when-safe` acceptance on PR #246 used only the
  canonical scheduler, created one durable owner and managed worktree at exact
  head `c8d17dc34b7bde2636cc58355016f02364d15491`, fixed one file, passed all
  969 unit tests, and committed `4418316a699b725eadf81b8dc1c3fa61ae4e8eaa`;
  a failed-closed delivery boundary recovered through typed retry without a
  second owner/worktree/commit, then guarded push and response succeeded; after
  restart, every local and remote head field converged on that exact commit and
  the response idempotency marker remained singular; typed stop and watch
  removal completed managed-resource teardown
- disposable PRs #245 and #246 were closed without merge; their exact remote
  and local fixture branches/worktrees were removed, the repository `origin`
  was restored to `git@github.com:pandemicsyn/neondeck.git`, and the clean-home
  acceptance server was stopped
- runtime skills, the product roadmap, README, development guide, Astro docs,
  Raycast command client, smoke naming, and user-facing operation vocabulary
  now describe the Flue 2 architecture; legacy table and audit field names are
  retained only where they are persisted app-domain compatibility
- `npm run verify` passes with 1,000 unit tests, 39 git tests, 90 integration
  tests, all type/layer/database checks, dashboard/server/docs builds, a
  913-file package audit, packed CLI smoke, and formatting
- the changeset records the user-facing Flue 2 migration as a minor release
- independent static Phase 11 review identified and verified fixes for packaged
  package-root resolution, `npm start` port propagation, and accurate local
  host/origin access-control documentation; the re-review found no P1/P2 issues
- final post-acceptance static safety review hardened the Autopilot teardown
  boundary: fenced watch removal now deletes its polling task, task runs, and
  event watermarks in the same SQLite transaction, with rollback and lost-fence
  race coverage; retained or unreadable worktree cleanup now includes recovery
  instructions in the durable notification and a dismissible dashboard outcome
  that remains visible after the completed watch row disappears; failed rearm
  polling upserts are repaired by a fenced retry, and stop verifies durable
  polling is disabled before transitioning state or attempting cleanup
- final authority hardening adds an atomic expected-head git lease, reconciles
  approval pushes that reached GitHub before the durable local record, rechecks
  autonomous response authority against live GitHub/local/pushed heads at the
  final comment boundary, and keys public idempotency markers with the stable
  app-owned local API secret so GitHub token rotation cannot duplicate replies
- stop now requires explicit `confirmPreparedDiff` before deleting either a
  settled prepared-diff or a clean unpushed commit from the pre-settlement crash
  window; completed-watch rearm applies a requested lower mode atomically before
  polling resumes, and generic owner messages remain non-authorizing
- the focused teardown/recovery verification passes 70 tests across watch
  actions, the Autopilot loop, and Active Watches, and `npm run typecheck:app`
  passes for the backend and dashboard
- final stop/configure concurrency hardening claims a durable `stopping` state
  and disables polling in the same SQLite transaction before cleanup, rejects
  reconfiguration until cleanup settles, and uses a durable failed-rearm marker
  so an idempotent configure repairs only an interrupted rearm while preserving
  an intentional manual polling pause; the definitive post-fix verification
  completed at approximately 2026-08-02 01:04 UTC
- independent final static re-reviews of authority boundaries, polling and
  teardown state, Flue skill/docs accuracy, restart semantics, and MCP parity
  found no remaining P1/P2 issues after the identified races and documentation
  ambiguity were resolved

Exit criteria:

- `flue2` is ready to merge into `main`

### Post-PR Correctness Remediation

Independent feature reviews performed after draft PR #247 was opened found
migration regressions and crash-window gaps. The implementation fixes were
completed on 2026-08-02:

- [x] Morning Briefing admission now uses a cross-process SQLite transaction
      fence for every queued or running delivery in the bound conversation,
      across all profiles, so joined Flue responses cannot overwrite one named
      briefing data part.
- [x] Attached briefing admissions reconcile durable Flue history before
      rejecting a new delivery. Transient history failures retain the typed
      occupied-conversation fence so scheduled occurrences defer instead of
      failing or skipping the occurrence.
- [x] Scheduled briefing task runs retain the Flue submission id and remain
      active until terminal submission settlement instead of completing at
      admission. The scheduler-run → briefing-run mapping is committed in the
      same app SQLite transaction as the briefing outbox, and each scheduler
      tick recovers claimed/active correlations and terminal state.
- [x] Initial PR reviews now correlate every attempt to its submission, fail
      `reviewing` or `ready` state on terminal Flue failure, accelerate through
      live observations, and reconcile durably through re-attachable
      `read(submissionId)` watchers after restart.
- [x] PR-review admission uses a stable Flue idempotency key and byte-identical
      canonical `initialData` on replay. Startup re-admits persisted attempts
      whose submission id was not attached, and settlement reads retry after
      transient failures until terminal settlement or attempt supersession.
- [x] The continuing PR reviewer stores its 250-call workspace exploration
      budget in Flue persistent state, so agent rerenders cannot replenish it.
- [x] The continuing PR reviewer now appends asynchronously loaded review
      context into the same first response and mounts deferred exact-revision
      workspace Tools before intake resolves. The first sidebar question no
      longer runs against fallback instructions with an empty Tool catalog.
      Mutable draft, handoff, prompt, and registry context refreshes on each
      delivery, and transiently unavailable workspaces remain retryable.
- [x] Post-fix `npm run verify` passes with 1,022 unit tests, 42 serial git
      tests, 90 integration tests, all builds, package audit, packed CLI smoke,
      and formatting.
- [x] Autopilot owner immutable initial data contains only the stable watch
      identity; mutable repository ids and PR facts remain validated against
      the current reserved delivery envelope after repo-id canonicalization.
- [x] Approval-mode help text names `Review diff → Approve & push` as the sole
      delivery authority and describes owner chat as edit/discard guidance.
- [x] Auto-applied learning memory effects store their first mutation result in
      the same app SQLite transaction as the mutation, keyed by review and
      action index, so a `step.do` replay preserves the original applied count
      even if the current autonomous-write policy changed after the commit.
- [x] Manual learning-review preparation atomically persists the bounded
      `prepared_json`, agent id, running review, and started event, closing the
      pre-dispatch restart gap that could strand a review without an outbox.
- [x] Skill patch application journals its durable authority and audit inputs
      before atomic file replacement, reconciles an already-replaced file on
      replay, preserves a concurrent winner during compensation, and returns
      the exact original success result after an applied-state replay.
- [x] Learning prompts again require user preferences → `user`, machine/tool/
      environment/provider facts → `local`, repository/product conventions →
      `project`, and rewrite/merge/archive-first curation.
- [x] Concurrent CI-fix dashboard pollers now follow the exact app-owned
      operation id returned by admission instead of whichever operation for
      the same PR appears newest.
- [x] The focused remediation suite passes 64 tests across briefing,
      scheduling, PR reviews, and CI-fix polling; the existing Autopilot/UI and
      learning/memory focused suites remain green.
- [x] `npm run check` passes with 1,012 unit tests; lint reports only the
      repository's existing warning class.
- [x] `npm run verify` passes on the remediation working tree: 1,012 unit
      tests, 40 git tests, 90 integration tests, all builds, a 914-file package
      audit, packed CLI smoke, and formatting.
- [x] Fresh independent feature reviewers confirm no remaining correctness or
      feature-parity regressions.

Independent reviewers compared each Flue 2 feature against `main` after the
remediation and reported no remaining P1–P3 findings for Morning Briefing, PR
reviews, memory/learning, or Autopilot/watches. The upstream PR review thread
about same-PR CI-fix poller cross-talk is also covered by an exact-operation-id
regression test.

### Flue 2 Usage Correctness Follow-Up

A subsequent documentation-backed Flue 2 architecture review identified two
remaining correctness gaps in the initial PR-review path. Remediation status:

- [x] Bound initial reviews now freeze canonical repository identity, PR
      number, base SHA/ref, and head SHA in schema-validated immutable
      `initialData`. Admission and restart recovery reconstruct the same
      snapshot from the persisted review attempt, and execution refuses facts
      that drift from that exact revision.
- [x] `neondeck_pr_review_for_human` is now a Flue durable harness Tool. Exact
      facts, bounded context, model output, draft seeding, report writes,
      operation summary, notification, review settlement, and learning evidence
      execute through named `step.do()` checkpoints.
- [x] Report, summary, and notification writes use stable application ids for
      the bound attempt/tool call. This closes the at-least-once execution gap
      where an application effect commits immediately before Flue records the
      completed step.
- [x] Durable step failures are checkpointed as tagged JSON outcomes, so a
      transient callback cannot fail the app review and later replay as a
      contradictory successful Tool result. Ready settlement also verifies the
      persisted attempt when replay observes an already-completed transition.
- [x] Outer Flue aborts propagate without running review-failure or artifact
      side effects. Draft validation finishes before any mutation and re-reads
      current state, while cancelled report writes compensate committed rows
      and files. The separate bounded model timeout remains a durable,
      inspectable review failure.
- [x] Neon draft comments use stable attempt-scoped ids. Replaying seeding after
      the application write/Flue-record crash window recreates the same comment
      identities and preserves one matching seed-ledger entry per finding.
- [x] Focused crash-replay regression tests prove report and notification
      effects converge without duplicate artifacts or user notifications, step
      errors remain stable, in-flight aborts preserve existing drafts and roll
      back reports, and draft-seed replay leaves no orphaned ledger rows.
- [x] `npm run check` passes with 1,022 unit tests; lint reports only the
      repository's existing warning class.
- [x] `npm run verify` passes: 1,022 unit tests, 42 git tests, 90 integration
      tests, all builds, a 914-file package audit, packed CLI smoke, and
      formatting.
- [x] Complete an independent static re-review against the version-matched
      Flue 2.0.1 initial-data and durable-Tool contracts.

The final independent reviewer reported no remaining P1–P3 correctness
findings. The review explicitly confirmed exact-revision binding, tagged error
replay, abort propagation, stable draft/seed identity, idempotent settlement,
and compensation for the Flue orphan-execution windows.

### Cross-Feature Context Lifecycle Audit

After fixing continuing-reviewer first-turn context, independent static
reviewers audited every Flue agent against the installed Flue 2.0.1 hook,
render, resource, sandbox, and durability contracts. This audit distinguishes
render-time context, same-response signals, submission-scoped resources, and
application-owned snapshots at admission, recovery, and settlement boundaries.

- [x] Audit Morning Briefing and Display Assistant context across first
      delivery, joined briefing delivery, refresh, response finish, and
      recovery.
- [x] Audit Autopilot/watch owner context across watch events, direct-human
      turns, approval transitions, no-tool continuation, and restart recovery.
- [x] Audit initial and continuing PR review context across admission, exact
      revision loading, first-turn tools, and later questions.
- [x] Keep the continuing reviewer's control instructions stable across
      asynchronous intake. `useAgentStart()` now appends only a bounded
      `review-context` facts signal, so ordinary context refreshes no longer
      churn the composed instruction document or provoke Flue's reserved
      `instructions` narration marker.
- [x] Refresh live GitHub review threads alongside the review handoff and local
      draft comments before every continuing-reviewer answer. The signal
      carries authors, thread/reply order, resolution and outdated state,
      revision anchors, bounded bodies, and explicit source/local truncation
      metadata while preserving the exact-revision read-only Tool boundary.
- [x] Revision-bind that live-thread snapshot to `headRefOid` returned by the
      same paginated GraphQL request. Reject a head change during pagination,
      and classify each delivered snapshot as exact-reviewed-revision,
      different-pr-head, or unverified so thread anchors cannot silently be
      correlated with the wrong exact-revision workspace. Non-exact snapshots
      retain conversation text but deterministically omit repository anchors.
      Nested review-comment pagination queries carry and validate the same PR
      head, preventing a head change from mixing comment pages into an older
      thread snapshot.
- [x] Reuse the review surface's cached GitHub thread fetch so the sidebar and
      reviewer consume the same live conversation snapshot. Focused regression
      coverage proves a named GitHub reviewer and reply reach first-turn
      context while changing thread data leaves system instructions stable.
- [x] Separate deferred reviewer Tool workspace resolution from asynchronous
      intake loading. Tool rerenders now resolve only the exact-revision local
      workspace, forward Flue's Tool abort signal through local revision fetch
      and every Git subprocess, and never refetch handoff or live GitHub thread
      context.
- [x] Replace the follow-up prompt's misleading mutable-value tokens with
      explicit stable `workspaceToolGuidance` and
      `reviewContextDeliveryGuidance` tokens. Live review data is delivered
      only through the per-delivery signal, matching the configurable prompt
      contract. Runtime configuration docs and dashboard fixtures expose the
      same token catalog.
- [x] Mount the real continuing reviewer under `start()` with Pi's faux
      provider. The lifecycle regression test proves the initial context lands
      before the first model call, a later delivery receives refreshed draft
      context, and stable policy emits no reserved `instructions` advisory.
- [x] Run full verification after the reviewer correction: 1,034 unit tests,
      44 serial/git tests, 90 integration tests, all application and docs
      builds, package validation, packed CLI smoke, and formatting pass.
- [x] Run an independent post-fix Flue 2.0.1 static review. Address its nested
      pagination, end-to-end Tool cancellation, and remaining public token
      documentation findings before final verification.
- [x] Audit memory/learning context across immutable review preparation,
      durable Tool execution, recovery, autonomous application, and later
      candidate decisions.
- [x] Defer PR-review, learning, Autopilot, briefing, and scheduler startup
      until the generated Flue Node entry has configured the runtime. App
      module evaluation now performs only safe registration, route setup, and
      readiness gating. A non-mutating exact-agent instance lookup gates
      Flue-backed recovery, failed startup passes retry without suppressing
      later services, and development reloads replace the previous scheduler
      only after their agent function identities are accepted by the active
      runtime.
- [x] Remove the Autopilot owner's same-response dependency on
      `prepared-owner-context`; a value written in `useAgentStart` is not a
      valid prerequisite for the first `useAgentFinish` cycle when the model
      makes no tool call.
- [x] Prepare and persist every reserved Autopilot owner turn before startup
      recovery dispatches it. A crash between reservation and ordinary
      preparation must not produce fallback instructions with no bounded
      sandbox or capability tools.
- [x] Handle briefing refreshes that join an active display response without
      claiming that a changed model/provider was adopted. `useModel` is
      submission-scoped even though instructions and per-render resources can
      refresh at the joined turn boundary.
- [x] Move or contain Display Assistant context acknowledgement so a
      synchronous app-database failure in `useResponseFinish` cannot fail an
      otherwise completed briefing.
- [ ] Validate the exact briefing run before advancing the application-owned
      display-context baseline, and reconcile that external mutation at a
      durable settlement boundary.
- [x] Revision-bind learning memory rewrite, merge, and archive proposals to
      the `updatedAt` values in their prepared evidence. Carry those fences
      through review candidates so delayed or recovered decisions cannot
      mutate a newer memory version by id alone.
- [ ] Add mounted-agent lifecycle tests for Display Assistant briefing joins
      and Autopilot owner first turns, no-tool continuation, capability changes,
      and crash-before-preparation recovery.

The completed lifecycle fixes use the pre-admission owner snapshot directly in
the first finish cycle, rebuild missing reserved-turn context before replay,
stamp the response-start model and thinking level into Flue metadata before
acknowledging a briefing refresh, contain acknowledgement failures for later
retry, and carry exact memory revisions through automatic actions and delayed
review candidates. All newly created memory candidates, including deterministic
curation candidates, now capture or validate revision evidence and fail closed
at approval when it is absent. Upserts also carry an explicit absent-row fence
so a memory created after preparation cannot be overwritten as a collision.

The audit found no equivalent first-turn gap in initial PR review, continuing
PR review after its remediation, Learning Review Agent evidence, ordinary
Display Assistant session memory, or normally admitted Autopilot turns. No P1
issue was found. The remaining items above concern stronger durable-settlement
placement and mounted-agent lifecycle coverage; the memory revision fence
predates Flue 2, while the Autopilot and joined-briefing lifecycle fixes are
specific to the v2 execution model.

## Verification Strategy

Run the normal repository checks throughout the migration:

```sh
fnm use 26.4.0
npm run check
npm run test:integration
npm run test:all
npm run build
npm run check:npm-package
npm run smoke:npm-pack
npm run format:check
```

Add focused Flue 2 tests for:

- create-only and continue-only sends using uid conditions
- display context snapshot initialization and staleness
- conditional Tool/sandbox changes
- `useDelivery()` authorization binding
- structured data parts and response metadata
- awaited bounded review and learning agent results
- submission failure, abort, and timeout
- Node restart reconciliation with durable SQLite
- ordinary interrupted Tool behavior
- durable Tool replay and idempotency
- Autopilot restart before/after edit, commit, push, comment, and settlement
- conversation-scoped client auth, history, streaming, wait, and abort
- packaged server startup and port 3583 behavior

## Completion Gates

The migration is complete only when all of the following are true:

- [x] The official 13-item migration checklist is complete.
- [x] No `defineAction` remains.
- [x] No `defineWorkflow` or `invoke` remains.
- [x] No `defineAgent` or `defineAgentProfile` remains.
- [x] No beta `flue()` auto-router remains.
- [x] No workflow `route` or `runs` exports remain.
- [x] No `getRun`, `listRuns`, workflow run URL, or workflow React client remains.
- [x] No `FlueProvider` or `useFlueClient` remains.
- [x] No `registerProvider` or beta provider registration type remains.
- [x] No `run({ input })` Tool handler remains.
- [x] No skill import attribute remains.
- [x] Every mounted agent is behind the shared local host/origin access control
      and its agent-specific route policy.
- [x] Display session context is demonstrably stable.
- [x] Briefing, reviews, memory/learning, and Autopilot automated acceptance
      criteria pass.
- [x] Flue beta state reset is documented and automatic/manual setup is clear.
- [x] `npm run verify` passes.
- [x] Packaged npm and desktop/server smoke paths pass.
- [x] The live read-only PR-review happy path, continuing-reviewer
      restart/mismatch slice, and passive `notify-only` Autopilot baseline
      succeed against PR #177 without external mutations. Clean local runtime,
      display abort/session isolation, and complete MCP acceptance pass.
- [x] Real PR head advancement, same-record re-review, and pre-admission stale
      reviewer refusal succeed against authorized disposable PR #245.
- [x] GitHub-mutating Autopilot acceptance succeeds against explicitly
      authorized disposable PRs and the configured provider boundary.

## Expected Roadmap Updates

The roadmap currently describes Flue Workflows and Actions as product
primitives. Once implementation begins, update those sections deliberately:

- continuing conversation -> Flue agent
- bounded model work -> fresh Flue agent submission, optionally awaited
- deterministic capability -> Neondeck service plus optional Flue Tool adapter
- long-lived or multi-step product process -> Neondeck app state/orchestrator
- small checkpointed in-agent effect sequence -> durable Tool
- inspectable product run -> Neondeck operation record correlated with a Flue
  submission

Do not update the roadmap piecemeal in a way that describes a mixed beta/v2
architecture. Make the terminology change when the corresponding runtime
foundation is implemented on `flue2`.

## Final Merge Strategy

Before merging `flue2` into `main`:

1. Merge the latest `main` into `flue2` and resolve conflicts.
2. Run every completion gate on the merged result.
3. Build and smoke the packaged artifacts from `flue2`.
4. Review the final diff specifically for beta compatibility remnants.
5. Merge `flue2` into `main` as one coordinated framework migration.
6. Do not retain a feature flag that can boot the beta runtime.
