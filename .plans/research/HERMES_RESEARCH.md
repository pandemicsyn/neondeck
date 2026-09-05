# Hermes Agent Research Notes

Research target: `research-repos/hermes-agent`

Purpose: capture Hermes implementation patterns that are useful for Neondeck as we build a local-first, Flue-backed developer assistant with persistent config, user skills, scheduled jobs, repo intelligence, and a dedicated dashboard.

## Executive Summary

Hermes is organized around a few strong ideas worth borrowing:

- Profile-local state is the center of gravity. Config, env, skills, cron jobs, memories, plugins, and session data are scoped under a Hermes home/profile directory.
- The agent prompt is intentionally stable. Memory and identity are loaded into the system prompt at session start, then frozen until prompt rebuild/compression.
- Skills use progressive disclosure. The prompt sees names/descriptions; full skill files and linked references are loaded only when needed.
- Cron has a raw job system plus typed "automation blueprints" that create normal jobs. Blueprints give users friendly forms/commands without introducing a separate scheduler.
- The TUI is thin and reactive. TypeScript/Ink owns rendering, while Python owns sessions, model/tool work, config, slash commands, approvals, and persistence over a JSON-RPC gateway.
- The same gateway dispatch can run over stdio or WebSocket, which is a good model for supporting web UI first and a terminal UI later.

## Memory System

Relevant files:

- `tools/memory_tool.py`
- `agent/system_prompt.py`
- `agent/memory_provider.py`

### Storage Model

Hermes' built-in memory is file-backed and profile-local:

- `get_hermes_home() / "memories" / "MEMORY.md"` stores agent notes: project conventions, environment facts, tool quirks, and learned lessons.
- `get_hermes_home() / "memories" / "USER.md"` stores user profile and preference information.
- Entries are delimited inside the files by a section sign delimiter.
- Memory budgets are character-based rather than token-based. Defaults are roughly 2200 characters for agent memory and 1375 characters for the user profile, with config overrides.

The key design choice is that memory is a curated, bounded context source, not an append-only event log.

### Prompt Injection Model

`agent/system_prompt.py` treats memory as a volatile prompt tier:

- Stable tier: identity, tool guidance, skills index, environment hints, platform hints.
- Context tier: caller system message and context files from the current working directory.
- Volatile tier: memory snapshot, user profile, external memory provider block, date/session/model/provider line.

Despite being called "volatile", the full system prompt is built once per session and cached. Hermes avoids re-rendering it on every turn to preserve provider prefix-cache behavior. `memory_tool.py` updates files immediately, but the current session does not automatically see new memory in its prompt. New memory enters the prompt on the next session or after an explicit prompt rebuild path such as compression.

This is the most important memory lesson for Neondeck: live writes and prompt state should be different concepts. The UI can show updated memory/config immediately, while agent context remains session-stable unless we intentionally rebuild it.

### Mutation Tool

Hermes exposes memory mutation through one tool with actions such as:

- `add`
- `replace`
- `remove`
- batch operations

The tool has careful write behavior:

- File locks protect cross-process writes.
- Writes are atomic via temp file plus rename.
- `replace` and `remove` detect external drift so one writer does not clobber another.
- Backups are written on risky/error paths.
- Duplicate entries are avoided.
- Success responses do not echo full memory content, which reduces prompt churn.
- Error responses include enough current state for the agent to consolidate safely.

### Safety

Memory content is scanned for prompt-injection and exfiltration patterns. On prompt load, suspect entries are replaced with blocked placeholders in the frozen prompt snapshot while raw entries remain on disk for inspection/removal.

### Neondeck Implications

For Neondeck:

- Store state under an app home such as `~/.config/neondeck/`.
- Treat persistent memory/config as durable local state, not automatically mutable prompt text.
- Freeze `SOUL.md`, loaded skills, memory summaries, and repo config at session start.
- Make config/memory updates deterministic actions with locking and validation.
- Avoid echoing entire config or memory blobs after successful updates.
- Consider separate stores for user profile, agent notes, repo registry, watches, and scheduled job state.

## Server And TUI Layer

Relevant files:

- `ui-tui/README.md`
- `ui-tui/package.json`
- `tui_gateway/entry.py`
- `tui_gateway/server.py`
- `tui_gateway/ws.py`

### Shape Of The TUI

Hermes' TUI is a React + Ink TypeScript app. It owns rendering and input behavior, but it does not own core agent logic.

The Python gateway owns:

- session creation/resume/close
- model and provider execution
- tool calls
- slash commands
- approvals
- clarify prompts
- sudo/secret prompts
- config reads/writes
- skills management
- project/repo discovery
- cron management
- persistence and session finalization

The TypeScript TUI starts the Python gateway as a child process and communicates over newline-delimited JSON-RPC on stdio. Gateway stdout is reserved for protocol messages, while stderr is treated as logs/noise and captured separately.

### Transport

`tui_gateway/ws.py` reuses the same server dispatch over WebSocket. That means Hermes can expose the same command/session/event surface over stdio or WebSocket without duplicating business logic.

This maps well to Neondeck:

- Build the web UI first against a typed local API/WebSocket surface.
- Keep agent/session/config/schedule logic in the backend.
- If we later build an OpenTUI or terminal dashboard, it should use the same backend commands/events rather than reimplementing agent behavior.

### Responsiveness

`tui_gateway/server.py` routes slow handlers through a thread pool so the dispatcher can remain responsive to control messages such as interrupts and approvals. It also has a persistent slash-command worker subprocess to avoid paying full CLI startup cost for every slash command.

The TUI has useful interaction patterns:

- Input while the agent is busy can queue, steer, or interrupt depending on mode.
- Slash commands and shell commands can still execute while the agent is busy.
- Config sync polls mtime periodically and applies display/MCP changes.
- Long-running tools get ambient activity indicators.
- Resume pickers, approval overlays, secret prompts, and clarify prompts are first-class UI states.

### Session Finalization

On session close/finalize, Hermes persists unflushed messages, invokes plugin hooks, commits memory, marks the session ended, and closes slash workers. This suggests Neondeck should treat session lifecycle as an explicit backend concern rather than letting chat panels be purely client state.

### Neondeck Implications

For Neondeck:

- Keep the React dashboard thin and reactive.
- Put session lifecycle, config mutation, repo checks, cron/watch execution, and Flue agent invocation behind local APIs.
- Consider a small typed RPC/event layer even if initial routes are REST/SSE.
- Design backend events so web, future TUI, and possible companion surfaces can share them.
- Add explicit backend support for interrupts, approvals, secret prompts, and config reloads early.

## Cron And Automation

Relevant files:

- `tools/cronjob_tools.py`
- `cron/jobs.py`
- `cron/scheduler.py`
- `cron/blueprint_catalog.py`
- `optional-skills/devops/watchers/SKILL.md`

### Raw Job System

Hermes stores cron jobs under profile-local state:

- Jobs: `~/.hermes/cron/jobs.json`
- Run output: `~/.hermes/cron/output/{job_id}/{timestamp}.md`

The job parser supports three schedule kinds:

- `once`: one-shot jobs, either absolute timestamp or relative delay such as `30m`.
- `interval`: recurring jobs such as `every 30m`.
- `cron`: cron expressions such as `0 9 * * *`.

`cron/jobs.py` handles schedule parsing, persistence, secure directory/file permissions, advisory file locking, due-job calculation, run output storage, and job state transitions.

### Scheduler

`cron/scheduler.py` runs due jobs on a 60-second tick. It uses a cross-process tick lock so multiple gateway/daemon/manual tick paths do not execute the same due batch at the same time.

Important behavior:

- Recurring jobs advance `next_run_at` before execution to preserve at-most-once behavior.
- In-flight guards avoid re-queueing a job that is already running from a previous tick.
- Jobs with a `workdir` are run through a persistent single-thread executor because they mutate process-global cwd/env state.
- Jobs without a `workdir` can run in a parallel executor.
- A `[SILENT]` response suppresses delivery but still allows output/state to be recorded.
- Cron-spawned agents have protected toolsets disabled, including `cronjob`, `messaging`, and `clarify`, to avoid self-scheduling loops and interactive dead ends.
- Scheduler output can be delivered to local output or platform adapters.

