# Neondeck Modularization Refactor Plan

Status: **active** — this document supersedes `.plans/CLEAN_ARCHITECTURE_PROPOSAL.md` (deleted; see git history).

Snapshot date: 2026-07-03. If you are an implementation agent picking this up later, regenerate the
inventory first (see "Regenerating The Inventory" below) and reconcile before starting a phase —
this codebase moves fast and line counts below are a snapshot, not a contract.

## Purpose

Break Neondeck's large mixed-concern modules into small, composable TypeScript modules organized by
domain, so that Flue actions, Hono routes, workflows, CLI commands, and React panels are all thin
adapters over the same domain services. This is a mechanical, behavior-preserving refactor — not a
rewrite, not a framework migration.

This document is written for implementation agents. Each phase is sized to land as one focused PR
with `npm run check` green and the relevant integration suites passing.

## Goals

- Domain services own behavior; every other surface (actions, routes, workflows, CLI, commands,
  chat) adapts to them.
- No product file over ~700 lines unless it is declarative data, a schema table, or a shim.
- Shared low-level patterns (action results, SQLite row parsing, subprocess wrappers, HTTP/SSE
  client mechanics) live in one place each.
- The frontend API client and the two giant plugins become domain-scoped modules and feature
  folders.
- Future work (TUI, more autonomy) adds small modules instead of extending 2,000–4,000 line files.

## Non-Goals

- No behavior changes. Action result shapes, route responses, SQL schema, and event payloads stay
  byte-compatible during extraction. Behavior fixes go in separate PRs.
- No npm workspace / multi-package split for the app. Neondeck is one deployable (Flue server +
  Vite dashboard) plus the existing `docs/` workspace. Folder modules with layering rules give the
  same composability without build-tooling churn. Revisit only if a piece needs independent
  publishing (none does today).
- No dependency-injection container, no base classes, no generic repository/ORM. SQL stays explicit
  in domain stores; services stay plain functions. (Drizzle is adopted for schema definition and
  migrations only, per `.plans/DB_MIGRATIONS_PLAN.md` — its query builder is not adopted in
  stores.)
- No replacement of Flue primitives. Flue actions/workflows/agents remain the orchestration layer;
  Neondeck's app DB stores product state only, Flue's DB stores Flue runtime state.
- No trust-posture or approval-friction changes. `safety.ts` policy semantics are preserved
  exactly; only its file layout changes.
- No visual redesign of the dashboard.

## Current State Inventory (2026-07-03)

~83,000 lines of TypeScript across `src/` and `web/src/`. `src/` is almost entirely flat: ~60
top-level modules plus a handful of directories.

### What is already good (preserve these patterns)

- `src/repo-edit/` — already a model domain module: `index.ts` (service), `schemas.ts`, `git.ts`,
  `locks.ts`, `audit.ts`, `patch-parser.ts`, `path-safety.ts`, `fuzzy-replace.ts`. New domain
  folders should look like this. (Its `index.ts` at 1,566 lines still needs an internal split, but
  the folder shape is right.)
- `src/workflows/*` — 22 thin `defineWorkflow` files (~10 lines each) that import an action and an
  agent. These are exactly the adapter shape we want everywhere. Do not touch them except to update
  import paths.
- `src/agents/`, `src/skills/`, `src/sandboxes/` — small, purpose-scoped directories.
- Colocated `*.test.ts` files with separate unit/integration Vitest configs. Tests move together
  with the code they cover.

### Oversized backend files

