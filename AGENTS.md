# AGENTS.md

This repository is `neondeck`: a local-first developer cockpit for a companion display, starting with the Corsair Xeneon Edge. The product goal is not just a chat app. Neondeck should become a small local operating system for developer context: repo registry, GitHub work queue, schedules, watches, runtime skills, memory, notifications, and durable Flue chat sessions.

## Read First

- Product roadmap: `.plans/ROADMAP.md`
- Hermes research notes and inspiration: `.plans/HERMES_RESEARCH.md`
- User-facing project summary: `README.md`
- Current agent personality file: `SOUL.md`

The roadmap is the source of truth for direction and implementation order. The current priority is Neondeck home/runtime state, typed Flue actions for self-configuration, repo/GitHub foundation, schedules/watches, runtime skills, and then dashboard polish over that runtime.

## Architecture Direction

- Backend: Node 26, Hono, Flue.
- Dashboard: Vite, React, Tailwind v4.
- Marketing/docs site: Astro under `docs/`, deployed to Cloudflare for `neondeck.dev`.
- Persistence: local SQLite. Keep Neondeck app state separate from Flue runtime state unless the roadmap changes.
- Runtime config target: `NEONDECK_HOME`, then `XDG_CONFIG_HOME/neondeck`, then `~/.config/neondeck`.

Design toward one backend command/event surface. The web dashboard is the first UI, but a future TUI/OpenTUI should reuse the same backend APIs and event streams rather than growing a second agent runtime.

## Important Project Paths

- `src/`: Hono/Flue backend, agents, metrics, SOUL loading, database setup.
- `web/`: local dashboard SPA.
- `web/src/plugins/`: typed dashboard display plugins.
- `docs/`: Astro marketing/docs site.
- `config/dashboard.json`: current local dashboard layout config.
- `.codex/skills/flue/`: in-repo development skill for Flue.
- `.kilo/skills/flue`: Kilo link to the Flue skill.
- `.plans/`: planning and research documents.
- `research-repos/`: local research checkouts, gitignored.

## Agent Behavior Guidelines

- Prefer deterministic APIs/actions for facts and mutations.
- Do not make the agent freestyle-edit Neondeck config as the primary path. Config changes should go through typed Flue actions once those exist.
- Keep session context stable. SOUL, selected skills, memory summaries, and repo config should be loaded deliberately rather than silently changing mid-session.
- Treat memory as current guidance for future sessions. Memory uses only `user`, `local`, and `project` scopes. Archive stale guidance instead of deleting it so audit history remains intact.
- Treat learning operator state as an auditable subsystem. Use `/api/learning/state`, the Learning dashboard tab, or `neondeck learning ...` for reviews, candidates, memory decisions, skill patch decisions, and audit history. Handled PR/autopilot learning events come from Flue workflow observations and typed local API action results with idempotent source ids. Applied skill patches may be restored only through the explicit audit-backed restore action when the target file is unchanged since application.
- Build deterministic watchers first. Invoke agent reasoning only when there is a meaningful state change to summarize or act on.
- Treat skills as guidance and actions as execution.
- Keep UI work consistent with the existing Xeneon/Miami tiger-stripe design language unless the user asks to change direction.

## Development Commands

Use Node 26:

```sh
fnm use 26.4.0
```

Fast loop:

```sh
npm run check
```

Individual checks:

```sh
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run test:all
npm run format:check
npm run db:check
```

Database migration workflow:

```sh
npm run db:generate -- --name <migration_name>
npm run db:check
```

Full verification:

```sh
npm run verify
```

Local dev:

```sh
npm run dev
```

Marketing/docs site:

```sh
npm run docs:astro-dev
npm run docs:build
```

## Formatting And Linting

- Lint: Oxlint.
- Format: Prettier with Astro plugin.
- Tests: Vitest.
- `npm run test` runs the fast unit suite.
- `npm run test:integration` runs the slower git/worktree/Kilo/autopilot workflow suites.
- `npm run test:all` runs every Vitest suite.
- `npm run check` is intended to stay fast and uses the unit suite.
- `npm run verify` includes the full Vitest suite, format check, and full build.

## Changesets

- Add `npm run changeset` for user-facing package changes.
- Use patch for fixes, minor for features, and major for breaking changes.
- Skip changesets for docs, tests, and internal-only work.
- Never run prerelease or version commands in feature PRs; automation owns the version PR.

## Current Notes

- `.env` is local-only and gitignored.
- `design/` is local reference material and gitignored.
- `research-repos/` is local research material and gitignored.
- Build output directories are gitignored.