### Cron Tool

`tools/cronjob_tools.py` exposes cron management through one compressed action tool rather than many individual tools. It includes prompt scanning for two threat surfaces:

- User-supplied cron prompts at create/update/runtime.
- Assembled prompts that may include skill content, scanned more loosely to avoid false positives.

This is a useful pattern for Neondeck's config and watcher actions: expose a compact deterministic action API, but validate user-provided instructions before storing them.

### Automation Blueprints

`cron/blueprint_catalog.py` defines "Automation Blueprints": typed, parameterized templates that produce normal cron jobs.

Each blueprint includes:

- key/title/description/category
- schedule template
- prompt template
- typed slots such as `time`, `enum`, `text`, and `weekdays`
- default delivery target
- optional skills to preload
- tags

This is likely the "two cron types" distinction:

1. Raw jobs: the persisted scheduler objects with `once`, `interval`, or `cron` schedules.
2. Blueprints: friendly automation templates that fill slots and create normal jobs.

There is not a separate scheduler for blueprints. Blueprints are a UX and validation layer over the same job engine.

### Watchers Skill

The optional `devops/watchers` skill is a good model for release-watch style features. It ships scripts for RSS, GitHub, and JSON polling. Each watcher:

- fetches a source
- compares against a bounded watermark file
- writes updated state
- prints only new items
- emits empty stdout on no change

The skill's cron guidance explicitly relies on empty output meaning "stay silent". For Neondeck release watches, this is the right shape: deterministic poller plus agent summarizer only when state changes.

### Neondeck Implications

For Neondeck:

- Represent schedules as durable jobs plus typed blueprints/presets.
- Use blueprints for "morning briefing", "watch PR", "release watch", and "review queue digest".
- Persist run output and last-run status so the UI can show history and failures.
- Keep deterministic pollers separate from agent summarization.
- Support a quiet sentinel or empty-delta convention for no-op monitors.
- Disable self-scheduling/config-mutating actions in scheduled agents unless the job explicitly needs them.
- Treat workdir/repo jobs carefully because they may mutate process-level env, local git state, or filesystem state.

## Skills System

Relevant files:

- `tools/skills_tool.py`
- `agent/skill_utils.py`
- `agent/skill_commands.py`
- `agent/system_prompt.py`
- `hermes_constants.py`
- `skills/autonomous-ai-agents/hermes-agent/SKILL.md`

### Skill Layout

Hermes skills are directories containing a `SKILL.md` file plus optional supporting files:

- `references/`
- `templates/`
- `assets/`
- `scripts/`

`SKILL.md` uses YAML frontmatter for metadata such as name, description, version, license, platforms, prerequisites, required environment variables, and Hermes-specific tags/toolset requirements.

The installed local skills directory is:

- `get_hermes_home() / "skills"`

Hermes can also discover configured `skills.external_dirs` from `config.yaml`. External dirs are expanded, resolved, deduplicated, and only used if they exist.

### Progressive Disclosure

The model does not need every skill body in the system prompt. Hermes exposes:

- `skills_list`: minimal metadata for discovery.
- `skill_view`: full skill content or specific linked file.
- slash skill invocation: loads a selected skill into a user message.
- session preloading: loads selected skills for the whole session.

This keeps the prompt smaller and lets the agent load only what it needs.

### Reload

`agent/skill_commands.py` has `reload_skills()`, which rescans local and external skills and returns a diff. The comments call out an important design choice: this reload does not invalidate the skills system-prompt cache, because skills can be invoked by name through `skills_list`, `skill_view`, or slash commands.

For Neondeck, this supports the plan that users can drop additional skills into a local skills directory and reload/discover them without restarting the app or rebuilding active sessions.

### Safety And Compatibility

Hermes includes several useful guardrails:

- Skill names cannot escape trusted roots via absolute paths or `..`.
- Support directories are not scanned as standalone skill roots.
- Platform filters hide incompatible skills.
- Environment filters hide irrelevant skills from offer surfaces but explicit loads can still work.
- Disabled skills are respected globally and per platform.
- Name collisions across local and external dirs are detected and surfaced instead of silently shadowing.
- Prompt-injection-like patterns are logged as warnings when loading skill content.
- Skills can declare missing secrets/env vars and trigger secure secret capture in interactive surfaces.

