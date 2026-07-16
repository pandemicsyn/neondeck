# Product

## Register

product

## Scope

This document defines the local Neondeck application, agent runtime, and
operator experience. The public marketing and documentation site has its own
brand specification in `docs/PRODUCT.md`. Implementation status and sequencing
belong in `.plans/ROADMAP.md`.

## Users

The primary user is a developer with several pieces of engineering work in
flight: pull requests, review requests, CI failures, agent tasks, watches, and
release checks. They want that work to remain visible and continue moving
without repeatedly reconstructing context across an editor, terminal, GitHub,
and transient chat tabs.

Neondeck may run on a companion display, a vertical sidebar, an ultrawide strip,
or the primary monitor. The Corsair Xeneon Edge is the reference deck, not a
hardware requirement.

The user is comfortable with local developer tooling and automation, but expects
to understand what the agent knows, why it acted, what changed, and which
authority allowed it.

## Job to Be Done

When several PRs, checks, reviews, and agent tasks are in flight, show me what
needs attention, explain why, prepare the safest useful next action, and keep
following the work without making me babysit another browser tab.

## Product Purpose

Neondeck is a local-first operating console for active software delivery.

Its agent, Neon, combines an always-visible dashboard with durable conversations,
deterministic repository and GitHub facts, scheduled work, bounded workflows,
and policy-controlled code changes. It should help a developer move from
“what needs attention?” to a reviewed, verified outcome while keeping the
operator in control.

The dashboard is one surface over the runtime, not the runtime itself. Chat,
dashboard controls, CLI commands, scheduled tasks, and future clients should use
the same backend state, actions, workflows, and event stream.

## Core Product Loop

1. **Observe:** collect repository state, PR queues, review requests, checks,
   watches, notifications, schedules, and runtime health from deterministic
   sources.
2. **Prioritize:** turn those facts into a concise attention queue, briefing,
   or context-aware conversation.
3. **Act:** update configuration, inspect repositories, prepare changes in
   managed worktrees, run approved checks, or delegate explicit tasks.
4. **Review:** expose diffs, findings, workflow evidence, approvals, and PR
   review controls before consequential effects.
5. **Learn:** turn high-signal conversation and PR outcomes into audited memory
   or skill proposals for future sessions.

## Current Product Shape

- A repo-aware GitHub work queue covering authored, assigned, requested-review,
  failing, stale, and watched pull requests.
- Durable PR and release-check watches that stay quiet when nothing meaningful
  changes.
- Conversational briefings grounded in inspectable local snapshots, with
  scheduled and on-demand execution.
- A durable PR review inbox and workbench with Neon-prepared findings, inline
  draft comments, thread replies and resolution, and explicit human submission
  of Comment, Approve, or Request changes verdicts.
- Worktree-backed autopilot that can notify, prepare a diff, request approval,
  or push when repository policy and verification allow it.
- Durable, context-linked Neon sessions with switching, summaries, references,
  stale-context signals, and workflow activity.
- Local reports and operator panels for prepared work, runtime readiness,
  workflows, notifications, memory, learning, and delegated tasks.
- Typed self-configuration for repositories, models, providers, schedules,
  skills, execution policy, and dashboard layout.
- Extensibility through runtime skills and policy-controlled MCP servers.
- Audited memory and learning over user preferences, local facts, project
  conventions, and procedural skill improvements.

## Operating and Trust Model

- Prefer deterministic APIs and local state for facts. Use model reasoning for
  synthesis, prioritization, review, and bounded planning.
- Use continuing Flue agents for conversations and finite Flue workflows for
  inspectable jobs with run identity and history.
- Route mutations through typed actions with validation and durable audit state.
- Keep interactive user-directed authority separate from unattended autopilot
  policy. An autonomous run must not infer broader authority from what an
  interactive user could do.
- Use managed Git worktrees as the normal isolation boundary for autonomous or
  delegated code changes. Do not mutate the user’s primary checkout.
- Keep shell execution mediated by an allow/ask/deny policy. Approval decisions
  belong to the user or operator surface, never to the model.
- Treat local-first as a data and control-plane choice, not a claim that every
  dependency is offline. Model providers, GitHub, MCP servers, Kilo, and optional
  exe.dev execution may be remote and must remain explicit.
- Preserve session stability. Changes to SOUL, skills, models, providers,
  repository config, or memory should mark existing context stale rather than
  silently rewriting a live conversation.

## Experience Principles

- **Glance first, drill down second.** Stable panels and compact status should
  answer what changed and what needs attention. Full review and diff surfaces
  may expand when the task requires deeper focus.
- **Show evidence with conclusions.** Agent summaries should link back to
  fetched facts, prepared diffs, reports, approvals, workflow runs, or audit
  state.
- **Make autonomy legible.** Always show whether Neon observed, prepared,
  verified, waited for approval, pushed, or declined to act—and why.
- **Keep work durable.** Sessions, watches, schedules, reviews, prepared diffs,
  notifications, and learning decisions should survive restarts.
- **Prefer actions over file editing.** Neon should configure Neondeck through
  typed operations rather than freestyle-editing runtime files.
- **Use one runtime across surfaces.** The web dashboard, CLI, and future TUI
  should share backend behavior instead of creating parallel agent systems.
- **Keep extensions bounded.** Plugins, skills, MCP tools, providers, and
  delegated agents should have clear contracts, visible readiness, and safe
  failure states.

## Brand Personality

Calm, observant, technical, and quietly capable. Neondeck should feel like a
trusted operations cockpit: dense without being frantic, opinionated without
being opaque, and confident without pretending uncertainty or risk does not
exist.

The local product UI should remain quieter than the neondeck.dev marketing
surface. Miami neon is an identity accent, not visual noise.

## Anti-references and Non-goals

Avoid:

- generic chat applications where useful state exists only in the transcript
- opaque autonomous bots that act without evidence, policy, or audit history
- fixed-hardware sensor panels dominated by decorative metrics
- generic SaaS admin dashboards with oversized cards and low information density
- raw terminal dumps when structured state would be easier to scan
- rebuilding GitHub, an editor, or a general-purpose coding harness inside the
  dashboard
- a second agent runtime for each new interface
- presenting planned integrations as already complete

## Current Boundaries

- Release watching currently uses GitHub checks as its primary signal;
  provider-specific deployment adapters are not yet part of the product.
- Kilo is an explicit delegated-worker integration with durable task state, not
  a default or general-purpose external-agent router.
- Existing-VM exe.dev command execution is supported, but relocating the entire
  workspace and Flue sandbox to exe.dev is still planned.
- The OpenTUI client is planned; the shared backend APIs and event model are the
  implemented foundation.
- Dashboard configuration uses validated JSON, presets, and typed actions rather
  than a freeform visual builder.
- Neondeck is a trusted local application and should not be exposed directly to
  an untrusted network without an explicit authentication layer.

## Accessibility and Inclusion

Target WCAG AA contrast for text and controls in light and dark themes. Support
keyboard navigation, visible focus states, reduced motion, scalable text,
non-color status cues, and clear loading, empty, partial, stale, approval,
blocked, and failure states.

Compact companion-display layouts must remain usable without making the wider
review and operator surfaces inaccessible.
