# Database Migrations Plan (Drizzle)

Status: **active** — planning doc for replacing the hand-rolled app-database schema management in
`runtime-home.ts` with Drizzle-generated, versioned, auto-applied migrations. Written 2026-07-03
for implementation agents; sibling to `.plans/REFACTOR_PLAN.md`, whose conventions this follows.
Intended to land **after** REFACTOR_PLAN Phase 2 (runtime-home split), but not blocked on it — see
Sequencing.

## Purpose

Neondeck's app database (`data/neondeck.db`) is currently created and evolved by
`initializeAppDatabase` in `src/runtime-home.ts`: one large idempotent
`CREATE TABLE IF NOT EXISTS` block (~30 tables), `PRAGMA table_info`-guarded column additions,
two hand-written table-rebuild migrations, data reconciliation passes, and an informational
`app_metadata.schema_version` row that nothing gates on. This works, but every schema change is
hand-written twice (DDL + migration guard), nothing is versioned, and there is no protection
against a downgraded binary opening a newer database.

The near-future distribution model raises the stakes: **most users will `npm install` Neondeck and
use the CLI — only devs will check out the repo.** Users will never run a migrate command; schema
upgrades must apply automatically, safely, on first touch after an upgrade, from migration files
shipped inside the npm package.

Target: Drizzle as the schema source of truth and migration engine — `drizzle-kit generate` for
devs, an auto-applying migrator at every database-open path for users.

## Ground Rules (verified 2026-07-03)

- **The whole codebase runs on Node's built-in `node:sqlite`** (`DatabaseSync`, 24 non-test
  files). This is a feature for the npm-install story: zero native dependencies to compile.
- **Drizzle's `node:sqlite` driver exists only in the v1 line.** Verified against the npm
  registry: `drizzle-orm@1.0.0-rc.4` exports `./node-sqlite`; the current stable (`0.45.2`) does
  not. Consequence: this plan pins Drizzle v1 (RC today, likely stable by implementation time).
  Do **not** switch the driver to `better-sqlite3` to get stable Drizzle — that would add native
  compilation to every user install, which is worse than an RC dependency in a codebase already
  running on `@flue/*` betas. Pin exact versions.
- **Drizzle v1 facts, verified against the installed `1.0.0-rc.4` packages** (not docs):
  - `drizzle-orm/node-sqlite` exports `drizzle({ client })` accepting an existing `DatabaseSync`
    instance — it wraps the connection Neondeck already opens.
  - The node-sqlite `migrate(db, { migrationsFolder })` is **synchronous** (`migrateSync`
    internally), but it wraps all pending migrations in a single transaction. Neondeck uses
    Drizzle's parser/schema tooling and owns a tiny sync apply loop so the runtime can hold
    `BEGIN IMMEDIATE`, create backups, and report each failing migration precisely.
  - `drizzle-kit pull --init` is first-class baselining for simple SQLite databases, but RC4 cannot
    introspect Neondeck's expression index on `memories(scope, key, COALESCE(repo_id, ''))`.
    Baseline migration bootstrapping is therefore hand-authored from the current DDL, generated
    from `schema.ts`, and verified by parity tests. Runtime stamping of _user_ databases (who
    never run drizzle-kit) remains our `migrate.ts` responsibility.
  - `drizzle-kit migrate` performs **commutativity conflict checks** by default
    (`--ignore-conflicts` to skip) — parallel-branch migration conflicts are detected natively;
    our CI journal gate builds on this instead of reimplementing it.
  - drizzle-kit v1 is built for agent-driven use: `--output json` emits a machine-decodable
    envelope and is guaranteed non-interactive; `--explain` is a dry run returning planned SQL.
    RC4's sqlite SDK does **not** expose `generate(...)`, so Neondeck's drift gate shells out to
    `drizzle-kit generate --output json --explain`. The package ships eight Agent Skills
    (`drizzle`, `drizzle-generate`, `drizzle-migrations`, `drizzle-pull`, `drizzle-push`,
    `drizzle-output-modes`, `drizzle-hints`, `drizzle-responses-and-errors`) under
    `node_modules/drizzle-kit/skills/`, plus a `drizzle-kit mcp` server.
