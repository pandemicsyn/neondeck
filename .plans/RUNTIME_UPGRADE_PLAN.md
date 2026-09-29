# Runtime Upgrade And Doctor Plan

Status: proposed

Related:

- `.plans/archived/DB_MIGRATIONS_PLAN.md` — completed app-database migration foundation
- `.plans/archived/DESKTOP_EXPERIENCE_PLAN.md` — installed service lifecycle and embedded-path drift
- `.plans/ROADMAP.md` — runtime-home, readiness, deterministic-action, and future-TUI direction

## Purpose

Neondeck already upgrades parts of a runtime home, but the behavior is implicit and spread across
runtime-home initialization:

- `ensureRuntimeHome*` creates missing files and directories, repairs local API configuration,
  migrates `dashboard.json`, seeds skills, and opens/migrates databases.
- app-database migrations auto-apply with journal validation, transaction boundaries, downgrade
  protection, backups, and `neondeck db status` inspection.
- `dashboard.json` has a schema version and one semantic migration, but its upgrade is silent and
  does not create a recoverable file backup.
- `neondeck doctor` is a development-oriented diagnostic, but it first calls
  `ensureRuntimeHome`, so diagnosis can mutate files and apply migrations.
- `neondeck status` also ensures the runtime home before reading readiness, so it is not a purely
  observational command.

This is workable during rapid pre-1.0 development, but it is not a clear installed-product
contract. A user upgrading the npm package or desktop service should be able to answer:

1. Is this executable compatible with my runtime home?
2. What will change when the new version starts?
3. Were database and configuration migrations applied successfully?
4. Which files were backed up, and how do I recover?
5. Why did the service refuse to start?

Target: one deterministic, app-owned runtime upgrade engine shared by startup and CLI, with
read-only inspection, explicit plans, safe automatic startup migrations, semantic config
migrations that preserve customization, and durable upgrade receipts.

## Product Contract

| Surface                    | Contract                                                                                   | Mutates runtime home |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| `neondeck doctor`          | Inspect installed-runtime health, compatibility, service state, config, and migrations.    | No                   |
| `neondeck doctor --dev`    | Include source-checkout checks such as repo dirtiness, package scripts, and dev ports.     | No                   |
| `neondeck upgrade --check` | Print the exact ordered upgrade plan and whether startup may apply it automatically.       | No                   |
| `neondeck upgrade`         | Lock, back up, apply, validate, and record runtime-home upgrades for this executable.      | Yes                  |
| `neondeck serve` / service | Apply only migrations classified as safe for unattended startup; otherwise refuse clearly. | Sometimes            |

`neondeck upgrade` upgrades the selected runtime home for the currently installed Neondeck
executable. It does **not** install a newer npm package, rewrite a package-manager installation,
or self-update the desktop bundle. The command must state the executable version and runtime-home
path so this distinction is visible.

All commands continue to honor global `--home` and `--json` options. Machine-readable output is a
stable requirement because the future TUI, desktop service tooling, support scripts, and dashboard
should consume the same facts.

## Decisions

### 1. One app-owned engine, not a Flue workflow

Runtime compatibility must be established before Flue persistence, agents, workflows, MCP, the
scheduler, or dashboard routes start. The upgrade engine therefore lives under `src/runtime-home/`
and has no dependency on Flue.

The dashboard may later expose a read-only upgrade plan and an explicitly confirmed apply route,
but both must call the same app service as the CLI. Do not create a model-callable upgrade action:
changing the runtime schema is an operator/package lifecycle concern, not agent self-configuration.

### 2. Inspection is always read-only

`doctor`, `status`, `db status`, and `upgrade --check` must not:

- create a missing runtime home;
- add a local API token;
- seed or replace skills;
- write or normalize JSON;
- create/open SQLite in read-write mode;
- apply migrations;
- start the service, scheduler, MCP registry, or Flue runtime.

Missing files are reported as missing. An uninitialized home is reported as needing `neondeck
init`, not silently created while diagnosing it.

### 3. Startup auto-applies only safe migrations

The installed-service experience should remain unattended for ordinary releases. Startup may
automatically apply a step only when it is:

- deterministic and non-interactive;
- forward-only and idempotent;
- covered by a pre-change backup when user data already exists;
- validated before the rest of the runtime opens;
- compatible with preserved user customization;
- safe to retry after interruption;
- explicitly classified `startup-safe` by the migration author.

If any pending step is `explicit` or `blocked`, startup makes no upgrade writes and exits with an
actionable message:

```text
Neondeck cannot start because this runtime home needs an explicit upgrade.
Home: ~/.config/neondeck
Plan: neondeck upgrade --check
Apply: neondeck upgrade
```

The first implementation should support an environment/CLI override such as
`NEONDECK_UPGRADE_MODE=check` or `neondeck serve --no-auto-upgrade` for operators who require
check-only startup. Do not store the only override in `config.json`; an old or malformed config
may be the reason startup cannot proceed.

### 4. User configuration is migrated semantically, never replaced from defaults

The checked-in `config/dashboard.json` is a first-run seed, not an authoritative desired state for
existing homes. Adding a plugin or tab to the latest default does not automatically mean every
existing customized dashboard should receive it.

Each user-owned JSON migration is an ordered `vN -> vN+1` transform that:

- preserves unknown keys supported by the loose schemas;
- preserves layout, ordering, defaults, and explicit user removals unless the schema requires a
  change;
- adds or rewrites only the fields named by that migration;
- validates its output against the target schema before replacing the source file;
- writes atomically and creates a retained backup before the first change in an upgrade run;
- is covered by fixtures for minimal, default, and heavily customized inputs;
- has a concise user-facing description for `upgrade --check` and receipts.

Migrations must be chained one version at a time. A home whose version is greater than the
executable's supported version is a downgrade/incompatibility error, even if the current parser
would otherwise accept it.

### 5. Forward-only with restore-from-backup recovery

There are no down migrations. Recovery means restoring the pre-upgrade backup with the service
stopped and a compatible Neondeck version installed. Reuse the existing SQLite backup behavior
and retention policy; add equivalent timestamped backups for changed JSON files.

The upgrader should not promise cross-file/database transactional atomicity that the filesystem
cannot provide. Instead it provides:

- an exclusive runtime-home upgrade lock;
- a complete preflight before any migration write;
- backups for every changing persistent resource before applying the first step;
- individually atomic/idempotent steps;
- a checkpointed receipt that records completed and failed steps;
- safe retry that replans from actual on-disk versions.

## Runtime Resource Model

The planner reports every persistent resource, including those with no pending work.

| Resource                | Version authority                        | Upgrade owner | Initial policy                                      |
| ----------------------- | ---------------------------------------- | ------------- | --------------------------------------------------- |
| `config.json`           | existing `version` field                 | Neondeck      | Add ordered migrations when version 2 is needed.    |
| `dashboard.json`        | existing `schemaVersion` field           | Neondeck      | Move current migration into the shared registry.    |
| `repos.json`            | add `schemaVersion` before shape changes | Neondeck      | Treat current unversioned shape as version 1.       |
| `mcp.json`              | add `schemaVersion` before shape changes | Neondeck      | Treat current unversioned shape as version 1.       |
| `dashboard.schema.json` | shipped generated/reference artifact     | Neondeck      | Refresh shipped copy; it is not user configuration. |
| built-in skills         | packaged-vs-installed content metadata   | Neondeck      | Inspect drift first; do not overwrite user edits.   |
| `SOUL.md`               | user-owned text, no schema               | User          | Never auto-replace after first-run seeding.         |
| `.env`                  | user-owned secrets, no schema            | User          | Inspect named requirements only; never rewrite.     |
| `data/neondeck.db`      | Drizzle migration journal                | Neondeck      | Reuse completed automatic migration guarantees.     |
| `data/flue.db`          | Flue's persistence contract              | Flue          | Inspect availability only; never migrate directly.  |

Do not introduce one global schema integer that replaces resource-specific versions. The runtime
home contains independently evolving domains, and their actual file/database version remains the
source of truth. A small upgrade receipt may record the Neondeck package version that last touched
each domain, but that metadata is observational rather than authoritative.

## Upgrade Step Model

Define a typed registry with a shape equivalent to:

```ts
type UpgradeSafety = 'startup-safe' | 'explicit' | 'blocked';
type UpgradeResource =
  | 'app-config'
  | 'dashboard-config'
  | 'repo-config'
  | 'mcp-config'
  | 'app-database'
  | 'runtime-assets';

type RuntimeUpgradeStep = {
  id: string;
  resource: UpgradeResource;
  fromVersion: string;
  toVersion: string;
  safety: UpgradeSafety;
  description: string;
  inspect(context: UpgradeContext): UpgradeStepInspection;
  apply(context: UpgradeApplyContext): UpgradeStepResult;
};
```

The concrete types may differ, but the engine must keep these properties:

- stable, unique step IDs included in JSON output and receipts;
- deterministic ordering by resource dependencies and source version;
- separate inspection and application paths;
- no write-capable callback invoked while planning;
- an explicit safety classification rather than inference from resource type;
- structured warnings, blockers, backup requirements, and validation results;
- redacted results that never copy `.env`, provider credentials, local API tokens, or MCP secrets
  into logs/receipts.

### Planner states

Each resource/step resolves to one of:

- `current` — supported and no migration is pending;
- `pending` — a known ordered migration is available;
- `missing` — first-run resource absent;
- `invalid` — parse or schema validation failed;
- `too-new` — resource contains a version unknown to this executable;
- `drifted` — a shipped/applied migration hash or managed asset differs unexpectedly;
- `blocked` — the engine cannot safely select or apply a path.

`too-new`, `invalid`, `drifted`, and `blocked` prevent automatic startup. `missing` means `init` for
an existing inspection command; first-run initialization remains a separate explicit lifecycle.

## Upgrade Execution

`applyRuntimeUpgrade` follows one ordered flow:

1. Resolve and print/return the executable version and selected runtime home.
2. Acquire an exclusive home-level lock with PID, start time, and executable version metadata.
3. Detect a live service or other active writer. Either stop with instructions or, for an
   explicitly designed online-safe future step, prove online safety. Initial implementation is
   offline-only for explicit CLI upgrades.
4. Re-run the full read-only plan while holding the lock; do not apply a stale pre-lock plan.
5. Stop if any step is invalid, too-new, drifted, blocked, or requires confirmation not provided.
6. Verify the home and backup directories are writable and have enough free space for the known
   files. Treat space calculation as a warning when the platform cannot report it reliably.
7. Create all required pre-upgrade backups before the first migration write.
8. Apply steps in registry order, validating each target before advancing.
9. Re-run the planner. Success requires every managed resource to be `current`.
10. Atomically finish a redacted receipt and release the lock.

On interruption or failure, keep backups and the partial receipt. The next invocation reports the
previous incomplete run and safely replans from disk; it must not assume that no steps completed.

### Upgrade receipts

Store redacted JSON receipts under a runtime-owned path such as
`data/upgrades/<utc>-<package-version>.json`. A receipt contains:

- receipt schema version;
- run ID, start/end timestamps, and outcome;
- executable/package version and runtime-home path;
- trigger (`cli`, `startup`, or future confirmed UI);
- planned and completed step IDs;
- before/after resource versions and validation status;
- backup paths;
- warnings and redacted failure metadata.

Receipts must not depend on `neondeck.db`, because that database may be the resource that failed to
upgrade. Retain a bounded number independently from database backups.

## CLI And Output

### `neondeck upgrade --check`

Human output should be compact but complete:

```text
Neondeck 1.1.0
Home  /Users/me/.config/neondeck

CURRENT  config.json       v1
PENDING  dashboard.json    v1 -> v2  startup-safe
PENDING  neondeck.db       4 migrations applied -> 1 pending  startup-safe
CURRENT  mcp.json          v1

2 steps pending; both may be applied automatically at startup.
Run `neondeck upgrade` to apply now.
```

Exit codes should distinguish:

- `0`: current, or a valid plan with only known pending work;
- `1`: invalid/blocked/failed inspection;
- `2`: runtime home is too new for this executable;
- `3`: explicit migration required before startup.

Exact values may be adjusted to match existing CLI conventions, but they must be documented and
stable. `--json` returns the full structured plan without embedding human-formatted prose as the
only representation.

### `neondeck upgrade`

Options for the initial release:

- `--check`: alias for read-only planning;
- `--yes`: accept explicit but non-destructive migration confirmation for non-interactive use;
- `--json`: structured progress/result;
- existing global `--home`.