| File                            | Lines | What's inside                                                                                                                                                                   |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/autopilot-workflows.ts`    | 4,184 | 8 Flue action defs + 7 large workflow use-case functions (triage, worktree prep/verify, CI fix, review feedback, push, comment) + GitHub fact gathering + fixtures + formatting |
| `src/kilo-actions.ts`           | 2,564 | 13 action defs + task lifecycle services + session discovery (CLI/SDK/disk) + transcript reading + diff summaries                                                               |
| `src/learning-reviews.ts`       | 2,422 | Review record types/schemas, agent profile + coordinator, review preparation for 3 review kinds, completion/failure transitions, event recording, SQLite store                  |
| `src/app.ts`                    | 2,190 | Hono app with **141 inline routes** + auth middleware + SSE endpoints + static serving                                                                                          |
| `src/config-actions.ts`         | 2,067 | 37 exports: config read/validate/reload + repo/schedule/model/provider/dashboard/execution/worktree mutations + discovery                                                       |
| `src/session-actions.ts`        | 2,059 | 38 exports: session store, active-session selection, summaries/titles, references, events                                                                                       |
| `src/worktrees.ts`              | 2,042 | Worktree create/sync/status/cleanup, locks, git subprocess calls, path/slug policy, SQLite store                                                                                |
| `src/memory-actions.ts`         | 2,013 | 12 action defs + memory CRUD/merge/rewrite/archive + candidates + events + SQLite store                                                                                         |
| `src/safety.ts`                 | 2,010 | ~1,800 lines of **declarative policy entries** (lines 105–1900) + types + lookup tool + summary logic                                                                           |
| `src/runtime-home.ts`           | 1,965 | 63 exports; **fan-in of 44 non-test modules** — paths, config schemas, defaults, bootstrap, app-DB DDL/migrations, validation                                                   |
| `src/github.ts`                 | 1,838 | REST/GraphQL client mechanics + queue search + PR details + checks + reviews + comments + response schemas                                                                      |
| `src/cli.ts`                    | 1,825 | Commander program: all subcommands, onboarding wizard, env writing, printers — zero exports, one file                                                                           |
| `src/commands.ts`               | 1,790 | Slash-command registry + parser + all handlers + summaries                                                                                                                      |
| `src/watch-actions.ts`          | 1,572 | PR/release watch actions, watch state store, polling logic                                                                                                                      |
| `src/repo-edit/index.ts`        | 1,566 | Service + store + event plumbing for repo edits (folder already exists; file needs internal split)                                                                              |
| `src/prepared-diffs.ts`         | 1,546 | Prepared-diff store, apply/verify logic, formatting                                                                                                                             |
| `src/kilo-results.ts`           | 1,436 | Kilo result promotion/verification/review services (imports `verifyPrWorktree` from autopilot — layering violation to fix)                                                      |
| `src/execution-actions.ts`      | 1,429 | Execution policy actions, approvals, run orchestration across backends                                                                                                          |
| `src/scheduler.ts`              | 1,301 | Job store, tick loop, schedule evaluation, job execution dispatch                                                                                                               |
| `src/autopilot.ts`              | 1,091 | Autopilot state machine / orchestration entry                                                                                                                                   |
| `src/skill-patches.ts`          | 1,070 | Learning skill-patch proposals, application, restore, audit                                                                                                                     |
| `src/pr-event-state.ts`         | 1,040 | PR event dedupe/state store                                                                                                                                                     |
| `src/autopilot-policy.ts`       | 970   | Autopilot gate policy                                                                                                                                                           |
| `src/runtime-status.ts`         | 802   | Runtime readiness checks                                                                                                                                                        |
| `src/runtime-skills.ts`         | 795   | Skill discovery/validation                                                                                                                                                      |
| `src/app-state.ts`              | 741   | App notification/state/event store helpers                                                                                                                                      |
| `src/kilo-task-store.ts`        | 689   | Kilo task SQLite store                                                                                                                                                          |
| `src/sandboxes/exedev.ts`       | 676   | exe.dev sandbox adapter                                                                                                                                                         |
| `src/repo-edit/git.ts`          | 669   | Repo-edit git subprocess helpers                                                                                                                                                |
| `src/workflow-observability.ts` | 611   | Workflow run/event observability store                                                                                                                                          |
| `src/autopilot-recovery.ts`     | 601   | Autopilot recovery actions and summaries                                                                                                                                        |
| `src/dev-doctor.ts`             | 532   | Runtime diagnostic checks                                                                                                                                                       |
| `src/execution-policy.ts`       | 488   | Execution policy evaluation                                                                                                                                                     |
| `src/learning-operator.ts`      | 404   | Learning operator dashboard state                                                                                                                                               |

### Oversized frontend files

| File                                        | Lines | What's inside                                                                                                                                                                                                                  |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web/src/plugins/RuntimeOverview.tsx`       | 2,542 | 30 components in one file: runtime view, config controls/forms, first-run setup, readiness, notifications, safety, approvals, repo edits, Kilo tasks, worktrees, workflows, repos, jobs, skills, memories + formatting helpers |
| `web/src/api.ts`                            | 1,710 | 130 exports: hand-maintained response types + fetch helpers + EventSource parsing + every endpoint function for every domain                                                                                                   |
| `web/src/plugins/FlueChat.tsx`              | 1,104 | Chat shell, session select, message rendering, event part formatting, command typeahead, command result summary                                                                                                                |
| `web/src/plugins/AutopilotPanel.tsx`        | 556   | Borderline; revisit after the feature-folder pattern exists                                                                                                                                                                    |
| `web/src/App.tsx`                           | 518   | Dashboard shell, plugin layout, and shared app state wiring                                                                                                                                                                    |
| `web/src/plugins/LearningOperatorPanel.tsx` | 513   | Same                                                                                                                                                                                                                           |

### Duplicated low-level patterns (measured)

- 21 non-test files define their own `failResult` / `invalidInputResult` / `asJsonValue`-style
  action-result helpers.
- 24 non-test files open or cast `DatabaseSync` and hand-roll row parsing.
- 7 files define a local `parseInput` Valibot wrapper.
- 8 files wrap `execFile` with their own timeout/error normalization.
- `web/src/api.ts` repeats `getJson`/`postJson`/EventSource-parsing mechanics ~53 times.

## Target Architecture

Single package. Folder modules with an explicit layering rule, enforced by review (optionally by a
lint import rule later — see Phase 12).

