# Software factory implementation

Status: implementation authorized; preparing delegation and review gates.

The next implementation priority is **slice 1: intake to a human-released queue**.
Neon helps a human shape a task into a versioned brief. Coding remains delegated to
Codex or OpenCode in subsequent slices; this work does not build a coding agent.

- [Slice 1 implementation plan](SLICE_1_IMPLEMENTATION_PLAN.md): scope, contracts,
  five stacked PRs, acceptance criteria, and operational readiness.
- [Implementation handoff](SLICE_1_HANDOFF.md): manager/reviewer responsibilities,
  implementer assignment template, stack maintenance, and progress ledger.
- [Overall proposal](../research/software-factory-proposal.html): architecture,
  human touchpoints, GitHub writeback, shaping surfaces, agent isolation and cleanup,
  and subsequent slices.
- [Roadmap](../ROADMAP.md): product priorities and completion status.
- [Deviations](../DEVIATIONS.md): record actual implementation departures here.

Deployment addresses, credentials, SSH configuration, and live environment evidence
belong in private operator configuration, never in this directory or public PRs.
The existing secrets-scanning pre-commit hook must run on every commit.

No PR is created until dedicated static reviewers return no findings and the
manager completes the final implementation/product-plan review. Implementers
provide screenshots for UI changes for review and eventual GitHub publication.