Do not add `--force`. Unknown versions, changed migration hashes, invalid files, or an active
service are safety boundaries, not warnings to bypass. Add narrowly scoped recovery commands only
when a real supported recovery path exists.

### `neondeck doctor`

Refocus the default doctor on the installed product:

- executable version, Node compatibility, runtime-home resolution, and filesystem permissions;
- service installation, embedded executable/server paths, process health, and configured port;
- config presence, parse/validation status, schema versions, and downgrade detection;
- app database journal status and last backup;
- Flue database open/health status without attempting migration;
- provider credential presence by configured environment-variable name, never values;
- repo/schedule/watch/skill counts and recent runtime failures using read-only access;
- pending upgrade summary and exact next command.

Move source-oriented package-script, configured-repo dirtiness, Vite port, and local development
checks behind `doctor --dev` (or a `dev doctor` subcommand if Commander structure makes that
cleaner). The existing `/dev-doctor` Flue workflow keeps its development meaning; it does not
become the runtime-home upgrader.

`doctor` should return `ok: false` and a nonzero exit code when a required runtime condition is
broken. The current action-result shape reports transport success separately from diagnostic
attention; the CLI contract must make scripting failure unambiguous while preserving structured
check details.

## Startup Integration

Split the current broad `ensureRuntimeHome*` responsibilities into explicit lifecycle services.
Names are illustrative:

```text
initializeRuntimeHome()   explicit first-run seeding (`neondeck init`)
inspectRuntimeHome()      read-only presence, validation, and versions
planRuntimeUpgrade()      read-only ordered compatibility plan
applyRuntimeUpgrade()     locked backup/apply/validate/receipt engine
openRuntimeHome()         assert current, then open runtime resources
```

Ordinary domain services should not repeatedly call a function that can migrate the entire home.
Server/CLI entrypoints prepare the lifecycle once, then domain services assume a validated runtime
context or call narrowly scoped initialization only where unavoidable.

Server boot order becomes:

1. resolve runtime paths and load only environment needed for upgrade policy;
2. inspect/plan runtime home;
3. apply all `startup-safe` pending steps under the upgrade lock, or fail before opening runtime
   services;
4. validate the current home and load provider configuration;
5. open Neondeck and Flue persistence;
6. register providers, observation handlers, scheduler, MCP, routes, and static assets;
7. emit a sanitized startup log/notification when an automatic upgrade occurred.

Avoid today's sync-then-async duplicate preparation in server creation. Preserve a synchronous
database-ready adapter only where the installed Flue entrypoint truly requires it; it should call
the same migration registry/guards rather than a parallel implementation.

## Dashboard Migration Registry

Move the current Reviews-tab migration into a general ordered JSON migration helper and retain its
behavioral guarantee: it adds Reviews once to a compatible old layout, keeps the user's default
tab, and does not re-add Reviews after the migrated user later removes it.

For each new dashboard version:

1. Add the target version to both the runtime parser and shipped JSON Schema.
2. Add one transform from the immediately previous version.
3. Describe whether it changes required schema, optional defaults, or user-visible layout.
4. Classify safety. A required field with a deterministic default can be `startup-safe`; choosing
   where to place a new panel in a custom layout may be `explicit` or no migration at all.
5. Test default, minimal, customized, already-feature-present, malformed, and too-new fixtures.
6. Prove a second run is a no-op and byte-stable after the first formatted write.

The planner must distinguish **schema compatibility** from **default-layout drift**. An existing
valid v2 dashboard can be current even when it does not resemble the latest checked-in default.

## Safety And Concurrency

- Use one home-level lock around the whole upgrade, in addition to the existing SQLite
  `BEGIN IMMEDIATE` guard. The database lock alone does not serialize JSON migrations.
- Detect and report stale locks using PID/process-start metadata where supported. Never delete a
  seemingly live lock automatically.
- Use atomic write-and-rename for JSON and receipt writes.
- Back up source bytes, not reserialized JSON, so comments are irrelevant today and exact recovery
  remains possible.
- Preserve file permissions where practical; `.env` is never included in routine upgrade backups
  because it is never migrated.