### Neondeck Implications

For Neondeck:

- Use `~/.config/neondeck/skills` as the user skill directory.
- Support extra skill directories in config.
- Keep skill discovery metadata-only by default.
- Provide a reload action for user-dropped skills.
- Detect duplicate skill IDs across built-in/user/external roots.
- Model skills as read-mostly documents with optional scripts/assets.
- Let the Flue agent load Neondeck's own config-management skill and user skills through explicit actions.

## Other Interesting Features

### SOUL.md Identity

Hermes loads `SOUL.md` as the primary identity/persona source when available, falling back to a default identity. This happens in the stable prompt tier. Neondeck's `SOUL.md` should follow the same approach: load it once at session start, include name/emoji/vibe in the system prompt, and keep it session-stable.

### Profiles

Hermes supports independent profiles, each with its own skills, plugins, cron, and memories. The system prompt includes an active-profile warning to prevent agents from modifying the wrong profile's data.

Neondeck may not need multi-profile support immediately, but we should still make config root resolution explicit and display it in diagnostics. If we later support profiles, repo paths, skills, db, schedules, and secrets should be profile-scoped.

### Config Hot Reload

The TUI has config sync that polls config mtime and applies changes. The gateway also exposes config and reload methods. Neondeck can start with mtime-based reload for local JSON/TOML/YAML config and later add a filesystem watcher.

### Project/Repo Discovery

The gateway exposes project discovery and recording methods. This aligns with Neondeck's planned repo registry:

- discover repos under configured roots
- record repo locations
- present repo state in UI
- let agents operate on known repos by logical ID rather than arbitrary paths

### Approvals, Clarify, And Secret Prompts

Hermes treats approvals, clarify prompts, sudo prompts, and secret capture as structured backend/UI flows. Neondeck should do the same for:

- adding/removing repos
- editing config
- storing GitHub tokens or provider keys
- running mutating git commands
- scheduling watches
- deleting job history or memory

### Curator

Hermes has a skill curator that tracks agent-created skills, archives stale ones, and consolidates overly narrow skills into broader umbrella skills. This is not v1 material for Neondeck, but it is a strong longer-term idea if we allow the agent to create/update skills over time.

## Recommended Neondeck Design Moves

1. Implement a real Neondeck app home first:
   - `~/.config/neondeck/config.json`
   - `~/.config/neondeck/SOUL.md`
   - `~/.config/neondeck/skills/`
   - `~/.config/neondeck/neondeck.db`
   - `~/.config/neondeck/jobs/` or database-backed jobs

2. Add typed backend actions for self-configuration:
   - add/update/remove repo
   - add/update/remove skill dir
   - reload skills
   - validate config
   - create/update/remove schedules and watches

3. Use progressive disclosure for skills:
   - built-in Neondeck skills
   - user skills from app home
   - configured external skill dirs
   - metadata list first, full file only on demand

4. Freeze session context:
   - `SOUL.md`
   - selected skills
   - memory summary
   - repo registry snapshot
   - dashboard/session config snapshot

5. Build schedules as jobs plus blueprints:
   - morning briefing blueprint
   - watch PR blueprint
   - release watch blueprint
   - review queue digest blueprint

6. Keep deterministic watchers separate from agent reasoning:
   - poll GitHub/API/local git state deterministically
   - store watermarks
   - invoke the agent only on meaningful deltas

7. Keep one backend event/RPC surface:
   - local web dashboard first
   - future TUI/OpenTUI can reuse it
   - explicit support for stream events, interrupts, approvals, secrets, and config reload

## Open Questions For Neondeck

- Should Flue session persistence and Neondeck app persistence share one SQLite database, or should Flue runtime state remain isolated from app config/job state?
- Should active sessions see config changes immediately, or should config changes take effect only on new sessions unless the user explicitly reloads context?
- How much permission gating do we want around self-configuration actions in local-only mode?
- Should user skills be markdown-only at first, or can they ship scripts from day one?
- Do we need profiles now, or just a clean app-home abstraction that can support profiles later?
