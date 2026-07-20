# neondeck

A companion agent for keeping PRs moving.

Neon watches your PRs, tracks CI and release checks, and can configure its own
repos, schedules, models, and deck layout through typed actions. Its current
watcher-driven Autopilot path durably triages actionable events, prepares an
isolated worktree, dispatches authoritative bounded turns to one continuing
PR-owner agent per watch, then continues through verification, policy-bound
approval or safe push, result delivery, and cleanup admission. Setup/control UX
and the full product-path smoke remain roadmap work.

It is especially useful on a companion display, vertical panel, or Corsair
Xeneon Edge-style deck, where your active work can stay visible without taking
over your editor. The backend is Node 26, Hono, and Flue; the dashboard is Vite,
React, and Tailwind. Neondeck can run on your machine or on a remote host, with
mutable state stored in SQLite under a runtime home you control.

## Built for work in progress

Neon watches your PRs, prepares fixes, and keeps the busywork moving.

- **Your PRs, with CI status at a glance.** See open PRs across your repos in
  one panel, with live check status and stale-work flags.
- **Watch a PR with a continuing owner.** Actionable watcher events enter one
  restart-safe coordinator, reuse one managed worktree and Flue instance, and
  reach a narrow PR-owner turn grounded in complete review/CI facts, current
  policy, exact memory ids, and a one-time deterministic fix submission. New
  events serialize and coalesce per PR. Fundamental capability drift rotates
  the owner with an audited handoff; explicit repo-Autopilot-policy or selected
  memory drift re-grounds the same instance, while unknown or structural config
  drift blocks safely. Post-fix verification and delivery continuation remain
  separate roadmap packages.
- **Review and approve PRs on the deck.** Read diffs, leave inline comments,
  resolve threads, traverse files, hunks, drafts, threads, and revision-bound
  Neon findings, and submit approvals or change requests without switching to
  github.com. Findings can be dismissed locally or explicitly promoted into
  the existing draft/revision workflow without silently submitting anything.
- **Handoff, both directions.** Delegate work to agents like Kilo or Codex, then
  let the finished PR come back to Neon for checks and deployment follow-through.
- **Conversational briefings and scheduled instructions.** Neon grounds a
  durable Morning Briefing conversation in an inspectable local snapshot, then
  can enrich it with any relevant configured MCP source under normal login and
  approval controls. Follow up in chat, or run your own saved prompt on a timer.
- **Sandboxed, gated execution.** Keep code-changing work in throwaway
  worktrees, gate shell commands through approval policy, or run work off your
  machine on an `exe.dev` sandbox VM.
- **Memory that learns from your work.** Let Neon remember approved preferences
  and repo conventions from conversations and PR feedback.
- **Ask Neon to set up the deck.** Configure repos, models, schedules, layout,
  and display behavior through typed actions instead of hand-editing every file.

## Project shape

- `src/`: Hono/Flue backend, agents, actions, workflows, persistence, metrics,
  CLI, and runtime-home setup.
- `web/`: Vite, React, and Tailwind dashboard for the local companion display.
- `docs/`: Astro marketing/docs site deployed to Cloudflare for
  [neondeck.dev](https://neondeck.dev).
- `config/`: checked-in defaults copied into new runtime homes.
- `SOUL.md`: default personality/context material for Neon.

## Quick start

Use Node 26.4.0 or newer.

```sh
npm install
npm run init
npm run dev
```

Open `http://127.0.0.1:5173/`.

The setup wizard prepares a runtime home, configures provider secrets, adds
local repositories, applies a dashboard preset, and can create initial schedules
and command preapprovals.

## Runtime home

Mutable local state lives outside the source tree. Neondeck resolves runtime
home in this order:

```text
NEONDECK_HOME
XDG_CONFIG_HOME/neondeck
~/.config/neondeck
```

That home contains local secrets, runtime config, repo registration, dashboard
layout, schedules, skills, and separate SQLite databases for Neondeck app state
and Flue runtime state.

## Common commands

```sh
npm run dev              # local backend + dashboard
npm run cli -- status    # runtime readiness and configured paths
npm run cli -- doctor    # local diagnostics
npm run check            # fast local verification
npm run test:integration # slower workflow coverage
npm run build            # production dashboard/server + docs build
npm run docs:astro-dev   # hot dev server for the docs site
```

After a production build or package install:

```sh
neondeck service install
neondeck open
neondeck open sidebar
```

## Documentation

- [neondeck.dev](https://neondeck.dev): public site and product docs.
- [Getting started](https://neondeck.dev/docs/getting-started/): install,
  secrets, runtime home, dashboard launch, and local app install.
- [Configuration](https://neondeck.dev/docs/configuration/): runtime config,
  models, providers, repos, schedules, SOUL, and skills.
- [Agent runtime](https://neondeck.dev/docs/agent-runtime/): Flue agents,
  actions, workflows, memory, watches, reports, and scheduled tasks.
- [Execution environments](https://neondeck.dev/docs/execution/): local and
  sandboxed execution policy.
- [MCP servers](https://neondeck.dev/docs/mcp/): MCP registration, OAuth, tool
  policy, and approvals.
- [Contributing](https://neondeck.dev/docs/contributing/): roadmap workflow,
  checks, reviews, and PR expectations.
- [Development](./DEVELOPMENT.md): repo-local setup, checks, builds, packaging,
  docs deployment, and publishing notes.

## Status

Neondeck is active local-first infrastructure work. The roadmap lives in
`.plans/ROADMAP.md`; it is the source of truth for implementation order and
near-term priorities.

## License

MIT
