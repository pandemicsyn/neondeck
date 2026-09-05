# Planning Index

`ROADMAP.md` is the source of truth for product status and sequencing. Keep only active, proposed, intentionally deferred, or durable research documents at this level. Move completed implementation plans and point-in-time review artifacts to `archived/` rather than deleting their decision history.

## Current Direction

- `ROADMAP.md` — completed phases, remaining roadmap items, and product decisions.
- `DEVIATIONS.md` — durable record of intentional departures from roadmap implementation details.

## Active Or Deferred Work

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
- `GITHUB_WEBHOOK_RELAY_PLAN.md` — proposed GitHub webhook relay worker integration, blocked on a rebase prerequisite.

## Durable Research

- `HERMES_RESEARCH.md` — product and agent-system inspiration.
- `KILOCODE_HANDOFF_RESEARCH.md` — Kilo integration research supporting the remaining Phase 21 work.

## Archive Policy

`archived/` contains completed, superseded, or point-in-time material. Archived documents remain useful as implementation rationale and review evidence, but they are not the current work queue unless `ROADMAP.md` explicitly reactivates them.
