# Software factory implementation

Historical acceptance: the original slice 1 stack was reviewed through feature
`a0c0cf31c8a6693863e1f975eb61f8ff1bb85fa3` and documentation head
`ff3a69033ae866aaf47dd0a6c3384544e5eb1e6a`. Those reviews and verification apply
to those candidates. See the [handoff ledger](SLICE_1_HANDOFF.md) for incorporated
feedback parents and [PR #387](https://github.com/pandemicsyn/neondeck/pull/387)
for current feedback reviews and CI. Each publication requires its own verification,
two clean dedicated static reviews and manager acceptance. Nothing is merged,
deployed or live-accepted.

The implemented local scope is **slice 1: intake to a human-released queue**.
Neon helps a human shape a task into a versioned brief. Coding remains delegated to
Codex or OpenCode in subsequent slices; this work does not build a coding agent.

- [Slice 1 implementation plan](SLICE_1_IMPLEMENTATION_PLAN.md): scope, contracts,
  five stacked PRs, acceptance criteria, and operational readiness.
- [Implementation handoff](SLICE_1_HANDOFF.md): manager/reviewer responsibilities,
  implementer assignment template, stack maintenance, and progress ledger.
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
