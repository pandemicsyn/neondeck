# Clean Architecture Proposal for Large Neondeck Modules

This proposal covers a practical breakup of Neondeck's largest mixed-concern modules. The goal is not a framework rewrite. The goal is smaller, composable TypeScript modules where Flue actions, Hono routes, CLI commands, and React panels all call the same domain services instead of each owning business logic.

## Scope

Primary files to address:

- `src/autopilot-workflows.ts` - 4,184 lines
- `src/kilo-actions.ts` - 3,138 lines
- `src/worktrees.ts` - 2,042 lines
- `src/config-actions.ts` - 1,894 lines
- `src/session-actions.ts` - 1,862 lines
- `src/github.ts` - 1,838 lines
- `src/commands.ts` - 1,791 lines
- `src/runtime-home.ts` - 1,560 lines
- `web/src/plugins/RuntimeOverview.tsx` - 2,469 lines
- `web/src/api.ts` - 1,484 lines
- `web/src/plugins/FlueChat.tsx` - 1,002 lines

Secondary candidates:

- `src/watch-actions.ts`
- `src/runtime-status.ts`
- `src/cli.ts`
- `src/app.ts`
- `src/execution-actions.ts`

## Non-Goals

- Do not change product trust posture or add broad new approval friction as part of this refactor.
- Do not replace Flue primitives with a homegrown workflow/action framework.
- Do not introduce a dependency injection container.
- Do not migrate persistence away from local SQLite.
- Do not do a massive all-at-once move that makes active feature work impossible.
- Do not redesign the dashboard visual language as part of this work.

## Current Pain Points

### Mixed Responsibilities

Several files combine too many layers:

- Public Valibot schemas and TypeScript types.
- Flue `defineAction` and `defineTool` declarations.
- Hono-facing service functions.
- SQLite DDL, SQL queries, row parsing, and reconciliation.
- External clients such as GitHub, Kilo CLI, Kilo SDK, and local process inspection.
- Filesystem and process operations.
- Policy decisions and status classification.
- Human-readable summaries, prompt text, and UI-friendly formatting.

This makes local changes risky because a small workflow behavior change can touch storage, schema, client, and formatting code in the same file.

### Thin Boundaries Are Inverted

The roadmap says the dashboard, CLI, commands, and chat should be frontends over one backend event/command surface. In practice, some modules have become the shared surface by accident. For example, `src/kilo-actions.ts` exports Flue actions, task services, persistence helpers, session discovery, process supervision, transcript adapters, and UI enrichment in one place.

The target should be:

- Domain services own behavior.
- Flue action files are adapters around domain services.
- Hono routes are adapters around the same domain services.
- CLI commands are adapters around the same domain services.
- React talks to typed API clients and feature hooks, not one giant API module.

### TypeScript Contracts Drift

`web/src/api.ts` duplicates many backend response shapes by hand. This is understandable early on, but it is now a maintenance risk. Backend schemas, API return values, and frontend types can drift without a clear compile-time or runtime signal.

### Repeated Low-Level Patterns

Common patterns appear in many files:

- `parseInput` helpers around Valibot.
- `ok`/`failed` action result shapes.
- `DatabaseSync` query casts.
- row parsers for nullable strings and JSON columns.
- GitHub error handling and pagination.
- query invalidation and SSE parsing on the frontend.
- small UI row/status-pill components repeated inside large plugin files.

These are good candidates for small shared utilities once their interfaces are clear.

### Large React Plugins Have Too Much State Surface

`RuntimeOverview.tsx` currently owns query composition, event stream invalidation, runtime config forms, row rendering, status classification, formatting helpers, and many feature sections. `FlueChat.tsx` owns the chat shell, session selector, command typeahead, command execution, message rendering, and event part formatting.

This makes UI bugs harder to isolate and causes unrelated changes to collide.

## Target Architecture

Use domain-first modules with thin adapters.

Recommended backend shape:

```text
src/
  contracts/
    api/
    events/
    shared.ts
  lib/
    action-result.ts
    db.ts
    errors.ts
    json.ts
    paths.ts
    process.ts
    valibot.ts
  domains/
    autopilot/
    kilo/
    worktrees/
    config/
    sessions/
    github/
    commands/
    runtime-home/
    watches/
    runtime-status/
  app/
    routes/
```

Domain module convention:

```text
src/domains/<domain>/
  actions.ts       # Flue action/tool definitions only
  service.ts       # public use cases and orchestration
  store.ts         # SQLite queries and row mapping
  schemas.ts       # Valibot schemas and inferred public types
  policy.ts        # domain policy and state classification
  clients.ts       # external API/CLI adapters, when needed
  format.ts        # summaries, messages, prompt fragments, when needed
  index.ts         # stable exports for other domains
```

Not every domain needs every file. Keep folders small and only create files when there is real code to move.

Adapter rule:

- `actions.ts` should mostly parse input, call `service.ts`, and convert exceptions into action results.
- Hono routes should mostly parse request bodies, call `service.ts`, and return JSON.
- CLI commands should mostly parse argv/prompt data, call `service.ts`, and print.
- No adapter should contain SQL, process supervision, GitHub GraphQL details, or complex domain policy.

## Proposed Backend Boundaries

### Autopilot

Current file: `src/autopilot-workflows.ts`

Target:

```text
src/domains/autopilot/
  actions.ts
  schemas.ts
  service.ts
  triage.ts
  worktree-prep.ts
  ci-fix.ts
  review-feedback.ts
  push.ts
  comments.ts
  fixtures.ts
  github-facts.ts
  diagnostics.ts
  format.ts
```

Boundary details:

- `actions.ts` exports `neondeckAutopilotActions` and Flue action declarations.
- `service.ts` exports stable use cases such as `triagePrEvent`, `preparePrWorktree`, `verifyPrWorktree`, `fixPrCiFailure`, `fixPrReviewFeedback`, `commentPrAutofixResult`, and `pushPrAutofix`.
- `github-facts.ts` converts GitHub details into workflow facts.
- `triage.ts` owns signal classification and reasons.
- `ci-fix.ts` owns failing-check diagnosis and generated fix planning.
- `review-feedback.ts` owns review comment grouping, target file reading, edit planning, and addressed-feedback summaries.
- `push.ts` owns push gates, block reasons, branch permissions, and remote selection.
- `fixtures.ts` owns static smoke-test fixture behavior, isolated from production paths.

Keep Flue workflows as bounded work units. Do not recreate Flue run state in this domain. Store only Neondeck product state such as prepared diffs, audit events, and push decisions.

### Kilo

Current file: `src/kilo-actions.ts`

Target:

```text
src/domains/kilo/
  actions.ts
  tools.ts
  schemas.ts
  service.ts
  store.ts
  process-supervisor.ts
  event-log.ts
  sessions/
    index.ts
    cli-adapter.ts
    sdk-adapter.ts
    disk-adapter.ts
    normalize.ts
    transcripts.ts
  handoff.ts
  policy.ts
  diff.ts
  notifications.ts
  format.ts
```

Boundary details:

- `process-supervisor.ts` owns spawned Kilo processes, stream handling, terminal state, and in-memory running-process maps.
- `event-log.ts` owns raw log persistence and event summaries.
- `store.ts` owns `kilo_tasks`, task events, row parsing, and status updates.
- `sessions/*` owns Kilo session discovery from CLI, SDK, and disk without leaking adapter-specific shapes.
- `handoff.ts` owns prompt construction and workspace resolution.
- `policy.ts` owns mode/repo/autopilot policy checks.
- `diff.ts` owns task diff summaries and result placeholders.

This keeps the action surface small while preserving low-friction Kilo delegation.

### Worktrees

Current file: `src/worktrees.ts`

Target:

```text
src/domains/worktrees/
  actions.ts
  tools.ts
  schemas.ts
  service.ts
  store.ts
  locks.ts
  cleanup.ts
  git.ts
  paths.ts
  policy.ts
  events.ts
```

Boundary details:

- `service.ts` owns create/sync/status/list operations.
- `locks.ts` owns lock acquisition and release, including uniqueness handling.
- `cleanup.ts` owns cleanup decision logic and cleanup attempts.
- `git.ts` owns all `git` subprocess calls for this domain.
- `paths.ts` owns worktree root resolution, slugging, containment checks, and adoptability checks.
- `store.ts` owns row parsing and SQL.

This split should happen before deeper autopilot cleanup because autopilot and Kilo both depend on worktree behavior.

### Config

Current file: `src/config-actions.ts`

Target:

```text
src/domains/config/
  actions.ts
  schemas.ts
  service.ts
  files.ts
  history.ts
  repos.ts
  schedules.ts
  models.ts
  providers.ts
  dashboard.ts
  execution.ts
  worktrees.ts
  discovery.ts
```

Boundary details:

- Keep typed config mutation as the only normal path for Neondeck config changes.
- `files.ts` owns read/write of config JSON files.
- `history.ts` owns config history records.
- `discovery.ts` owns filesystem, git remote, default branch, and package script discovery.
- The other files own narrow mutation domains.

Do not add confirmation friction in this refactor. Preserve the current product choice unless a separate product decision changes it.

### Sessions

Current file: `src/session-actions.ts`

Target:

```text
src/domains/sessions/
  actions.ts
  schemas.ts
  service.ts
  store.ts
  active-session.ts
  summaries.ts
  references.ts
  events.ts
  metadata.ts
```

Boundary details:

- `store.ts` owns session rows and active-session rows.
- `active-session.ts` owns current session selection per surface.
- `summaries.ts` owns summary freshness and utility-model title/summary refresh.
- `references.ts` owns linked-session find-or-create behavior.
- `events.ts` owns session event publishing.

This should also support making linked session creation idempotent server-side.

### GitHub

Current file: `src/github.ts`

Target:

```text
src/domains/github/
  client.ts
  schemas.ts
  queue.ts
  pull-requests.ts
  checks.ts
  reviews.ts
  comments.ts
  graphql.ts
  cache.ts
  errors.ts
```

Boundary details:

- `client.ts` owns authenticated REST/GraphQL requests, pagination, timeouts, and error mapping.
- `queue.ts` owns PR queue search queries and ranking helpers.
- `pull-requests.ts` owns PR detail and commit fetching.
- `checks.ts` owns check suites, check runs, annotations, and failing check facts.
- `reviews.ts` owns requested-changes state and review threads.
- `comments.ts` owns PR comment posting.
- `schemas.ts` owns GitHub API response Valibot schemas.

Keep the public exports stable during migration so `github-actions.ts`, `watch-actions.ts`, autopilot, commands, and routes can move gradually.

### Commands

Current file: `src/commands.ts`

Target:

```text
src/domains/commands/
  actions.ts
  schemas.ts
  parser.ts
  registry.ts
  service.ts
  handlers/
    briefing.ts
    review-queue.ts
    watch.ts
    schedule.ts
    model.ts
    memory.ts
    doctor.ts
    session.ts
  summaries.ts
```

Boundary details:

- `registry.ts` owns command metadata.
- `parser.ts` owns slash command parsing and argument splitting.
- `handlers/*` own command-specific behavior.
- `summaries.ts` owns compact result summaries.
- `actions.ts` exposes the Flue command action only.

This keeps future TUI/OpenTUI command reuse simple.

### Runtime Home

Current file: `src/runtime-home.ts`

Target:

```text
src/domains/runtime-home/
  paths.ts
  schemas/
    app-config.ts
    repos.ts
    dashboard.ts
    schedules.ts
    execution.ts
    worktrees.ts
    autopilot.ts
    kilo.ts
  defaults.ts
  files.ts
  bootstrap.ts
  app-db/
    schema.ts
    migrations.ts
    reconcile.ts
  flue-db.ts
  validation.ts
  index.ts
```

Boundary details:

- `paths.ts` owns `NEONDECK_HOME`, `XDG_CONFIG_HOME`, and path resolution.
- `schemas/*` owns config schemas and inferred types.
- `bootstrap.ts` owns first-run directory/file creation.
- `app-db/schema.ts` owns SQLite table DDL.
- `app-db/migrations.ts` owns column additions and schema migrations.
- `app-db/reconcile.ts` owns legacy and active-row reconciliation.
- `validation.ts` owns JSON parse and config validation.

This is a high-value split because almost every domain imports runtime paths or schemas.

## Proposed Frontend Boundaries

### API Client

Current file: `web/src/api.ts`

Target:

```text
web/src/api/
  http.ts
  events.ts
  types.ts
  runtime.ts
  config.ts
  sessions.ts
  github.ts
  worktrees.ts
  kilo.ts
  autopilot.ts
  watches.ts
  workflows.ts
  memory.ts
  notifications.ts
  repos.ts
```

Boundary details:

- `http.ts` owns `getJson`, `postJson`, content-type fallback, empty body handling, abort signals, and API-token headers if used.
- `events.ts` owns EventSource creation and guarded event parsing.
- Domain files own endpoint-specific functions.
- `types.ts` should be generated or copied from shared contract types, not hand-maintained forever.

Near-term improvement:

- Keep endpoint functions stable by re-exporting from `web/src/api.ts` while moving implementation into `web/src/api/*`.
- Add response validation only for high-risk boundaries first: dashboard config, runtime status, sessions, and Kilo/autopilot mutations.

### Runtime Overview

Current file: `web/src/plugins/RuntimeOverview.tsx`

Target:

```text
web/src/features/runtime-overview/
  plugin.tsx
  queries.ts
  snapshot.ts
  components/
    RuntimeView.tsx
    RuntimeHome.tsx
    RuntimeConfigControls.tsx
    FirstRunSetup.tsx
    Readiness.tsx
    Notifications.tsx
    SafetyPolicy.tsx
    ExecutionApprovals.tsx
    RepoEdits.tsx
    KiloTasks.tsx
    Worktrees.tsx
    Workflows.tsx
    Repos.tsx
    Jobs.tsx
    Skills.tsx
    Memories.tsx
  forms/
    ModelConfigForm.tsx
    ProviderConfigForm.tsx
    WorktreePolicyForm.tsx
  lib/
    classes.ts
    formatting.ts
    setup-steps.ts
```

Boundary details:

- `queries.ts` owns React Query calls and invalidations.
- `snapshot.ts` combines query results into the current runtime snapshot.
- Forms should keep local dirty state and avoid resetting while focused.
- Row components should not mutate query data.
- Formatting helpers should be pure.

The plugin export can stay in `web/src/plugins/RuntimeOverview.tsx` as a compatibility shim during migration.

### Flue Chat

Current file: `web/src/plugins/FlueChat.tsx`

Target:

```text
web/src/features/flue-chat/
  plugin.tsx
  queries.ts
  command-catalog.ts
  components/
    ChatShell.tsx
    SessionSelect.tsx
    SessionOptionGroup.tsx
    MessageList.tsx
    MessagePart.tsx
    ChatPartEvent.tsx
    CommandTypeahead.tsx
    CommandResultSummary.tsx
  lib/
    message-parts.ts
    command-filter.ts
    session-labels.ts
```

Boundary details:

- Keep Flue React/client integration in one place.
- Move message-part parsing out of render components.
- Move command catalog merging and filtering into pure helpers.
- Make session reference creation call a server-side idempotent endpoint once available.

## Cross-Cutting Conventions

### Public Type and Schema Pattern

For each domain:

```ts
export const thingInputSchema = v.object({ ... });
export type ThingInput = v.InferOutput<typeof thingInputSchema>;

export const thingResultSchema = v.object({ ... });
export type ThingResult = v.InferOutput<typeof thingResultSchema>;
```

Prefer `v.InferOutput` from Valibot schemas over separately maintained interfaces when values cross API/action boundaries.

### Action Result Pattern

Add one shared helper:

```text
src/lib/action-result.ts
```

It should provide:

- `okAction(action, payload)`
- `failedAction(action, message, details?)`
- `invalidInputAction(action, issues)`
- consistent `JsonValue` conversion

This removes repeated `failResult`, `invalidInputResult`, and `asJsonValue` helpers.

### Database Pattern

Add a small SQLite helper layer, not an ORM:

```text
src/lib/db.ts
```

It should provide:

- `openAppDb(paths)`
- typed `parseRow(row, schema, context)`
- JSON column read/write helpers
- common nullable string/number schemas
- unique-constraint detection

Keep SQL explicit in domain `store.ts` files. Avoid a generic repository abstraction.

### External Client Pattern

External clients should return domain types, not raw API payloads. Keep request mechanics centralized:

- timeout and abort handling
- pagination
- auth headers
- API error messages
- Valibot response parsing

Apply first to GitHub, then Kilo session adapters.

### Filesystem and Process Pattern

Keep subprocess and filesystem operations behind small adapters:

- `src/lib/process.ts` for `execFile` wrappers, timeout handling, and error normalization.
- domain-local `git.ts` when command semantics are domain-specific.
- no direct `execFile` or `spawn` in action definitions.

### Frontend Query Pattern

For each feature:

```text
queries.ts
```

Owns:

- query keys
- query functions
- mutation functions
- invalidation rules
- event stream subscriptions for the feature

Components should call hooks from `queries.ts`, not raw API functions directly when the workflow has cache implications.

### File Size Guide

This is a guideline, not a hard rule:

- Aim for most modules under 400 lines.
- Review modules over 700 lines for another split.
- Keep React components under 250 lines unless they are simple markup.
- Keep `actions.ts` files under 250 lines by moving implementation to services.

Large files are acceptable only when they are generated, mostly declarative schemas, or clearly a cohesive table of static data.

### Compatibility Shims

During migration, keep the old public file path as a shim:

```ts
export * from './domains/worktrees';
```

Do this for files with many current imports:

- `src/runtime-home.ts`
- `src/worktrees.ts`
- `src/github.ts`
- `src/config-actions.ts`
- `src/session-actions.ts`
- `src/kilo-actions.ts`
- `src/autopilot-workflows.ts`
- `web/src/api.ts`

Remove shims only after imports are migrated and tests cover the new paths.

## Phased Implementation Order

### Phase 0: Guardrails and Inventory

Deliverables:

- Add this proposal to `.plans/`.
- Add a lightweight file-size report script or CI note for human review. Do not fail CI yet.
- Identify public exports per large module and write down which imports must remain stable.

Verification:

- Static import graph review.
- No production code movement yet.

### Phase 1: Shared Utilities With Low Risk

Deliverables:

- `src/lib/action-result.ts`
- `src/lib/db.ts`
- `src/lib/process.ts`
- `src/lib/json.ts`
- `web/src/api/http.ts`
- `web/src/api/events.ts`

Migration candidates:

- repeated action result helpers
- repeated row parsing helpers
- repeated `execFile` wrappers
- frontend `getJson`, `postJson`, and EventSource parsing

Verification:

- Unit tests for shared helpers.
- Existing action output snapshots or focused tests where present.

### Phase 2: Runtime Home Split

Deliverables:

- Move config schemas to `src/domains/runtime-home/schemas/*`.
- Move path resolution to `paths.ts`.
- Move bootstrap/default file writes to `bootstrap.ts` and `defaults.ts`.
- Move SQLite DDL/migrations/reconciliation into `app-db/*`.
- Keep `src/runtime-home.ts` as a re-export shim.

Why first:

- Almost every domain depends on runtime paths and schemas.
- This reduces import churn for later phases.

Verification:

- `runtime-home` unit tests.
- Fresh runtime smoke tests when ready.
- Static review of default config output.

### Phase 3: Worktrees Split

Deliverables:

- Extract worktree schemas, store, locks, cleanup, git, paths, and services.
- Keep current public functions exported through `src/worktrees.ts`.

Why next:

- Autopilot and Kilo rely on worktree isolation and locks.
- A clean worktree boundary makes later autonomy code easier to reason about.

Verification:

- Worktree unit tests.
- Focused static review for lock uniqueness and cleanup semantics.

### Phase 4: GitHub Client Split

Deliverables:

- Extract request mechanics and API schemas into `src/domains/github/client.ts` and `schemas.ts`.
- Move queue, checks, reviews, comments, and PR detail into separate modules.
- Keep `src/github.ts` as a compatibility shim.

Why before autopilot:

- Autopilot, watches, commands, and GitHub routes all depend on the GitHub layer.

Verification:

- GitHub unit tests.
- Fixture-based parsing tests for REST/GraphQL responses.

### Phase 5: Config and Sessions

Deliverables:

- Split config mutation domains and file/history helpers.
- Split session store, active-session selection, summaries, references, and events.
- Add server-side idempotent linked-session reference behavior in the sessions domain as part of the extraction.

Why here:

- Config and sessions are stable, broad dependencies for dashboard and chat work.

Verification:

- Config action tests.
- Session action tests.
- Static review of current confirmation behavior to ensure no product friction changes are introduced accidentally.

### Phase 6: Kilo Domain Split

Deliverables:

- Extract Kilo store and process supervisor first.
- Extract Kilo session adapters second.
- Extract handoff policy, prompts, task events, and diff enrichment.
- Keep `src/kilo-actions.ts` as a shim while Flue action exports remain stable.

Why after worktrees and sessions:

- Kilo relies on worktree locks and session linkage.

Verification:

- Kilo action tests.
- Kilo smoke tests when available.
- Manual static review of process cleanup and persisted-running-task reconciliation.

