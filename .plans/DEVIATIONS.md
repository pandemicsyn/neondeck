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
- Decision: Landed durable app tables for watches, jobs, notifications, memories, and workflow summaries; deterministic `neondeck_watch_pr_*` actions; GitHub check-run status enrichment for merged PR watches; blueprint-backed schedule creation; a local scheduler loop; active watch/job/notification APIs; and quiet `silent` refresh results for unchanged watches. Production/deploy status watching remains a provider-specific follow-up, and morning briefing jobs currently record durable scheduler/workflow state rather than running the full briefing workflow.
- Reason: Phase 4 needs the local scheduler and deterministic watch substrate first. Deploy status adapters depend on configured deployment providers, and the full briefing workflow belongs with the workflow/dashboard phases that consume this scheduler state.
- Follow-up: Add deploy-provider status adapters when repo deploy targets are formalized, and wire morning briefing jobs to a full Flue workflow during the briefing/workflow dashboard phase.

## 2026-06-27 - Runtime Skills

- Roadmap item: Phase 5 / runtime skills
- Decision: Landed Neondeck-managed runtime skill discovery from `skills/` and configured `skillRoots`, folder validation with ignored-entry reporting, metadata and full-load APIs, Flue actions for list/load/reload, duplicate-id detection, and automatic instruction injection for active skills when the display assistant initializes. The reload action rescans disk for APIs/actions, but already-initialized Flue sessions keep their existing automatic instruction context.
- Reason: Current Flue packaged skills must be imported at build time or discovered from a harness workspace; mutable `NEONDECK_HOME` skills need a runtime-managed loader. Existing session context should stay stable rather than being rewritten under an active conversation.
- Follow-up: Add session-level skill context refresh if Flue exposes a safe active-session update hook or when Neon command/session management lands.

## 2026-06-27 - Neon Commands And Workflows

- Roadmap item: Phase 6 / Neon commands and workflows
- Decision: Landed slash command parsing, deterministic command workflow execution for `/repo-status`, `/review-queue`, `/briefing`, and `/watch-pr`, persisted `workflow_summaries`, Flue command actions, HTTP command APIs, and dashboard command buttons in the chat panel. These command workflows are Neondeck backend workflows rather than separate Flue `defineWorkflow` files.
- Reason: The roadmap calls for one backend command/event surface shared by chat and UI buttons. Deterministic command workflows are the lowest-friction way to make commands usable now while storing durable results for later UI panels.
- Follow-up: Promote commands that need long-running agent reasoning into first-class Flue workflows when the workflow dashboard and command orchestration mature.

## 2026-06-27 - Release Watch

- Roadmap item: Phase 10 / release watch
- Decision: Landed `/watch-release`, release-watch scheduler execution, and `until prod` PR watch linkage as default-branch GitHub check polling. Provider-specific production/deploy adapters remain deferred.
- Reason: The roadmap explicitly marks provider-specific deploy adapters as later work. Default-branch green checks give a deterministic release watch now while keeping deployment-provider integration separate.
- Follow-up: Add provider adapters for configured `productionTarget` values when deploy providers are selected.
