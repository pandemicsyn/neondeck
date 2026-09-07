# Software factory implementation

## Current acceptance decision (2026-09-06)

Slice 1 is **merged**, through `13049498d457257626af80483d68e0aa8110ad68`
(PRs #382–#387 and #389). Final local verification passed 1,968 tests and 63 CI
checks, with two independent clean static reviews and manager acceptance.
**The operator accepted Slice 1 with the remaining live checks deferred and authorized the Slice 2 stack to merge.** This decision follows the partial live rehearsal recorded in PR #396; it does not turn unperformed tests into passes. See the [acceptance decision](SLICE_2_IMPLEMENTATION_PLAN.md#slice-1-acceptance-decision) and [Slice 1 live record](SLICE_1_HANDOFF.md#september-6-2026--merged-build-and-partial-live-acceptance). Slice 2 real Codex acceptance remains pending after merge.
The historical candidates and pre-merge ledger below remain an audit record;
their “not merged” statements describe those earlier checkpoints.

The merged scope includes **slice 1: intake to a human-released queue**, followed by Slice 2 brief-to-candidate execution.
Slice 2 adds an opt-in Codex CLI handoff from that exact release to a retained
candidate for human review. Its implementation is reviewed and verified locally;
the operator authorized stack merge, with real Codex acceptance still pending after merge. This work does not build a coding agent.

- [Slice 2 implementation and acceptance plan](SLICE_2_IMPLEMENTATION_PLAN.md):
  brief-to-candidate scope, stacked delivery, mockdex and acceptance.
- [Slice 3 implementation plan](SLICE_3_IMPLEMENTATION_PLAN.md): exact delivery
  grants, independent evidence, bounded repairs and draft publication.
- [Slice 3 handoff](SLICE_3_HANDOFF.md): stack ownership, review and acceptance.
- [Slice 3.1 progress supervision](SLICE_3_1_PROGRESS_REVIEW_PLAN.md): merged through
  `00c3e3e5`, with 2,544 unique passing tests across the
  full run and corrected targeted rerun. PRs
  [#403](https://github.com/pandemicsyn/neondeck/pull/403) and
  [#404](https://github.com/pandemicsyn/neondeck/pull/404), official stack #405,
  merged after operator authorization, clean independent and manager reviews,
  and all nine CI checks passing on each final head.
  Real model/Codex/GitHub acceptance is NOT RUN. See its
  [handoff](SLICE_3_1_HANDOFF.md), [operator guide](SLICE_3_1_OPERATOR.md) and
  [acceptance ledger](SLICE_3_1_ACCEPTANCE.md).
- [Slice 4 implementation plan](SLICE_4_IMPLEMENTATION_PLAN.md): planned pluggable
  coding CLI contract, OpenCode and Kilo Code adapters alongside Codex, shared
  isolation/lifecycle and acceptance coverage. Existing Kilo handoff is reuse
  material, not a second factory coordinator. CLI installation alone is not
  factory readiness or live acceptance.
- [Slice 3 operator guide](SLICE_3_OPERATOR.md): candidate delivery controls and
  conditional human interventions.
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

Slice 3 postmerge live obligations are recorded in [SLICE_3_ACCEPTANCE.md](SLICE_3_ACCEPTANCE.md); no live acceptance is claimed by synthetic verification.

Slice 3 merged in PRs #397–#401 through `a897aa06`. Two independent static reviews were clean before publication; the manager’s post-publication architecture review is also clean. See the [Slice 3 handoff](SLICE_3_HANDOFF.md) for PR links, 2,439 passing tests, screenshots and remaining acceptance. All 45 CI checks passed and no review feedback was present at merge. Live acceptance remains pending.

## Current operator follow-up

[Onboarding and observability](OPERATIONS_IMPLEMENTATION_PLAN.md) is source complete
after UI polish, covering optional init setup, task history, worker health,
correlated diagnostics, doctor and previewable local export. Independent static
reviews are clean; delivery is a draft stack. Existing live acceptance obligations
remain unchanged.