### Phase 7: Autopilot Domain Split

Deliverables:

- Extract triage and classification.
- Extract worktree prep and verification.
- Extract CI fix and review feedback flows.
- Extract push gates and comments.
- Keep `src/autopilot-workflows.ts` as a shim.

Why later:

- Autopilot has the most dependencies and should benefit from previous splits.

Verification:

- Autopilot workflow tests.
- Prepared diff tests.
- Static review for Flue boundaries: actions and workflows should orchestrate bounded units, not duplicate Flue run persistence.

### Phase 8: Commands and CLI

Deliverables:

- Split command parser, registry, handlers, and summaries.
- Split CLI command registration, onboarding wizard, env writing, prompt helpers, and printers.

Why here:

- Commands depend on many domains and should be migrated after those domain services are stable.

Verification:

- Command parser tests.
- Existing command tests.
- Static review for shared service reuse.

### Phase 9: Frontend API and Feature Splits

Deliverables:

- Move `web/src/api.ts` into `web/src/api/*` with a compatibility export.
- Split Runtime Overview into feature components, hooks, and pure formatting helpers.
- Split Flue Chat into session selector, message renderer, command typeahead, and command result components.
- Add plugin config parsers at plugin boundaries.

Why near the end:

- Backend contracts should stabilize first.
- UI splits are easier once API functions and response types are cleaner.

Verification:

- React component tests where useful.
- Static review of query invalidations and form dirty-state handling.
- Browser smoke pass when implementation begins.

## Risk Plan

### Import Churn

Risk: large refactors create noisy diffs and merge conflicts.

Mitigation:

- Use re-export shims.
- Move one domain at a time.
- Avoid renaming public functions during extraction.
- Prefer mechanical move commits followed by cleanup commits.

### Behavior Drift

Risk: extracted services subtly change action outputs or status classification.

Mitigation:

- Preserve existing tests and add focused tests before changing behavior.
- Keep action result shapes stable.
- Snapshot representative action results only where high signal.

### Circular Dependencies

Risk: domains such as autopilot, Kilo, worktrees, and sessions depend on each other.

Mitigation:

- Allow dependencies from high-level domains to lower-level domains.
- Avoid lower-level domains importing high-level domains.
- Suggested direction:
  - `runtime-home`, `lib`, `github`, `worktrees`, `sessions`, `config`
  - `kilo`, `watches`, `commands`
  - `autopilot`
  - `app routes`, `Flue actions`, `CLI`

### Over-Abstraction

Risk: introducing generic repositories, factories, or containers makes the code harder to understand.

Mitigation:

- Keep SQL explicit.
- Keep services as plain functions.
- Keep dependencies passed only where tests or fixtures need it.
- Do not create base classes.

### Flue Boundary Regression

Risk: refactors accidentally reproduce Flue concepts or hide workflow/action behavior.

Mitigation:

- Flue actions stay thin schema-backed adapters.
- Flue workflows remain bounded operations with run records.
- Neondeck app DB stores product state only.
- Flue DB remains Flue runtime persistence.
- Do not create a parallel generic workflow runner inside Neondeck.

## Verification Plan

Static checks during each phase:

- Review changed import graph.
- Confirm no adapter contains SQL or external API mechanics after extraction.
- Confirm public exports remain compatible.
- Confirm file-size pressure decreases.

Fast automated checks when implementation begins:

```sh
npm run lint
npm run typecheck
npm run test
```

Broader checks for phases touching worktrees, Kilo, autopilot, runtime home, or app routes:

```sh
npm run test:integration
npm run verify
```

The implementation owner can choose the right level per phase. The proposal itself does not require running tests.

## Definition of Done

The refactor is successful when:

- The largest product files are compatibility shims or cohesive modules, not mixed-concern implementations.
- Flue action files contain action declarations and thin calls into services.
- Hono routes call domain services and do not duplicate business rules.
- CLI commands reuse the same services as chat and dashboard flows.
- Frontend API functions are domain-scoped and have guarded parsing for important responses/events.
- Runtime Overview and Flue Chat are split into feature folders with focused components and hooks.
- New code has fewer unchecked `as` casts, fewer duplicated row parsers, and fewer hand-maintained duplicate contracts.
- Future autonomy work can add behavior by creating small service modules instead of extending 2,000 to 4,000 line files.