- **Auto-apply already happens implicitly.** `ensureRuntimeHome`/`ensureRuntimeHomeSync` run
  `initializeAppDatabase` on server boot (`app.ts`, `db.ts` at module load) and CLI startup. The
  new migrator slots into the same choke point — there is exactly one place to wire it.
- **Both sync and async entry paths exist.** `db.ts` (the Flue persistence adapter) calls
  `ensureRuntimeHomeSync` at module load. Confirmed handled: the node-sqlite migrator is sync. If
  a future RC regresses this, the contingency is applying the journal-and-SQL files with our own
  ~40-line sync runner — the journal format is stable and readable via the exported
  `readMigrationFiles`.
- **Scope is `neondeck.db` only.** `flue.db` is Flue runtime state, owned and migrated by Flue.
- **REFACTOR_PLAN alignment.** The refactor's "no ORM" non-goal stands: Drizzle is adopted here
  for schema definition, migration generation, and migration application ONLY. Store files keep
  hand-written SQL against `DatabaseSync`. Adopting Drizzle's query builder in stores is a
  separate, unplanned decision. (REFACTOR_PLAN's Phase 2 `app-db/migrations.ts` is superseded by
  this plan; its non-goals section gains a clarifying note in the same PR.)

## Non-Goals

- No query-builder/ORM adoption in domain stores. SQL stays explicit.
- No migration of `flue.db` or any Flue-owned state.
- No down migrations. SQLite + local single-user data + pre-migration backups make forward-only
  the honest model; "down" is restore-from-backup.
- No schema changes riding along. The first Drizzle schema must reproduce today's schema v9
  byte-for-byte (verified by test); improvements come later as ordinary migrations.
- No interactive migration prompts. Users never answer schema questions; it applies or it fails
  loudly with a backup on disk.

## Architecture

### Layout

```text
src/db/
  schema.ts           # Drizzle table definitions — THE schema source of truth
  migrate.ts          # sync auto-apply: journal check, baseline stamp, backup, apply, guards
  migrations/         # drizzle-kit v1 timestamp dirs: YYYYMMDDHHMMSS_name/{migration.sql,snapshot.json}
drizzle.config.ts     # drizzle-kit config (dialect sqlite, schema + out paths)
```

If REFACTOR_PLAN Phase 2 has landed, this lives at `src/runtime-home/app-db/` instead (same
files); `initializeAppDatabase`'s DDL body is deleted either way, and `ensureRuntimeHome*` calls
`applyAppDbMigrations(path)` in its place. The reconcile/seed functions (notification dedupe,
active-session reconciliation, `neondeck-main` seed row, legacy session migration) are **data**
maintenance, not schema — they stay as post-migrate code, unchanged.