```text
src/
  lib/                    # layer 0: shared utilities, no domain imports
    action-result.ts      # ok/failed/invalid-input helpers + JsonValue conversion
    sqlite.ts             # openDb, parseRow(row, schema, ctx), JSON-column helpers, unique-violation detection
    exec.ts               # execFile/spawn wrappers: timeout, abort, error normalization
    valibot.ts            # parseInput and shared mini-schemas (nullable string, ISO date, JSON column)
    json.ts
  runtime-home/           # layer 1: paths + config schemas + app DB (fan-in 44 — everything sits on this)
  modules/                # layers 2–4, see dependency direction below
    github/
    worktrees/
    sessions/
    config/
    repos/                # existing repos.ts, providers.ts, model-discovery.ts fold in here
    safety/
    execution/
    memory/
    repo-edit/            # already exists; internal split only
    kilo/
    watches/
    scheduler/
    autopilot/
    learning/
    commands/
  server/                 # layer 5: Hono adapters
    app.ts                # app assembly: middleware + mounting sub-routers + static serving
    middleware.ts         # local API auth, Flue run inspection token
    routes/               # one sub-router per module (sessions.ts, kilo.ts, autopilot.ts, ...)
    events/               # SSE endpoints (config, notifications, sessions)
  cli/                    # layer 5: Commander adapters
    index.ts              # program assembly (bin target)
    commands/             # one file per subcommand group
    onboarding.ts         # init wizard
    output.ts             # printers/formatters
  workflows/              # unchanged thin Flue workflow defs (imports update only)
  agents/                 # unchanged
  skills/                 # unchanged
  sandboxes/              # unchanged (exedev adapter; consumed by modules/execution)

web/src/
  api/                    # layer split of api.ts
    http.ts               # getJson/postJson, content-type fallback, empty-body, abort, auth header
    events.ts             # EventSource creation + guarded parsing
    types.ts              # cross-module response types (until generated from backend contracts)
    <module>.ts           # runtime.ts, sessions.ts, kilo.ts, autopilot.ts, learning.ts, memory.ts, ...
  features/               # feature folders backing the plugin registry
    runtime-overview/
    flue-chat/
    ...                   # other panels adopt the pattern opportunistically
  plugins/                # registry + thin plugin entries (compat shims during migration)
  components/             # shared UI atoms (StatusPill, rows, Metric, etc. promoted from plugins)
  lib/
```

### Module Convention

```text
src/modules/<module>/
  index.ts        # the module's public surface; other modules import ONLY from here
  actions.ts      # Flue defineAction/defineTool declarations — parse input, call service, map errors
  schemas.ts      # Valibot schemas + v.InferOutput types for anything crossing a boundary
  service.ts      # use cases / orchestration (may be several files for big modules)
  store.ts        # SQLite SQL + row mapping (may be several files)
  policy.ts       # domain policy / classification, when it exists
  format.ts       # summaries, prompt fragments, UI-facing strings, when they exist
  events.ts       # event publishing, when it exists
```

Only create files that have real code to hold. `src/repo-edit/` is the reference example.

### Adapter rules

- `actions.ts` files: parse input → call service → convert exceptions to action results. Target
  under 250 lines; no SQL, no subprocess calls, no GitHub API mechanics.
- `server/routes/*`: parse request → call service → return JSON. No business rules.
- `cli/commands/*`: parse argv → call service → print. No business rules.
- `workflows/*`: stay exactly as they are — `defineWorkflow({ agent, action })`.
- React components call hooks from a feature's `queries.ts`, not raw API functions, whenever the
  call has cache implications.

### Dependency direction (must hold; violations are bugs to fix during extraction)

```text
lib
  └── runtime-home
        └── github, worktrees, sessions, repos, safety, memory, repo-edit      (leaf modules)
              └── config, execution, kilo, watches, scheduler, prepared-diffs  (mid modules)
                    └── autopilot, learning, commands                          (orchestration modules)
                          └── server routes, workflows, agents, cli            (adapters)
```

Known existing violation to resolve: `src/kilo-results.ts` imports `verifyPrWorktree` from
`src/autopilot-workflows.ts` (a lower layer importing a higher one). Fix during Phase 8/9 by moving
worktree verification into `modules/worktrees` (it is fundamentally a worktree operation) so both
kilo and autopilot call down to it.

### Compatibility shims

Every extraction keeps the old top-level file as a re-export shim until all importers migrate:

```ts
// src/worktrees.ts (during migration)
export * from './modules/worktrees';
```

Shim rules:

- Never rename a public export during extraction. Renames are follow-up PRs.
- A shim is removed only in a dedicated commit after `grep` shows zero remaining importers and
  `npm run check` passes.
- Tests migrate with the code (move `foo.test.ts` next to the module that now owns the logic;
  splitting a big test file mirrors the source split).

### File size guide

Guideline, not CI-enforced (yet):