- Redact local API tokens, credentials, auth headers, and secret environment values from plans,
  receipts, notifications, and errors.
- Validate every known resource version before any write so a too-new dashboard cannot be
  overlooked merely because only the database has a pending migration.
- Keep applied migration definitions immutable. Changed dashboard/config migration IDs or hashes
  should fail the same way changed Drizzle migration hashes fail.

## Implementation Phases

### Phase 1 — Read-only inventory and planner

- Add typed runtime resource/upgrade-plan schemas and stable JSON output.
- Inspect all managed files without creating or normalizing them.
- Adapt existing `readAppDbMigrationStatus` into the app-database resource inspection.
- Detect missing, invalid, pending, too-new, changed/drifted, and current states.
- Read the CLI version from package/build metadata instead of the current hardcoded `1.0.0`.
- Add `neondeck upgrade --check` and tests proving it performs no writes.

### Phase 2 — Shared JSON migrations, backups, lock, and receipts

- Extract the dashboard migration into an ordered migration registry.
- Add exact-byte JSON backups and bounded retention under the runtime data directory.
- Add the cross-process runtime-home upgrade lock.
- Implement receipts and interrupted-run reporting.
- Implement `neondeck upgrade`, initially applying dashboard plus app-database steps.
- Keep app-database migration SQL/application in the existing Drizzle migrator; the shared engine
  coordinates it rather than duplicating it.

### Phase 3 — Startup lifecycle cutover

- Separate first-run initialization, planning, migration, validation, and runtime opening.
- Remove hidden migration work from observational CLI paths.
- Run the shared upgrader once, before Flue/scheduler/MCP/provider startup.
- Add check-only startup mode and clear explicit-upgrade/too-new failure messages.
- Add startup logs and sanitized runtime-status fields for last upgrade/backup.

### Phase 4 — Doctor split and operator surfaces

- Make default `doctor` an installed-runtime diagnostic with meaningful exit status.
- Preserve the existing source/development checks under `--dev` or `dev doctor`.
- Keep `/dev-doctor` development-focused and non-mutating.
- Add pending/blocked upgrade checks to runtime readiness and the Runtime Overview panel.
- Optionally add a confirmed local dashboard apply route after CLI/startup behavior is proven.

### Phase 5 — Version remaining managed JSON domains when needed

- Add `schemaVersion` to `repos.json` and `mcp.json` before their first incompatible shape change.
- Add ordered `config.json` migrations when app config advances beyond version 1.
- Define managed built-in-skill update metadata separately; never silently overwrite a modified
  installed skill.
- Extend upgrade-plan and receipt compatibility tests to every versioned domain.

Phases 1–4 should land before relying on a new dashboard/config schema version in a release. Phase
5 is partly demand-driven: do not create empty migration churn merely to exercise the mechanism.

## Verification

### Unit tests

- Planner reports current, missing, pending, invalid, too-new, changed, and blocked fixtures.
- `doctor`, `status`, and `upgrade --check` leave file contents, mtimes, directory entries, and
  database journal rows unchanged.
- Every JSON migration preserves unrelated/custom keys and is idempotent.
- Dashboard migration fixtures preserve custom layouts/default tabs and explicit post-migration
  removal.
- JSON backup retention, exact-byte content, atomic replacement, and permission behavior.
- Receipt success/failure/redaction and recovery from an incomplete receipt.
- Lock contention, stale-lock reporting, and no automatic deletion of live locks.
- Stable CLI JSON schemas and exit codes.

### Integration tests

- Fresh home remains an `init` concern; inspection does not create it.
- Existing beta.10-style home plans/applies to the new current state.
- Startup auto-applies an all-safe plan and reaches health only after validation.
- Startup with an explicit step performs no writes and exits with the documented commands.
- Startup with a too-new config or unknown DB journal row performs no writes and refuses clearly.
- A failing database migration rolls back while retaining all pre-upgrade backups and a failed
  receipt.
- A failing JSON migration leaves the source file intact and does not start later runtime systems.
- Concurrent service/CLI upgrade attempts serialize at the home lock.
- Packaged npm smoke test contains migration registries/assets and upgrades a fixture home without
  relying on the source checkout or current working directory.

### Manual checks