### Dev workflow

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` (wrapping `drizzle-kit generate --output json`) → emits
   `YYYYMMDDHHMMSS_<name>/migration.sql` plus `snapshot.json`. Commit both. `--explain` is the dry
   run.
3. `npm run check` includes a drift gate using
   `drizzle-kit generate --output json --explain`: fail if the schema would produce a new migration
   (schema.ts changed without a committed migration). `drizzle-kit check` plus the native
   commutativity conflict check cover journal consistency across parallel branches.
4. Applied migrations are immutable — fixing a mistake means a new migration, never an edit.
5. Agent ergonomics: drizzle-kit ships Agent Skills for exactly this workflow. Register the
   relevant ones (`drizzle`, `drizzle-generate`, `drizzle-migrations`, `drizzle-pull`,
   `drizzle-output-modes`, `drizzle-responses-and-errors`) with the repo's skill setup the same
   way the Flue skill is linked (`.codex/skills/`, `.kilo/skills/`) so implementation agents use
   the intended JSON/non-interactive surface instead of guessing CLI flags. `drizzle-kit mcp` is
   available as an optional dev-time MCP server — a natural test subject once
   `.plans/MCP_SUPPORT_PLAN.md` lands, but not part of this plan.

### User workflow

There isn't one. On any entry point (server boot, any CLI command), before anything else touches
the DB:

1. Open the database, `PRAGMA busy_timeout` set, then `BEGIN IMMEDIATE` as a cross-process gate
   (server and CLI can race on the same file; the loser waits, then sees migrations applied).
2. Compare the shipped journal to the `__drizzle_migrations` table. Nothing pending → continue
   (the everyday path; must cost ~one query).
3. Pending migrations → **back up first**: copy `neondeck.db` (+ `-wal`/`-shm` if present) to
   `data/backups/neondeck-<utc-ts>-pre-<NNNN>.db`, keep the newest 5, delete older.
4. Apply pending migrations in order, each in its own transaction.
5. On failure: roll back the failing migration, close, and exit with a message naming the
   migration, the error, and the backup path. Never continue with a half-migrated schema.

### The baseline problem (existing installs)

Existing databases have all the tables but no Drizzle journal. Solution — a stamped baseline:

- Migration `YYYYMMDDHHMMSS_baseline/migration.sql` is the complete current schema, generated from
  the hand-authored Drizzle `schema.ts` because `pull --init` cannot introspect Neondeck's
  expression index. Verify it against a legacy-created v9 database with the parity test before
  deleting the legacy DDL body.
- `migrate.ts` pre-step: if `__drizzle_migrations` is missing **and** the DB already has the
  legacy schema (detect: `app_metadata` row `schema_version = '9'`, or presence of a sentinel
  table), create the journal table and record the actual shipped baseline migration row from
  `readMigrationFiles` (name, hash, created_at) as applied _without executing it_. Fresh databases
  execute the baseline normally.
- A legacy DB at `schema_version < 9` (predates the last hand-rolled rebuild) is not expected in
  the wild, but handle it honestly: run the retained legacy upgrade functions once to reach v9,
  then stamp. Delete that shim after one or two releases.
- `app_metadata.schema_version` stays frozen at `'9'` for compatibility; the Drizzle journal is
  the authority from now on.

### Downgrade guard

The scenario the old system silently corrupts: user upgrades (schema moves forward), then
`npm install neondeck@older`. The old binary must not write to the newer DB. `migrate.ts` checks:
if `__drizzle_migrations` contains entries **not present in the shipped journal**, refuse to open
with a clear message ("this database was created by a newer Neondeck; upgrade the package or
restore `data/backups/...`"). This check is the real replacement for `schema_version`.

### Packaging

Migration directories containing `migration.sql` and `snapshot.json` must ship in the published npm
package, and `migrate.ts` must resolve them relative to its own module URL (`import.meta.url`),
never `cwd`. When publishing lands, `package.json` `files` includes `src/db/migrations/` (or the
build step copies them into `dist/`); a smoke test in CI runs `npm pack` and boots the CLI from the
packed tarball against a fresh temp home — that test is the one that actually proves the
npm-install story.

### Surfacing

- `neondeck db status` (read-only): applied/pending migrations, journal head, last backup. No
  manual `db migrate` command — auto-apply makes it a footgun; the escape hatch is running any
  command.
- Runtime status gains a check: journal consistent / downgrade detected. Post-boot "pending
  migrations" should be impossible by construction.
- `safety.ts` entries for the new CLI command/route if a status route is added.

## Delivery: one PR

Commit order within the PR:

1. **Spike commit**: add `drizzle-orm@1.0.0-rc.x` + `drizzle-kit` (exact pins), throwaway test
   covering what package inspection could not confirm: per-migration transaction behavior of
   `migrateSync`, the `__drizzle_migrations` table shape (needed by the baseline stamp and
   downgrade guard), `pull --init` output against a legacy-created DB, and the SDK explain-mode
   drift check. (Already verified from the installed RC, no need to re-prove: `./node-sqlite`
   driver, `drizzle({ client: DatabaseSync })`, sync `migrate()`, `pull --init` and commutativity
   checks existing, `--output json`/`--explain`/skills/MCP shipping.) Record findings by editing
   this section.

   Findings from `drizzle-orm@1.0.0-rc.4` / `drizzle-kit@1.0.0-rc.4`:
   - The v1 runtime migration folder format is `YYYYMMDDHHMMSS_name/migration.sql` plus
     sibling `snapshot.json`; `readMigrationFiles` rejects the older `meta/_journal.json`
     layout.
   - The journal table is
     `__drizzle_migrations(id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`.
   - Drizzle's node-sqlite `migrate()` is synchronous, but wraps all pending migrations in one
     transaction. Neondeck needs its own small sync apply loop so `BEGIN IMMEDIATE`, backup
     creation, and failure reporting can run per pending migration.
   - `drizzle-kit pull --init --output json` emits a machine-readable manifest for simple SQLite
     databases, but this RC cannot introspect SQLite expression indexes such as
     `idx_memories_scope_key_repo`; the baseline schema is therefore hand-authored from current
     DDL and verified by parity tests.
   - `drizzle-kit/api-sqlite` does not export `generate(...)` in this RC despite the bundled
     skill text. Drift checks use `drizzle-kit generate --output json --explain`.

2. `schema.ts` bootstrapped from the legacy DDL + timestamped baseline migration + **parity
   test**: create one DB via legacy `initializeAppDatabase`, one via migrations; dump and compare
   normalized schema (tables, columns, indexes, AUTOINCREMENT flags) — must be identical.
3. `migrate.ts` (baseline stamp, backup + rotation, cross-process gate, downgrade guard) wired
   into `ensureRuntimeHome*`; legacy DDL body deleted; reconciles/seeds retained post-migrate.
4. Drift + journal checks in `npm run check`; `db:generate` script; `neondeck db status`;
   runtime-status check; docs touch (configuration page's data section + AGENTS.md dev-commands
   note); REFACTOR_PLAN non-goal clarification.

Tests: baseline stamp on a v9 fixture DB; fresh-DB full run; downgrade-guard fixture (journal row
the binary doesn't know); backup creation + rotation; migration-failure rollback leaves DB
untouched and backup present; the existing `runtime-home.test.ts` and `fresh-runtime-smoke`
integration suite must pass unchanged. Sanctioned split if the PR bloats: land commits 1–2
(schema + parity, legacy path still active) separately from 3–4 (cutover).

## Risks & Open Questions

- **Drizzle v1 is an RC.** Pin exact; the blast radius is contained to `src/db/` — stores don't
  import Drizzle. If v1 churns badly before stabilizing, the fallback is keeping Drizzle-kit as a
  dev-only generator and applying its SQL files with our own sync runner (commit 1 decides this
  anyway); worst case we own ~40 lines of migrator instead of zero.
- **Schema parity bugs.** A subtle mismatch between `schema.ts` and the legacy DDL means fresh
  and upgraded installs diverge forever. The parity test in commit 2 is the non-negotiable guard;
  keep it running in CI permanently (it also catches future hand-edits to migrations).
- **Concurrent open during migration.** Server booting while a CLI command runs. The
  `BEGIN IMMEDIATE` gate + busy timeout covers it; test it explicitly with two processes.
- **tsx-run bin vs packaged layout.** `bin` currently points at `src/cli.ts` via tsx; migration
  path resolution must work in repo checkouts _and_ installed packages. `import.meta.url`-relative
  resolution handles both, but the `npm pack` smoke test is the proof.
- **Open question — WAL mode.** Enabling WAL would make concurrent server+CLI access smoother and
  backups slightly more involved (must copy `-wal` too, or checkpoint first). Not required for
  this plan; decide separately. The backup step already copies sidecar files defensively.
- **Open question — Flue DB drift.** If a future Flue version migrates `flue.db` incompatibly,
  that's Flue's journal, not ours; our downgrade guard must not inspect `flue.db` at all.

## Definition of Done

- A user on an existing v9 database upgrades the package, runs any command, and their DB is
  migrated automatically with a timestamped backup on disk — no prompts, no commands.
- A fresh install creates the schema purely from committed migrations; the legacy DDL block no
  longer exists in the codebase.
- The parity, baseline-stamp, downgrade-guard, rollback, and backup-rotation tests pass; the
  `npm pack` smoke test boots the CLI from a packed tarball against a fresh home.
- An older binary opening a newer database refuses loudly instead of writing.
- Devs change schema by editing `schema.ts` + `db:generate`; CI fails on drift or journal
  conflicts; applied migrations are never edited.
- `npm run verify` passes.