- Modules: aim under 400 lines; anything over 700 needs a reason in review.
- React components: under 250 lines unless purely markup.
- `actions.ts` under 250 lines.
- Exemptions: declarative tables (the safety policy entries), schema-only files, generated code,
  shims.

## Phase Plan

Each phase = one PR. Every phase ends with `npm run check` green; phases marked ⚙ also run
`npm run test:integration` (worktree/kilo/autopilot/learning suites). Update the status column when
you land a phase.

| Phase | Scope                                                                 | Status |
| ----- | --------------------------------------------------------------------- | ------ |
| 0     | Guardrails: size report script, inventory check                       | done   |
| 1     | `src/lib/` shared utilities                                           | done   |
| 2     | `runtime-home` split ⚙                                                | done   |
| 3     | `server/` route split of `app.ts`                                     | done   |
| 4     | `modules/github`                                                      | done   |
| 5     | `modules/worktrees` ⚙                                                 | done   |
| 6     | `modules/sessions` + `modules/config` + `modules/repos`               | done   |
| 7     | `modules/safety` + `modules/execution`                                | done   |
| 8     | `modules/kilo` ⚙                                                      | todo   |
| 9     | `modules/autopilot` ⚙                                                 | todo   |
| 10    | `modules/learning` + `modules/memory` ⚙                               | todo   |
| 11    | `modules/watches` + `modules/scheduler` + `modules/commands` + `cli/` | todo   |
| 12    | Shim removal + import-direction lint                                  | todo   |
| 13    | Frontend `web/src/api/` split                                         | todo   |
| 14    | Frontend feature folders: runtime-overview, flue-chat                 | todo   |

Phases 4–11 are mostly independent of each other once 1–3 land; agents can reorder or parallelize
them if they coordinate on shims. 13–14 need 3 (route stability) but not the backend domain phases.

---

### Phase 0: Guardrails

Deliverables:

- `scripts/file-size-report.mjs`: prints non-test `.ts`/`.tsx` files over 400 lines under `src/`
  and `web/src/`, sorted desc. Wire as `npm run report:file-sizes`. Informational only — do not
  fail CI.
- Confirm this document's inventory still matches reality; correct it if not.

Verification: script runs; no production code changes.

### Phase 1: Shared utilities (`src/lib/`)

Deliverables:

- `src/lib/action-result.ts` — `okAction`, `failedAction`, `invalidInputAction`, `asJsonValue`.
  Match the exact result shapes currently produced (they are the API contract).
- `src/lib/sqlite.ts` — db open helper, `parseRow(row, schema, context)`, JSON column read/write,
  nullable-column mini-schemas, unique-constraint detection. Explicitly not an ORM.
- `src/lib/exec.ts` — `execFile` wrapper with timeout/abort/error normalization.
- `src/lib/valibot.ts` — the shared `parseInput` helper.
- Migrate the duplicated helpers in the 21 action files, 24 DB files, 7 `parseInput` files, and 8
  `execFile` wrappers _only where the local copy is behaviorally identical_. If a local variant
  differs, leave it and note it in the PR description rather than papering over the difference.

Verification: unit tests for each lib module; full unit suite; spot-check a few action outputs
against `main` via existing tests.

Status note (2026-07-03): shared utilities are introduced with unit coverage. Low-risk exact
call sites were migrated for JSON conversion, common failed/invalid action results, Valibot parse
wrappers, selected git subprocess calls, and app-state DB opens. Remaining local helpers are
intentional variants for now because they differ in JSON semantics, error/result shape, property
order, or domain-specific failure handling; revisit them during the owning domain split.

### Phase 2: `runtime-home` split ⚙

Highest-leverage backend split: 44 non-test modules import it, and every later phase touches it.

Target:

```text
src/runtime-home/
  index.ts          # re-exports the full current public surface (63 exports) — this IS the shim
  paths.ts          # NEONDECK_HOME / XDG resolution
  schemas/          # app-config, repos, dashboard, schedules, execution, worktrees, autopilot, kilo, learning
  defaults.ts
  bootstrap.ts      # first-run dir/file creation (ensureRuntimeHomeSync)
  files.ts          # config JSON read/write/validate
  app-db/
    schema.ts       # DDL
    migrations.ts
    reconcile.ts
```

Note: `.plans/DB_MIGRATIONS_PLAN.md` supersedes the hand-rolled `schema.ts`/`migrations.ts` split
above with Drizzle schema + generated migrations. If that plan lands first, this phase moves the
Drizzle `db/` module and `reconcile.ts` instead; if this phase lands first, the migrations plan
replaces the two files it created. Coordinate via the status tables.

`src/runtime-home.ts` becomes `export * from './runtime-home/index'`. Note `src/db.ts` (the Flue
persistence adapter) calls `runtimePaths`/`ensureRuntimeHomeSync` at module load — verify server
boot (`npm run dev` smoke) after this split, not just tests.

Verification: `runtime-home.test.ts` (split alongside), unit suite, integration suite,
`fresh-runtime-smoke.test.ts`.

