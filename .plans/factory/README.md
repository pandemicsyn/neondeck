# Software factory implementation

## Current acceptance decision (2026-09-06)

Slice 1 is **merged**, through `13049498d457257626af80483d68e0aa8110ad68`
(PRs #382–#387 and #389). Final local verification passed 1,968 tests and 63 CI
checks, with two independent clean static reviews and manager acceptance.
**The operator accepted Slice 1 with the remaining live checks deferred and authorized the Slice 2 stack to merge.** This decision follows the partial live rehearsal recorded in PR #396; it does not turn unperformed tests into passes. See the [acceptance decision](SLICE_2_IMPLEMENTATION_PLAN.md#slice-1-acceptance-decision) and [Slice 1 live record](SLICE_1_HANDOFF.md#september-6-2026--merged-build-and-partial-live-acceptance). Slice 2 real Codex acceptance remains pending after merge.
The historical candidates and pre-merge ledger below remain an audit record;
their “not merged” statements describe those earlier checkpoints.

The merged scope is **slice 1: intake to a human-released queue**.
Slice 2 adds an opt-in Codex CLI handoff from that exact release to a retained
candidate for human review. Its implementation is reviewed and verified locally;
merge remains blocked by live slice 1 acceptance. This work does not build a coding agent.

- [Slice 2 implementation and acceptance plan](SLICE_2_IMPLEMENTATION_PLAN.md):
  brief-to-candidate scope, stacked delivery, mockdex and acceptance.
- [Slice 2 local handoff](SLICE_2_HANDOFF.md): accepted stack, verification,
  screenshots and remaining live acceptance.
- [Slice 2 operator guide](SLICE_2_OPERATOR.md): private coding setup, run controls,
  context policy, retained worktree review and recovery limits.
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
