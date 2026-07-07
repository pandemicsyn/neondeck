# Agent Handoff Plan (let Claude/Codex/Kilo/CI register work with Neon)

Status: **complete / archived** — the CLI commands, localhost HTTP mirror, runtime skill, docs,
attribution/audit path, and verification coverage have landed. Original specification for a
small, stable surface that lets _other_ agents and systems hand things to Neondeck: "watch this
PR I just pushed", "note this for the deck", "queue a review of this". Written 2026-07-06
against main `7ede574`.

## Purpose

Neondeck assumes work enters through its own surfaces — the deck, Neon's chat, its watchers.
But the developer's _other_ agents create work all day: a Claude Code session pushes a PR, a
Codex run finishes a refactor, CI cuts a release candidate. Today none of them can tell Neon.
The human is the message bus: they finish a session with one agent, then walk to the deck and
re-type what just happened.

The fix is deliberately boring: a **registration surface** (CLI-first, HTTP for non-CLI
systems) plus a **skill artifact** that teaches external agents to use it. Registration verbs
are additive and low-risk — they create watches, notes, and queued work that flow into the
exact pipelines Neondeck already trusts. No external agent gains execution, mutation, or
approval powers.

## Ground Rules (verified against main `7ede574`, 2026-07-06)

- **The CLI already runs in-process against the runtime home** — `neondeck watch-pr <ref>`
  (`src/cli/index.ts:439`) calls `addPrWatch` directly with `pathsFromOptions` +
  `loadEnvForPaths`; no server required, durable records written to the shared SQLite. This
  is the ideal transport for same-host agents (Claude Code, Codex, Kilo all run where the
  repo lives). `bin/neondeck.mjs` is on `$PATH` for installs.
- **Local API posture**: `requireLocalApiAccess` (`src/server/middleware.ts:13`) allows
  localhost with origin/sec-fetch checks for unsafe methods; non-browser localhost clients
  (curl with no Origin header) pass today. A token mechanism already exists for gated routes
  (`requireFlueRunInspectionToken`, `readLocalApiToken`).
- **Existing registration-shaped machinery**: PR watches (`addPrWatch`, ref parsing via
  `parseWatchPrReference`), release watches, scheduler blueprints, notifications
  (`addNotification` — internal only; the HTTP surface has read/resolve but **no create
  route**), reports, and the `review-pr-for-human` workflow (dashboard-invocable).
- **Attribution precedent**: approvals record `approverSurface`; watches/routines record
  `created_by`-style provenance. Registration must carry the same.
- **Trust precedent**: `/fix-ci` is denylisted from model-callable command_run because it
  executes on the host; `/review-pr` is model-callable because it only reads + drafts.
  External-agent verbs must sort along the same line.

## Non-Goals

- **No remote/network ingest in v1.** Same-host only (CLI in-process; HTTP bound to
  localhost). Remote CI ingest is a real want but it's an authentication design (tokens,
  rotation, scoping) — recorded as v2, with the existing `localApiToken` header machinery as
  the starting point. Do not quietly widen `requireLocalApiAccess`.
- **No execution or mutation verbs.** External agents cannot trigger pushes, fixes, approvals,
  resolutions, or anything host-executing. `fix-ci` stays human-admitted. The one
  agent-dispatching verb (`--review`, below) is explicitly flagged and default-off.
- **No new deck panels.** Registered items land in existing surfaces (watch rows, the
  notification stream, the review queue) — that's the point.
- **Not an inbound MCP server.** Worth considering someday (Neon-as-MCP-tool for other
  agents); v1 is a CLI because every target agent can run a shell command, and the CLI
  needs no server process.

## Design

### The verbs (v1)

All CLI subcommands (in-process, server optional), all emitting `--json` machine output with
a stable `{ ok, action, id?, message, deckUrl? }` contract and meaningful exit codes:

1. **`neondeck watch-pr <owner/repo#N | repo#N>`** — exists. Additions: `--from <agent>`
   attribution, `--json`, and idempotency (registering an already-watched PR returns the
   existing watch with `ok: true` instead of erroring — external agents will retry).
2. **`neondeck watch-release <repo> [--source-pr <ref>]`** — thin CLI over the existing
   release-watch blueprint (`schedule` command already creates blueprints; this is the
   ergonomic alias with attribution).
3. **`neondeck note <text> [--repo <ref>] [--pr <ref>] [--level info|ready|attention]`** —
   the missing "leave a message on the deck" verb. Creates a notification
   (`source: 'external:<agent>'`, linked repo/PR metadata) through a new `createNote` service
   wrapping `addNotification` with validation: level capped at `attention` (external agents
   cannot mint `urgent`), body bounded (4 KiB), linked refs validated against the registry
   when provided. This is how "Claude finished the refactor, here's the summary" reaches the
   deck — and Neon's briefing — without a human retyping it.
