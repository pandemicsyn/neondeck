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
- Decision: Landed runtime-home resolution, initial config/data/skill layout, config-file validation, and separate app/Flue SQLite files, but deferred typed config mutation actions, hot reload after config mutation, and a fuller runtime config/status API.
- Reason: Typed config actions and hot reload are Phase 2 self-configuration work, and the current Phase 1 slice only needs enough API surface for dashboard config reads and runtime bootstrap.
- Follow-up: Implement Phase 2 config actions for read, validate, add/update/remove repo and schedule, reload, and expose a richer runtime status/config API once those actions exist.