Status note (2026-07-03): implemented as `schemas.ts` instead of `schemas/` because the complete
schema surface is 475 lines after extraction and splitting it further would add cross-schema import
churn without reducing an oversized module. Revisit if schema-only growth pushes this file over the
700-line review guide.

### Phase 3: Server route split

`src/app.ts` (2,190 lines, 141 inline routes) becomes an assembly file.

Target:

```text
src/server/
  app.ts            # create Hono app, install middleware, mount sub-routers, static/dev serving
  middleware.ts     # requireLocalApiAccess, requireFlueRunInspectionToken
  routes/
    runtime.ts sessions.ts config.ts execution.ts safety.ts kilo.ts autopilot.ts
    learning.ts memory.ts watches.ts scheduler.ts worktrees.ts repos.ts github.ts
    repo-edit.ts skills.ts metrics.ts notifications.ts
  events/
    config-stream.ts notification-stream.ts session-stream.ts
```

Mechanics: each `routes/*.ts` exports a `Hono` sub-router mounted with `app.route('/api/...', r)`.
Route paths, middleware order, and response bodies must not change — `app-routes.test.ts` is the
guard. Keep `src/app.ts` as the Flue/build entry that re-exports from `src/server/app.ts` if the
Flue build config references it (check `flue.config.ts` before moving the entry point).

Verification: `app-routes.test.ts`, unit suite, `npm run dev` boots, dashboard loads.

Status note (2026-07-03): implemented as a `src/app.ts` Flue/build entry shim over
`src/server/app.ts`. API middleware, Flue run inspection auth, SSE streams, route groups, Flue
learning hooks, and static serving are split under `src/server/**` without moving domain logic.
Verified with `src/app-routes.test.ts`, `npm run check`, `npm run build:server`, and an API mount
smoke for representative route roots. A fresh temporary `NEONDECK_HOME` `npm run dev` boot brought
up Vite and Flue; `http://127.0.0.1:5173/` returned dashboard HTML and `/api/health` returned 200.

### Phase 4: `modules/github`

Split `src/github.ts` + `src/github-actions.ts`:

```text
src/modules/github/
  index.ts client.ts schemas.ts queue.ts pull-requests.ts checks.ts reviews.ts
  comments.ts errors.ts actions.ts
```

- `client.ts`: authenticated REST/GraphQL requests, pagination, timeouts, error mapping (on
  `lib/exec` is irrelevant here — this is fetch-based; centralize fetch mechanics instead).
- Consumers (autopilot, watches, commands, routes) keep importing via the `src/github.ts` shim
  until Phase 12.

Verification: `github.test.ts` fixture-based parsing tests move with the code; unit suite.

Status note (2026-07-03): implemented in `src/modules/github/` with top-level `src/github.ts` and
`src/github-actions.ts` preserved as compatibility re-export shims. Existing GitHub tests remain at
the top level and exercise the shimmed public surface; no consumers were migrated off the shims in
this phase.

### Phase 5: `modules/worktrees` ⚙

Split `src/worktrees.ts`:

```text
src/modules/worktrees/
  index.ts actions.ts schemas.ts service.ts store.ts locks.ts cleanup.ts git.ts paths.ts verify.ts
```

- `verify.ts` is new: receive `verifyPrWorktree`'s worktree-level verification mechanics here (from
  autopilot) so kilo-results can stop importing autopilot (see dependency-direction note).
  Autopilot keeps its own orchestration wrapper. If the entanglement is deeper than it looks,
  defer the move to Phase 9 and record it in the PR — do not force it.
- `git.ts` uses `lib/exec`.

Verification: `worktrees.test.ts`, unit + integration suites; review lock uniqueness and cleanup
semantics diffs carefully — this domain guards autonomy safety.

Status note (2026-07-03): implemented in `src/modules/worktrees/` with top-level
`src/worktrees.ts` preserved as a compatibility re-export shim. The split keeps lock and cleanup
semantics intact and moves git command execution through `lib/exec`. `verify.ts` is present as a
documented placeholder; moving `verifyPrWorktree` mechanics is deferred to Phase 9 because the
current verifier is still coupled to autopilot workflow orchestration and prepared-diff state.

### Phase 6: `modules/sessions` + `modules/config` + `modules/repos`

Sessions (`session-actions.ts`, `session-events.ts`):

```text
src/modules/sessions/
  index.ts actions.ts schemas.ts service.ts store.ts active-session.ts summaries.ts references.ts events.ts
```

Config (`config-actions.ts`, `config-events.ts`):

```text
src/modules/config/
  index.ts actions.ts schemas.ts files.ts history.ts mutations/   # repos, schedules, models, providers, dashboard, execution, worktrees
  discovery.ts events.ts
```

Repos (`repos.ts`, `providers.ts`, `model-discovery.ts`):

```text
src/modules/repos/
  index.ts registry.ts providers.ts model-discovery.ts
```

