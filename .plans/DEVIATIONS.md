# Deviations Log

Track meaningful implementation deviations and deferrals from `.plans/ROADMAP.md`.

This file is important for progress tracking and reviews. Update it whenever an implementation changes scope, ordering, technical approach, or defers planned work.

Use this format:

```markdown
## YYYY-MM-DD - Roadmap Item Name

- Roadmap item: Phase N / item name
- Decision: What changed from the roadmap.
- Reason: Why the change was necessary or preferable.
- Follow-up: What remains, who/what should handle it, or `None`.
```

## 2026-06-27 - Neondeck Home And Runtime State

- Roadmap item: Phase 1 / Neondeck home and runtime state
- Decision: Landed runtime-home resolution, initial config/data/skill layout, config-file validation, and separate app/Flue SQLite files, but deferred typed config mutation actions and a fuller runtime config/status API.
- Reason: Typed config actions are Phase 2 self-configuration work, and the Phase 1 slice only needed enough API surface for dashboard config reads and runtime bootstrap.
- Follow-up: Phase 2 added the initial config actions. A richer runtime status/config API remains for a later dashboard/API pass.

## 2026-06-27 - Flue Actions For Self-Configuration

- Roadmap item: Phase 2 / Flue actions for self-configuration
- Decision: Landed deterministic Valibot-backed Flue actions for config read, validate, reload, repo add/update/remove, and schedule add/update/remove. The reload action validates and returns the active disk-backed config snapshot rather than restarting the process or pushing live UI notifications.
- Reason: Current runtime config reads are disk-backed, so no in-process cache needs invalidation yet. Restart semantics and live notification fanout should wait until the dashboard has a richer runtime state/event API.
- Follow-up: Add explicit runtime status/config HTTP endpoints and event fanout when dashboard panels move to runtime state in Phase 6.

## 2026-06-27 - Repo Registry And GitHub Foundation

- Roadmap item: Phase 3 / Repo registry and GitHub foundation
- Decision: Landed a validated repo registry snapshot API and made the GitHub PR queue include configured repositories from `repos.json`. Deferred CI/check status enrichment, GitHub workflow actions, and full work-queue triage.
- Reason: The first Phase 3 slice establishes the shared registry-backed data source for dashboard panels, future workflows, and watchers without pulling in the broader triage/checks surface.
- Follow-up: Add structured GitHub actions for PR/check details, enrich PR results with CI status, and build the work-queue triage workflow.

## 2026-06-27 - Schedules, Watches, And Blueprint-Style Automations

- Roadmap item: Phase 4 / schedules, watches, and blueprint-style automations
- Decision: Landed durable app tables for watches, jobs, notifications, memories, and workflow summaries; deterministic `neondeck_watch_pr_*` actions; GitHub check-run status enrichment for merged PR watches; blueprint-backed schedule creation; a local scheduler loop; active watch/job/notification APIs; and quiet `silent` refresh results for unchanged watches. The later Flue alignment pass changed morning briefing and review queue digest scheduler jobs from app-only summary placeholders into admissions of real Flue workflows with run ids recorded in job results and notifications. Production/deploy status watching remains a provider-specific follow-up.
- Reason: Phase 4 needs the local scheduler and deterministic watch substrate first. Deploy status adapters depend on configured deployment providers. The Flue alignment pass kept scheduling deterministic while using Flue workflow runs for bounded scheduled work.
- Follow-up: Add deploy-provider status adapters when repo deploy targets are formalized, and build richer dashboard inspection over scheduled Flue run history.

## 2026-06-27 - Runtime Skills

- Roadmap item: Phase 5 / runtime skills
- Decision: Landed Neondeck-managed runtime skill discovery from `skills/` and configured `skillRoots`, folder validation with ignored-entry reporting, metadata and full-load APIs, Flue actions/tools for list/load/reload, duplicate-id detection, and automatic registration of active runtime skills as Flue `defineSkill` references when the display assistant initializes. The built-in Neondeck guidance moved out of mutable runtime home seeding and into an application-owned Flue skill at `src/skills/neondeck/SKILL.md`. Runtime skill resources are bounded to trusted, non-sensitive, non-symlink files with size and binary handling limits. The reload action rescans disk for APIs/actions, but active Flue sessions keep their existing skill context.
- Reason: Flue skills are the idiomatic mechanic for procedural guidance. Mutable `NEONDECK_HOME` skills still need app-owned discovery and validation, but they should enter the agent as Flue skills rather than prompt-injected text. Existing session context should stay stable rather than being rewritten under an active conversation.
- Follow-up: Add session-level skill context refresh if Flue exposes a safe active-session update hook or when Neon command/session management lands.

