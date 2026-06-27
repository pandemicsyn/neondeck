---
name: roadmap-implementation
description: Use when implementing a specific item from .plans/ROADMAP.md, a named roadmap phase, or a user-selected roadmap task in this repository. Guides Codex to scope the item, implement it end to end, verify it, and maintain .plans/DEVIATIONS.md for all plan deviations and deferrals.
---

# Roadmap Implementation

Use this skill to implement one concrete item from `.plans/ROADMAP.md`.

## Workflow

1. Identify the roadmap item.
   - Read `.plans/ROADMAP.md`.
   - If the user named a phase, item, or capability, implement that specific item.
   - If the request is ambiguous, choose the smallest high-value item that unblocks later roadmap work and state the choice before editing.

2. Check current project guidance.
   - Read `AGENTS.md` if present.
   - Read nearby source files before changing implementation.
   - Prefer existing project patterns over new abstractions.

3. Scope the implementation.
   - Keep changes limited to the selected roadmap item.
   - Include the minimal supporting plumbing needed to make the item usable.
   - Do not silently implement adjacent roadmap items unless required by the selected item.

4. Implement end to end.
   - Update source, config, docs, tests, and UI states as needed.
   - For agent-facing behavior, prefer typed actions/workflows over prompt-only behavior.
   - For runtime state, keep Neondeck app state distinct from Flue runtime state unless the roadmap explicitly changes.

5. Maintain the deviations log.
   - Update `.plans/DEVIATIONS.md` with every meaningful deviation from the roadmap.
   - Log deferrals, narrowed scope, broadened scope, changed ordering, technical substitutions, and unresolved follow-ups.
   - Include the roadmap item, date, decision, reason, and follow-up.
   - This is important: `.plans/DEVIATIONS.md` is used to track progress and during reviews. Do not skip it when implementation differs from the roadmap, even if the deviation seems small.

6. Verify.
   - Run `npm run check` for the fast verification loop.
   - Run narrower commands first if they help diagnose failures.
   - Run `npm run verify` when the change touches build output, integration wiring, or multiple surfaces.
   - If a verification step cannot run, record why in the final response and, when relevant, in `.plans/DEVIATIONS.md`.

7. Report clearly.
   - Summarize what roadmap item was implemented.
   - Mention files changed and verification performed.
   - Call out deviations, deferrals, and any follow-up work.

## Deviations Log Format

When adding to `.plans/DEVIATIONS.md`, prefer this shape:

```markdown
## YYYY-MM-DD - Roadmap Item Name

- Roadmap item: Phase N / item name
- Decision: What changed from the roadmap.
- Reason: Why the change was necessary or preferable.
- Follow-up: What remains, who/what should handle it, or `None`.
```

If there is no deviation, do not add noise to the log.