These three can be three commits in one PR or three PRs — implementer's choice by diff size.

Verification: `session-actions.test.ts`, `config-actions.test.ts`, `providers.test.ts`,
`repos.test.ts`; unit suite.

Status note (2026-07-03): implemented in `src/modules/repos/`, `src/modules/config/`, and
`src/modules/sessions/` with top-level compatibility shims preserving the old public export
surfaces. Repos, config, and sessions were reviewed as separate slices and landed as separate
commits in this PR.

### Phase 7: `modules/safety` + `modules/execution`

Safety (`safety.ts`): the ~1,800-line policy table is legitimate declarative data — keep it as data,
separate from logic:

```text
src/modules/safety/
  index.ts
  policy-entries.ts   # the giant entries table + tool/action/workflow/route/entry builder helpers (size-exempt)
  schemas.ts          # SafetyClass/SafetyPolicyEntry types + safetyPolicySchema
  service.ts          # readSafetyPolicy, summarizeEntries
  tools.ts            # safetyPolicyLookupTool
```

Execution (`execution-actions.ts`, `execution-policy.ts`, `exedev-checkouts.ts`,
`exedev-context.ts`; `src/sandboxes/exedev.ts` stays where it is as the backend adapter):

```text
src/modules/execution/
  index.ts actions.ts schemas.ts policy.ts approvals.ts run.ts
  exedev/ (checkouts.ts context.ts)
```

Policy semantics must be diff-identical — this domain is the trust boundary. Prefer pure
file moves over any restructuring of logic.

Verification: `safety.test.ts`, `execution-policy.test.ts`, `execution-actions.test.ts`,
`exedev-*.test.ts`; unit suite.

Status note (2026-07-03): implemented in `src/modules/safety/` and
`src/modules/execution/` with top-level compatibility shims preserving old imports. The large
safety policy table remains declarative in `policy-entries.ts`; execution policy, approvals, run
logic, and exe.dev context/checkout helpers were moved without consumer migration.

### Phase 8: `modules/kilo` ⚙

Consolidate `kilo-actions.ts`, `kilo-task-store.ts`, `kilo-results.ts`, `kilo-notifications.ts`:

```text
src/modules/kilo/
  index.ts actions.ts tools.ts schemas.ts service.ts store.ts        # store.ts absorbs kilo-task-store.ts
  process-supervisor.ts                                              # spawned processes, streams, running-task maps
  sessions/ (index.ts cli-adapter.ts sdk-adapter.ts disk-adapter.ts transcripts.ts)
  results/ (promote.ts verify.ts review.ts)                          # from kilo-results.ts
  handoff.ts notifications.ts diff.ts
```

- `results/verify.ts` calls `modules/worktrees` verification (Phase 5), not autopilot.
- Existing thin workflows (`handoff_to_kilo.ts`, `promote_kilo_result.ts`, `reconcile_kilo_task.ts`,
  `review_kilo_result.ts`, `verify_kilo_result.ts`, `summarize_kilo_session.ts`) only get import
  updates.

Verification: `kilo-actions.test.ts`, `kilo-results.test.ts`, `kilo-workflow-smoke.test.ts`
(integration), unit + integration suites; manually review process-cleanup and running-task
reconciliation diffs.

### Phase 9: `modules/autopilot` ⚙

The big one. Consolidate `autopilot-workflows.ts` (4,184), `autopilot.ts`, `autopilot-policy.ts`,
`autopilot-recovery.ts`, `autopilot-notifications.ts`, `pr-event-state.ts`, `prepared-diffs.ts`:

```text
src/modules/autopilot/
  index.ts
  actions.ts          # the 8 defineAction declarations + neondeckAutopilotActions
  schemas.ts
  triage.ts           # triagePrEvent + classification
  worktree-prep.ts    # preparePrWorktree + verifyPrWorktree orchestration
  ci-fix.ts           # fixPrCiFailure
  review-feedback.ts  # fixPrReviewFeedback
  push.ts             # pushPrAutofix: gates, block reasons, branch/remote selection
  comments.ts         # commentPrAutofixResult
  github-facts.ts     # GitHub payload → workflow facts
  policy.ts           # from autopilot-policy.ts
  recovery.ts         # from autopilot-recovery.ts
  state.ts            # from autopilot.ts (state machine / status)
  pr-events.ts        # from pr-event-state.ts (dedupe/state store)
  prepared-diffs/     # from prepared-diffs.ts (store.ts apply.ts format.ts)
  notifications.ts
  fixtures.ts         # smoke-test fixtures, isolated from production paths
```

Sequencing inside the PR: move the seven use-case functions one commit each (they are 200–500 lines
apiece), then actions, then the satellite files. `src/autopilot-workflows.ts` shim keeps the 11
importers (workflows/, agents/, app, kilo-results, recovery) working until Phase 12.

Prepared diffs note: if `prepared-diffs.ts` turns out to have non-autopilot consumers (check
imports at implementation time — currently 9), promote it to a mid-layer `modules/prepared-diffs/`
instead of nesting it under autopilot.

