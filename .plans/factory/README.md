# Software factory implementation

## Current landing status and slice 2 merge gate (2026-09-06)

Slice 1 is **merged**, through `13049498d457257626af80483d68e0aa8110ad68`
(PRs #382–#387 and #389). Final local verification passed 1,968 tests and 63 CI
checks, with two independent clean static reviews and manager acceptance.
**Deployment/live acceptance is still pending. No slice 2 PR may merge until the
morning operator exercise is completed and accepted.** See the
[slice 2 gate checklist](SLICE_2_IMPLEMENTATION_PLAN.md#mandatory-merge-gate-live-slice-1-acceptance).
The historical candidates and pre-merge ledger below remain an audit record;
their “not merged” statements describe those earlier checkpoints.

The implemented local scope is **slice 1: intake to a human-released queue**.
Neon helps a human shape a task into a versioned brief. Coding remains delegated to
Codex or OpenCode in subsequent slices; this work does not build a coding agent.

- [Slice 2 implementation plan and merge gate](SLICE_2_IMPLEMENTATION_PLAN.md):
  brief-to-candidate scope, stacked delivery, mockdex and acceptance.
- [Slice 1 implementation plan](SLICE_1_IMPLEMENTATION_PLAN.md): scope, contracts,
  five stacked PRs, acceptance criteria, and operational readiness.
- [Implementation handoff](SLICE_1_HANDOFF.md): manager/reviewer responsibilities,
  implementer assignment template, stack maintenance, and progress ledger.
- [Boundary and ownership hardening](SLICE_1_HARDENING.md): audit follow-up,
  draft recovery, typed persistence, module boundaries, and GitHub caching.
- [GitHub publishing operations](INCREMENT_5_OPERATOR.md): consent, exact approvals,
  uncertain effects, remote repair and remaining live acceptance.
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