4. **`neondeck register-pr <ref> [--review] [--watch] [--note <text>]`** — the composite verb
   the motivating example wants: one call after `git push` that (default) watches the PR +
   attaches the note. `--review` additionally queues `review-pr-for-human` — **decision
   flag**: it dispatches an LLM run, but one that only reads GitHub and produces
   reports/drafts (the same reason `/review-pr` is model-callable), so allowing it is
   consistent; it ships default-off and behind a config knob
   (`handoff.allowExternalReviewQueue`, default `true` — flip to `false` if it gets abused).

### HTTP mirror (same host, for non-CLI systems)

`POST /api/handoff/watch-pr`, `/api/handoff/note`, `/api/handoff/register-pr` — thin routes
over the same services, behind `requireLocalApiAccess` like everything else, each requiring a
`source` field (the attribution). Exists so a local script, git hook, or non-Node agent can
`curl` without the CLI's tsx startup cost. Safety-table entries: safeMutation, audited,
"external registration surface — creates watches/notes only; no execution path."

### Attribution and audit

Every verb records `source` (`external:claude-code`, `external:codex`, `ci:github-actions`,
free-form but required for the HTTP routes; the CLI defaults to `external:cli` when `--from`
is omitted). Watch rows and notifications display the source (one line in the existing row
components); a workflow-summary audit row per registration (`workflow: 'agent_handoff'`)
gives the deck history "Claude registered PR #123 at 14:02".

### The skill artifact (the other half of the feature)

A registration surface nobody's agent knows about is dead code. Ship
`skills/neondeck-handoff/` in-repo containing:

- **`SKILL.md`** — agent-facing instructions in the agentskills.io shape (compatible with
  Claude Code skills and Hermes skills alike): _when you push a PR in a repo the user tracks
  with Neondeck, run `neondeck register-pr <ref> --from <your-name> --note "<one-line
summary>" --json`; when you finish significant work without a PR, `neondeck note`; check
  `command -v neondeck` first and stay silent if absent._ Includes the JSON output contract
  and exit codes so agents can branch on results.
- **Install pointers** in the docs page ("Connecting other agents"): copy into
  `~/.claude/skills/` for Claude Code, reference from AGENTS.md/CLAUDE.md for repo-scoped
  use, Hermes `skills/` drop-in.
- The skill is also seeded as a Neondeck **runtime skill** so Neon itself can explain the
  handoff surface when asked — and so the learning loop can patch the guidance.

### What happens after registration (already built, free)

A registered PR watch flows into: watcher refreshes → autopilot triage → the review queue →
`/review-pr` reports → prepared-diff/fix loops — all gated exactly as if the human had
clicked "watch". A note lands in notifications → morning briefing → attention policy. This
plan builds the on-ramp, not new roads.

## Delivery: one PR

1. Services + attribution fields (watch source threading, `createNote`), idempotent
   `addPrWatch` return, `register-pr` composite, config knob.
2. CLI subcommands + `--json` contract; HTTP mirror routes + safety entries.
3. `skills/neondeck-handoff/SKILL.md` + runtime-skill seed + docs section.
4. Tests: idempotent re-register, note validation/bounds/level cap, attribution persisted and
   displayed, JSON contract snapshots, HTTP routes reject missing `source`, `--review`
   respects the config knob, exit codes.

Manual pass recorded in the PR: from a Claude Code session in a registered repo — push a
branch PR, run `register-pr --review`, confirm the watch row (with source), the note, and the
review reports appear on the deck untouched.

## Risks

- **Attribution is honor-system** — any local process can claim `--from claude-code`. Fine:
  everything runs as the same user on the same host; attribution is for provenance display,
  not security. The security boundary remains "what the verbs can do", which is why v1 verbs
  are watch/note only.
- **Noise** — an over-eager agent skill could register everything. Bounds: notes are bounded
  and level-capped, watches are idempotent, and the skill text says "repos the user tracks".
  If volume becomes real, add per-source daily caps (constants) — not speculatively.
- **CLI startup cost** (tsx spawn) — acceptable for occasional handoffs; the HTTP mirror is
  the hot path if it ever matters.
- **`--review` scope creep** — the flag is the wedge where "registration" could drift into
  "external agents driving Neon". The config knob and the explicit non-goal line are the
  fence; any future verb that dispatches work must clear the same bar `/review-pr` did
  (reads + drafts only) or be human-admitted.

## Definition of Done

- From a Claude Code session: `neondeck register-pr myrepo#42 --from claude-code --note
"adds retry logic" --json` returns machine-readable success; the deck shows the watch
  (attributed), the note, and — with `--review` — the two review reports, with zero human
  re-typing.
- The same works via `curl` from a git post-push hook on localhost.
- The shipped skill file makes a stock Claude Code session do this unprompted after a push.
- External agents gained no execution, approval, or mutation capability; every registration
  is attributed and audited; `npm run verify` passes.