Verification: `autopilot-workflows.test.ts` (2,028 lines — split it to mirror the source split),
`autopilot.test.ts`, `autopilot-recovery.test.ts`, `pr-event-state.test.ts`,
`prepared-diffs.test.ts`, `autopilot-workflow-smoke.test.ts` (integration),
`npm run smoke:autopilot` if a configured environment is available.

### Phase 10: `modules/learning` + `modules/memory` ⚙

Learning (`learning-reviews.ts`, `learning-operator.ts`, `skill-patches.ts`,
`workflow-observability.ts`, `autonomous-audit.ts`):

```text
src/modules/learning/
  index.ts schemas.ts
  reviews/ (prepare.ts complete.ts store.ts events.ts)   # from learning-reviews.ts
  agents.ts                                              # learningReviewerProfile + coordinator
  operator.ts                                            # from learning-operator.ts
  skill-patches/ (proposals.ts apply.ts restore.ts audit.ts)
  observability.ts                                       # from workflow-observability.ts
  audit.ts                                               # from autonomous-audit.ts
```

Memory (`memory-actions.ts`):

```text
src/modules/memory/
  index.ts actions.ts schemas.ts service.ts store.ts candidates.ts events.ts
```

Mind the AGENTS.md constraints: learning state is an auditable subsystem with idempotent source
ids, and memory scopes have active/legacy semantics — preserve exactly.

Verification: `learning-reviews.test.ts`, `memory-actions.test.ts`, `cli-learning.test.ts`,
`workflow-observability.test.ts`, `npm run smoke:learning` (integration).

### Phase 11: `modules/watches` + `modules/scheduler` + `modules/commands` + `cli/`

Watches (`watch-actions.ts`): `index.ts actions.ts schemas.ts service.ts store.ts polling.ts`.

Scheduler (`scheduler.ts`): `index.ts store.ts tick.ts dispatch.ts` — keep the tick-concurrency
semantics from `.plans/SCHEDULER_TICK_CONCURRENCY_PLAN.md` intact.

Commands (`commands.ts`):

```text
src/modules/commands/
  index.ts actions.ts registry.ts parser.ts summaries.ts
  handlers/ (briefing.ts review-queue.ts watch.ts schedule.ts model.ts memory.ts doctor.ts session.ts ...)
```

CLI (`cli.ts`, 1,825 lines, zero exports — pure adapter):

```text
src/cli/
  index.ts          # program assembly; package.json "bin" points here (update bin + "cli"/"init" scripts)
  commands/         # one file per subcommand group (init, learning, doctor, ...)
  onboarding.ts output.ts
```

CLI handlers must call domain services — anything in `cli.ts` today that duplicates a service
belongs in the domain, but _move_ it in this phase only if it is a literal duplicate; otherwise
leave a `TODO(refactor)` and keep behavior identical.

Verification: `commands.test.ts`, `watch-actions.test.ts`, `scheduler.test.ts`,
`cli-learning.test.ts`; run `npm run cli -- --help` and `npm run cli -- doctor` manually.

### Phase 12: Shim removal + layering enforcement

- Migrate all remaining imports off the top-level shims (`runtime-home.ts`, `github.ts`,
  `worktrees.ts`, `kilo-actions.ts`, `autopilot-workflows.ts`, etc.), then delete the shims,
  one commit per shim.
- Add an import-direction guard. Cheapest viable option first: a small script
  (`scripts/check-import-layers.mjs`) that reads the layer list from this doc and greps for
  violations, wired into `npm run check`. Swap for a proper lint rule if oxlint grows support.
- Re-run `npm run report:file-sizes` and update the inventory table above with results.

Verification: `npm run verify` (full suite + format + build).

### Phase 13: Frontend API split

Split `web/src/api.ts` (1,710 lines, 130 exports):

```text
web/src/api/
  http.ts events.ts types.ts
  runtime.ts config.ts sessions.ts github.ts worktrees.ts kilo.ts autopilot.ts
  learning.ts memory.ts watches.ts workflows.ts execution.ts safety.ts repos.ts notifications.ts
```

- `web/src/api.ts` becomes a re-export shim; plugins migrate imports opportunistically, then the
  shim is removed in this phase's final commit (frontend import churn is cheap enough to finish in
  one PR).
- `types.ts` stays hand-maintained for now. Add response validation (Valibot `parse` at the fetch
  boundary) only for the highest-risk payloads first: runtime status, dashboard config, sessions,
  kilo/autopilot mutations. Generating types from backend schemas is a follow-up project, not part
  of this plan — but keep types in one importable module to make that swap easy.

Verification: `web/src/api.test.ts` moves/splits with the code; `npm run typecheck`;
`npm run build:web`; dashboard smoke in dev.

### Phase 14: Frontend feature folders

Runtime Overview (`web/src/plugins/RuntimeOverview.tsx`, 30 components):