## 2026-06-27 - Neon Commands And Workflows

- Roadmap item: Phase 6 / Neon commands and workflows
- Decision: Landed slash command parsing, deterministic command workflow execution for `/repo-status`, `/review-queue`, `/briefing`, and `/watch-pr`, persisted `workflow_summaries`, Flue command actions, dashboard command buttons in the chat panel, and Flue `defineWorkflow` wrappers for command-run, briefing, watch-pr, watch-release, dev-doctor, and scheduler-tick. The later Flue alignment pass removed the legacy app-only `/api/commands/run` path, moved dashboard command buttons to the Flue workflow endpoint, exported run inspection middleware for user-facing workflows, attached Flue run ids to workflow summaries through `observe()`, and guarded local Flue routes by loopback host plus browser origin checks.
- Reason: The roadmap calls for one backend command/event surface shared by chat and UI buttons. Routing UI-triggered commands through Flue workflows gives bounded operations Flue run identity/history without splitting command semantics.
- Follow-up: Build richer dashboard workflow observation with `@flue/react`/SDK when the workflow dashboard matures, and promote commands that need long-running agent reasoning into richer first-class Flue workflows.

## 2026-06-27 - Release Watch

- Roadmap item: Phase 10 / release watch
- Decision: Landed `/watch-release`, release-watch scheduler execution, and `until prod` PR watch linkage. Direct release watches poll configured default-branch GitHub checks, while linked `until prod` PR release watches poll the source PR merge SHA. Provider-specific production/deploy adapters remain deferred.
- Reason: The roadmap explicitly marks provider-specific deploy adapters as later work. GitHub checks give a deterministic release watch now while keeping deployment-provider integration separate.
- Follow-up: Add provider adapters for configured `productionTarget` values when deploy providers are selected.

## 2026-06-27 - Flue Idiomatic Runtime Alignment

- Roadmap item: Phase 5 / runtime skills, Phase 6 / Neon commands and workflows, Phase 8 / subagents, and cross-cutting Flue architecture cleanup
- Decision: Reworked the display assistant toward Flue-native primitives: built-in Neondeck guidance is now an app-owned Flue skill, runtime skills are registered as Flue `defineSkill` references with bounded trusted-resource loading, simple deterministic fact reads are exposed as `defineTool` lookup tools, longer command/dev-doctor/scheduler work emits structured `emitData` progress and `log` events, command buttons call Flue workflows directly, scheduler jobs admit real Flue workflows where available, workflow summaries retain Flue run ids, and app-level `observe()` now records failed Flue work as Neondeck notifications. Added named Flue subagent profiles for repo research, CI investigation, and release review, with display-assistant and subagent model selection configurable from runtime-home `config.json` and mutable through the typed `neondeck_config_update_agent_models` action. Also made the agent sandbox policy explicit by keeping the default virtual sandbox rooted at `/workspace` and routing host state through bounded tools/actions. This entry also records the initial remediation fixes from the Flue review: removing prompt-injected runtime skill instructions, removing the legacy command-run API path, exposing workflow run inspection, hardening local Flue route access, and filtering runtime skill resources.
- Reason: The previous runtime skill and command paths mixed prompt injection, app-only command APIs, and deterministic facts as model actions. Flue provides first-class skills, tools, workflows, subagents, action telemetry, and observation hooks, so aligning with those primitives makes Neondeck a better Flue example and keeps host access bounded.
- Follow-up: Build richer dashboard views over Flue run/event streams, add runtime provider registration only after credentials and allowed endpoint validation are designed, and revisit active-session skill refresh only if Flue exposes a safe session update mechanism.
