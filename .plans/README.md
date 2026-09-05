# Planning Index

`ROADMAP.md` is the source of truth for product status and sequencing. Keep only active, proposed, or intentionally deferred plans at this level. Durable research lives under `research/`. Move completed implementation plans and point-in-time review artifacts to `archived/` rather than deleting their decision history.

## Current Direction

- `ROADMAP.md` — completed phases, remaining roadmap items, and product decisions.
- `DEVIATIONS.md` — durable record of intentional departures from roadmap implementation details.

## Active Or Deferred Work

- `factory/` — next implementation priority: software factory slice 1, from manual/GitHub
  intake through model-assisted shaping to human release; five stacked implementation
  PRs with a manager/reviewer handoff. Planned, not implemented.
- `OPEN_GATEWAY_MODEL_DISCOVERY_PLAN.md` — implemented in the current worktree: first-class
  OpenRouter and OpenCode Zen providers, live searchable onboarding, native Pi protocol
  preservation, and a centralized but disabled-until-approved provider-role default mechanism.
  Retain here until the change
  lands, then archive it under the policy below.
- `DIFF_IMPROVEMENTS_PLAN.md` — phases C–E remain planned after the completed Phase B milestone.
- `PR_REVIEW_PERF_PLAN.md` — completed remediation record with explicit unresolved cold-path performance deferrals.
- `PR_REVIEW_SUBAGENT_IMPROVEMENT_PLAN.md` — proposed Explore trust policy, result contract, critical-path observability, and live-model review eval work.
- `PR_REVIEW_GUIDED_TOURS_PLAN.md` — proposed reviewer-scoped `/show-me` slash command and revision-bound, line-anchored guided tours, with one atomically replaced current tour per conversation and revision. Design settled; see the handoff and mockups below.
- `PR_REVIEW_GUIDED_TOURS_HANDOFF.md` — implementation handoff for the above: codebase map, resolved tokens and CSS, traps, and a build order that differs from the plan's phase numbering.
- `guided-tours/mockups/` — six interactive Design Component boards and the canvas manifest behind the tours design.
- `new-review/` — proposed replacement of the two-report PR review artifacts with a single briefing, plus the agent recommendation on the Reviews panel row. Includes interactive mockups.
- `EXEDEV_WORKSPACE_MODE_PLAN.md` — proposed exe.dev workspace-location mode.
- `FLUE_2_USAGE_FOLLOWUP_BRIEFING.md` — non-blocking idiomatic cleanup and capability-surface reductions after the completed migration.

## Durable Research

Durable research notes live under `research/`:

- `research/HERMES_RESEARCH.md` — product and agent-system research notes.
- `research/KILOCODE_HANDOFF_RESEARCH.md` — Kilo integration research supporting the remaining Phase 21 work.
- `research/SOFTWARE_FACTORIES_X_THREADS_SUMMARY.md` — X-thread briefing on the 2026 software-factories debate (claims and tensions only; not an implementation plan).
- `research/software-factory-proposal.html` — overall Neon factory proposal, human
  touchpoints, GitHub writeback, shaping workbench, coding-agent isolation and rollout.

## Archive Policy

`archived/` contains completed, superseded, or point-in-time material. Archived documents remain useful as implementation rationale and review evidence, but they are not the current work queue unless `ROADMAP.md` explicitly reactivates them.