- `neondeck doctor`, `neondeck doctor --dev`, `neondeck upgrade --check`, and
  `neondeck upgrade` human output is actionable on current, pending, and blocked homes.
- An installed login service upgraded to a release with safe migrations restarts unattended and
  reports what changed.
- Restoring the documented backup with the service stopped returns the old home to its prior
  contents.

Run at minimum:

```sh
npm run check
npm run test:integration
npm run smoke:npm-pack
npm run build:dashboard
```

Use `npm run verify` before release or when the implementation changes packaged assets, docs, or
the full build surface.

## Documentation And Release Notes

Update:

- README common commands with `doctor`, `upgrade --check`, and `upgrade` semantics;
- getting-started/package-upgrade docs with automatic-startup behavior;
- configuration docs with resource versions and customization-preservation guarantees;
- troubleshooting docs with too-new homes, failed migrations, locks, backups, receipts, and
  restore procedure;
- service docs with check-only mode and failure behavior;
- `AGENTS.md` database/config migration workflow where developer commands change;
- changelog/changeset because this is user-facing CLI and lifecycle behavior.

The release note must call out that `upgrade` migrates runtime state but does not update the
installed package.

## Non-Goals

- Downloading or installing a newer Neondeck package/app bundle.
- Migrating Flue-owned `flue.db` directly.
- Down migrations or automatic package downgrades.
- Replacing customized dashboard layouts with the latest default.
- Rewriting `.env`, `SOUL.md`, or modified user/runtime skills.
- Making runtime upgrades model-callable or letting Neon bypass operator confirmation.
- General backup/restore product UI beyond the backups and receipts required for safe upgrades.
- Online migrations while schedulers, workflows, or MCP tools continue mutating state; initial
  explicit upgrades are offline-only.

## Risks And Open Questions

- **Command naming:** users may assume `neondeck upgrade` installs a new package. Keep the
  product-friendly name, but print “runtime home upgrade” prominently and document the boundary.
  `neondeck migrate` is more precise but narrower than the eventual config/asset work.
- **Service coordination:** explicit CLI upgrades should initially require the service to be
  stopped. A future service-owned handoff/restart command can improve this without weakening the
  lock contract.
- **Sync Flue entrypoint:** current Flue discovery opens runtime state synchronously at module
  load. The lifecycle cutover must verify the installed Flue API before restructuring this path;
  do not invent framework hooks from memory.
- **Built-in skill updates:** `copyIfMissing` protects local edits but also leaves old unmodified
  built-ins stale. Solving that needs packaged content hashes and three-way ownership rules; keep
  it separate from the first upgrade-engine slice.
- **JSON comments:** files are JSON today, so exact-byte backup plus formatted atomic output is
  sufficient. If JSONC is adopted later, migration parsing/writing must preserve comments or use a
  comment-aware editor.
- **Cross-resource recovery:** restoring every backup automatically after a later step fails can
  be more dangerous than leaving a valid forward migration in place. Initial behavior should stop,
  record exact completed steps, and offer documented manual restoration rather than claiming a
  universal rollback.
- **Exit-code compatibility:** Commander and existing action-result output currently use a mostly
  binary success model. Lock stable detailed exit codes only after auditing scripts and package
  consumers.

## Definition Of Done

- `neondeck doctor`, `status`, `db status`, and `upgrade --check` are demonstrably read-only.
- `neondeck upgrade --check` reports current executable/home versions, every managed resource,
  pending ordered steps, safety classification, blockers, and backup requirements.
- `neondeck upgrade` applies a valid plan under one home lock, backs up every changed persistent
  resource, validates the final state, and writes a redacted receipt.
- Service startup uses the same engine, automatically applies only `startup-safe` steps, and starts
  no Flue/scheduler/MCP work before runtime compatibility is established.
- Explicit, invalid, drifted, and too-new states make no migration writes and produce actionable
  recovery/upgrade instructions.
- Dashboard migrations preserve user customization and never merge the latest default layout into
  an already-current home.
- Existing Drizzle transaction, backup, immutable-journal, and downgrade guarantees remain intact.
- The packaged npm smoke test proves migrations and version metadata work outside the repository.
- CLI, runtime overview, docs, safety inventory, tests, and changeset cover the new behavior.
- `npm run verify` passes before release.
