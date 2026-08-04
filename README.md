# neondeck

A note from me, the human:

- Is this vibe coded? 100% barely looked at the code. Its fine'ish.
- Should this maybe have been vanilla Pi? Probably. This started out life has just a little companion app.
- Does this do well with large diffs? 110% - use this to review 50k line pr's pretty regularly at day job.
- Is this a serious thing ? No, but it's really fucking useful.

This thing does 3 things

1. Helps me review _alot_ of PRs without having to ever open up Github.
2. Manages my PR's for me. Kilo/codex hand off changes to Neon, and neon takes care of them through merge. Reviews are basically the only time I look at code at this point.
3. Sends me a morning briefing to help me keep up with the stuff all my EU coworkers have shipped.

## From the robots

A companion agent for keeping PRs moving, getting reviews done, and helping humans stay on task.

Neon watches your PRs, tracks CI and release checks, and can configure its own
repos, schedules, models, and deck layout through typed tools and APIs. Its current
PR watches retain complete feedback facts and semantic watermarks, including an
explicit choice to process or baseline existing feedback. Autopilot can bind one
continuing Neon owner and one managed worktree to a watched PR, hold committed
changes for review, or push after the continuing owner judges a change sound and
sufficiently validated and the current mechanical delivery guards pass.

It is especially useful on a companion display, vertical panel, or Corsair
Xeneon Edge-style deck, where your active work can stay visible without taking
over your editor. The backend is Node 26, Hono, and Flue; the dashboard is Vite,
React, and Tailwind. Neondeck can run on your machine or on a remote host, with
mutable state stored in SQLite under a runtime home you control.

## Built for work in progress

Neon watches your PRs, prepares fixes, and keeps things moving.

- **Your PRs, with CI status at a glance.** See open PRs across your repos in
  one panel, with live check status and stale-work flags.
- **Watch a PR without losing feedback.** Watch polling records complete review,
  conversation, requested-change, commit, and check facts with semantic
  fingerprints. Current feedback can be processed on the first poll or baselined
  explicitly. Meaningful feedback and failing checks now reuse one continuing
  owner and managed worktree. Autopilot can notify, prepare a reviewable commit,
  wait for approval in that same owner conversation, or deliver automatically
  when the owner judges the change reasonable, appropriately scoped, and
  sufficiently validated.
- **Review and approve PRs on the deck.** Read diffs, leave inline comments,
  resolve threads, traverse files, hunks, drafts, threads, and revision-bound
  Neon findings, and submit approvals or change requests without switching to
  github.com. Findings can be dismissed locally or explicitly promoted into
  the existing draft/revision workflow without silently submitting anything.
  Neon reviews against an exact-head, read-only Git workspace and keeps a
  durable reviewer chat available for follow-up questions.
- **Handoff, both directions.** Delegate work to agents like Kilo or Codex, then
  let the finished PR come back to Neon for checks and deployment follow-through.
- **Conversational briefings and scheduled instructions.** Neon grounds a
  durable Morning Briefing conversation in an inspectable local snapshot, then
  can enrich it with any relevant configured MCP source under normal login and
  approval controls. Follow up in chat, or run your own saved prompt on a timer.
- **Scoped execution for each job.** Keep code-changing work in managed
  worktrees, use approval policy for ordinary chat and scheduled operations, give the
  trusted Autopilot coding owner a repository-native workspace with a
  credential-free default environment, or run mediated work on an `exe.dev`
  sandbox VM.
- **Memory that learns from your work.** Neon turns conversations and PR
  outcomes into typed, validated, audited, reversible memory and skill
  improvements. Safe writes apply automatically by default; explicit
  `review` and `off` modes keep autonomy operator-controlled.
- **Ask Neon to set up the deck.** Configure repos, models, schedules, layout,
  and display behavior through typed tools instead of hand-editing every file.

## Project shape

- `src/`: Hono/Flue backend, agents, tools, app-owned operations, persistence, metrics,
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

The setup wizard prepares a runtime home, configures KiloCode, OpenAI API-key,
Anthropic, ChatGPT subscription, or generic OpenAI-compatible model access,
checks the Git identity used by Autopilot commits, adds local repositories,
applies a dashboard preset, and can create initial schedules and command
preapprovals. When the global Git identity is incomplete, the wizard warns and
offers to configure it instead of allowing Git to silently invent one from the
local account and hostname. Complete author and committer overrides persisted in
the runtime-home `.env` are also accepted; temporary shell exports do not
suppress the setup warning.

ChatGPT login/logout and provider registration changes made with the standalone
CLI apply after Neondeck restarts. Generic endpoint URLs are user-owned setup:
configure them with `neondeck init` or the local access-controlled dashboard/API,
not through model-callable tools.

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
npm run cli -- auth status openai-codex # ChatGPT subscription status
npm run cli -- doctor    # local diagnostics
npm run check            # fast local verification
npm run test:integration # slower operation/worktree coverage
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
- [`QA.md`](./QA.md): install and validate published npm releases on a
  persistent Linux QA host.
- [Configuration](https://neondeck.dev/docs/configuration/): runtime config,
  models, providers, repos, schedules, SOUL, and skills.
- [Agent runtime](https://neondeck.dev/docs/agent-runtime/): Flue agents,
  tools, app-owned operations, memory, watches, reports, and scheduled tasks.
- [Autopilot](https://neondeck.dev/docs/autopilot/): watched-PR modes,
  semantic autonomous judgment, delivery guards, and fail-closed recovery.
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