```text
web/src/features/runtime-overview/
  plugin.tsx          # registry entry
  queries.ts          # React Query keys/fns/mutations/invalidations + event-stream subscriptions
  components/         # RuntimeView, RuntimeHome, RuntimeConfigControls, FirstRunSetup, Readiness,
                      # Notifications, SafetyPolicy, ExecutionApprovals, RepoEdits, KiloTasks,
                      # Worktrees, Workflows, Repos, Jobs, Skills, Memories
  forms/              # config forms keep local dirty state; never reset while focused
  lib/                # pure formatting/classification helpers
```

Flue Chat (`web/src/plugins/FlueChat.tsx`):

```text
web/src/features/flue-chat/
  plugin.tsx queries.ts
  components/ (ChatShell, SessionSelect, SessionOptionGroup, MessageList, ChatPartEvent,
               CommandTypeahead, CommandResultSummary)
  lib/ (message-parts.ts command-filter.ts session-labels.ts)
```

- Promote genuinely shared atoms (`StatusPill`, `Metric`, `MiniEmpty`, generic rows) to
  `web/src/components/` — only if used by 2+ features.
- `web/src/plugins/RuntimeOverview.tsx` and `FlueChat.tsx` stay as one-line re-exports so
  `plugins/registry.tsx` and `config/dashboard.json` plugin ids are untouched.
- Remaining panels (AutopilotPanel, LearningOperatorPanel, etc.) adopt the pattern only when next
  modified — not in this phase.

Verification: `npm run typecheck`, `npm run build:web`, component tests where they exist, manual
dashboard pass (Playwright is available for a scripted smoke if the implementer prefers).

---

## Working Rules For Implementation Agents

1. **Mechanical moves and behavior changes never share a commit.** A move commit should be
   reviewable by "same bytes, new home". Cleanups (renames, dedup, dead code) come after, in the
   same PR at most.
2. **Shims keep the world running.** Never break an import site outside your phase's scope.
3. **Tests travel with code.** Splitting a source file splits its test file the same way.
4. **When reality disagrees with this plan, update the plan.** If a proposed boundary is wrong once
   you're inside the code, choose the better boundary, note it in the PR description, and edit
   this document (structure + status table) in the same PR. This doc must stay current — that is
   how the previous proposal died.
5. **Verify per phase**: `npm run check` always; `npm run test:integration` for phases marked ⚙;
   `npm run verify` for Phase 12. Use Node 26 (`fnm use 26.4.0`).
6. **No new dependencies** for this refactor without explicit approval.
7. Keep `.plans/DEVIATIONS.md` for roadmap deviations only; refactor-plan deviations live here.

## Regenerating The Inventory

```sh
# largest files (excluding tests)
find src web/src -name '*.ts' -o -name '*.tsx' | grep -v '\.test\.' | xargs wc -l | sort -rn | head -40

# fan-in for a module
grep -rln "from './runtime-home'" src --include='*.ts' | grep -v test | wc -l

# duplicated-helper counts
grep -rln "function failResult\|function invalidInputResult\|asJsonValue" src --include='*.ts' | grep -v test | wc -l
grep -rln "DatabaseSync" src --include='*.ts' | grep -v test | wc -l
```

## Risks

- **Behavior drift during extraction.** Mitigation: move-only commits, byte-stable result shapes,
  existing tests move first and must pass unchanged before any cleanup commit.
- **Merge conflicts with active feature work.** Mitigation: one domain per PR, shims, land the
  high-fan-in phases (1–3) quickly, coordinate on the status table above.
- **Flue build/entry coupling.** The Flue toolchain discovers `src/app.ts`, `src/db.ts`,
  `src/agents/`, and `src/workflows/` by convention (`flue.config.ts` names no files). Before
  moving or shimming any of those, verify `npm run build:server` and `flue dev` still work.
- **Trust-boundary regressions** in safety/execution/worktree-locks/push-gates. Mitigation: those
  phases are move-only; any logic change is rejected in review.
- **Over-abstraction.** Mitigation: non-goals above; `lib/` stays under ~6 small files; no
  wrappers around Flue, Hono, or React Query.
- **The plan going stale again.** Mitigation: working rule 4 — the doc is updated in the same PR
  as the code, or the phase doesn't merge.

## Definition of Done

- Every file in the Phase-0 size report is either split, a shim scheduled for removal, or
  documented as size-exempt (declarative data/schemas).
- `src/` top level contains only entry points (`app.ts` re-export if Flue needs it, `db.ts`,
  `setup.ts`), directories, and no multi-thousand-line modules.
- Flue actions, routes, workflows, CLI, and commands are all adapters over `src/modules/*`
  services, and the import-direction check passes.
- `web/src/api.ts` is gone; API modules are domain-scoped with guarded parsing on high-risk
  responses.
- Runtime Overview and Flue Chat are feature folders; the plugin registry is unchanged.
- `npm run verify` passes; the file-size report shows no non-exempt file over 700 lines.
