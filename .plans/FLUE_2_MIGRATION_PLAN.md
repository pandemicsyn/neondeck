# Flue 2 Migration Plan

Status: in progress  
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

- [ ] 1. Pins: upgrade Flue packages, add Vite plugin dependencies, remove beta
      patches/vendored assumptions.
- [ ] 2. Build: add root Vite config, update scripts/config/imports/ignore files,
      preserve port and package entry contracts.
- [ ] 3. Routing: add explicit agent mounts and middleware; remove auto-router
      and workflow routes.
- [ ] 4. Agents: convert all agents and profiles to synchronous functions,
      hooks, statics, explicit sandboxes, and stable names.
- [ ] 5. Tools: remove Actions, convert model-callable adapters, rename
      `input` to `data`, wrap result envelopes, and add durable/harness flags only
      where justified.
- [ ] 6. Skills: remove import attributes and verify packaged/runtime skills.
- [ ] 7. Workflows: replace all 17 with the smallest correct Flue 2 or
      app-owned primitive.
- [ ] 8. Channels and database: confirm channels are not in use, validate the
      Node SQLite adapter, and keep `db.ts` at source root.
- [ ] 9. Providers: replace beta registration with Pi providers and
      `setProvider()`.
- [ ] 10. Observability: migrate events and correlation to agent/submission
      vocabulary and replace workflow-run inspection.
- [ ] 11. Clients: migrate SDK and React to conversation-scoped clients.
- [ ] 12. Deployment: reset beta Flue state, update Node build/package/service
      behavior, and confirm Cloudflare-specific class work is not applicable.
- [ ] 13. Verify: typecheck, tests, production build, package smoke, recovery,
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

- [ ] Upgrade packages.
- [ ] Add root Flue Vite config.
- [ ] Update `flue.config.ts` and scripts.
- [ ] Make an empty/minimal Flue 2 Node server boot on port 3583.
- [ ] Preserve production `dist/server.mjs` and packaged startup behavior.
- [ ] Configure and validate the Flue 2 SQLite adapter.
- [ ] Port provider registration enough for one configured model to run.

Exit criteria:

- Vite dev server boots
- production server builds and starts
- one minimal agent can complete a message with durable SQLite

### Phase 2: Services And Tools

- [ ] Inventory every Action by category: plain service, Tool, harness Tool,
      durable Tool, or removed wrapper.
- [ ] Extract any remaining business logic from Action handlers into services.
- [ ] Convert fact lookup Tools to the Flue 2 contract.
- [ ] Convert display-assistant mutation adapters to Tools.
- [ ] Add shared helpers for `{ output }` envelopes, logging, authorization
      binding, and tests.
- [ ] Remove all `defineAction()` usage.

Exit criteria:

- Hono and CLI paths call services directly
- model-callable paths use Tools
- no business rule exists only inside a Tool adapter

### Phase 3: Agents And Routing

- [ ] Convert display assistant.
- [ ] Convert Autopilot owner.
- [ ] Convert continuing PR reviewer.
- [ ] Add bounded PR review and learning agents.
- [ ] Convert named display subagents.
- [ ] Delete wrapper-only scheduler/busywork agents.
- [ ] Add explicit Hono mounts and middleware.
- [ ] Pin all agent identities.

Exit criteria:

- all registered agents use `'use agent'`
- no `defineAgent()` or `defineAgentProfile()` remains
- only intentionally HTTP-visible agents are mounted

### Phase 4: Display Chat And Client

- [x] Implement stable display-session context snapshot state.
- [x] Convert display chat to conversation URL clients.
- [x] Remove root `FlueProvider` and `useFlueClient()`.
- [x] Preserve authenticated fetch behavior.
- [x] Convert message rendering for data parts and metadata.
- [x] Route slash-command execution through the Hono API/service surface.

Implementation evidence captured on 2026-08-01:

- display, PR-reviewer, and Autopilot-owner chats use memoized Flue 2 clients
  addressed to one explicit conversation URL
- the conversation client resolves the current local API token for every
  request and reconnect
- hidden dispatches and diagnostic advisories stay out of the visible chat
  lane; `data-*` and dynamic-tool error payloads remain inspectable
- out-of-band briefing creation refreshes observation immediately and again
  from session/command events
- dashboard commands use the authenticated Neondeck Hono service surface;
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
  stable application idempotency keys and safe-push recovery recognizes the
  exact already-delivered commit before recording success without re-pushing
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

- [ ] Remove command-run workflow.
- [ ] Remove scheduler-tick and watch-pr workflows.
- [ ] Remove dev-doctor and fix-pr-ci workflows.
- [ ] Remove scheduled-agent-instruction workflow.
- [ ] Remove Kilo handoff/reconcile/review/verify/promote/summarize workflows.
- [ ] Preserve app-owned Kilo task lifecycle and scheduler run state.
- [ ] Evaluate, but do not require, native Flue MCP connections behind the
      existing Neondeck policy layer.

Exit criteria:

- no `defineWorkflow()` or `invoke()` remains
- no wrapper-only agent remains

### Phase 11: Cleanup, Docs, And Release Gate

- [ ] Delete beta-only execution-context and workflow compatibility code.
- [ ] Update runtime skills and roadmap language from Actions/Workflows to
      services/Tools/agents/operations.
- [ ] Update README, DEVELOPMENT, Astro docs, CLI help, Raycast integration,
      package scripts, QA, desktop service, and smoke scripts.
- [ ] Add an appropriate changeset for the completed user-facing migration.
- [ ] Reset a clean runtime home and perform full manual acceptance.
- [ ] Run the completion gates below.

Exit criteria:

- `flue2` is ready to merge into `main`

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

- [ ] The official 13-item migration checklist is complete.
- [ ] No `defineAction` remains.
- [ ] No `defineWorkflow` or `invoke` remains.
- [ ] No `defineAgent` or `defineAgentProfile` remains.
- [ ] No beta `flue()` auto-router remains.
- [ ] No workflow `route` or `runs` exports remain.
- [ ] No `getRun`, `listRuns`, workflow run URL, or workflow React client remains.
- [ ] No `FlueProvider` or `useFlueClient` remains.
- [ ] No `registerProvider` or beta provider registration type remains.
- [ ] No `run({ input })` Tool handler remains.
- [ ] No skill import attribute remains.
- [ ] Every mounted agent is explicitly authenticated/authorized.
- [ ] Display session context is demonstrably stable.
- [ ] Briefing, reviews, memory/learning, and Autopilot acceptance criteria pass.
- [ ] Flue beta state reset is documented and automatic/manual setup is clear.
- [ ] `npm run verify` passes.
- [ ] Packaged npm and desktop/server smoke paths pass.
- [ ] A clean runtime-home manual acceptance pass succeeds.

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
