# Slice 3 handoff — Candidate to PR

Status: implemented and verified; five draft stacked PRs published September 6, 2026. Two independent static reviews and the manager's product and architectural
reviews are complete with no outstanding findings. Human review and merge remain
pending. **Real Codex/GitHub acceptance is NOT RUN**, as recorded in
[SLICE_3_ACCEPTANCE.md](SLICE_3_ACCEPTANCE.md).

## Stack and review record

The stack uses the official `github/gh-stack` extension. Each PR targets the layer
below it. Implementation and both independent static reviews used GPT-6 Astra at
medium effort; Codex managed scope, integration, verification and final review.
No PR was created until both independent reviewers returned clean.

| Layer | PR                                                       | Responsibility                                                                                |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0     | [#397](https://github.com/pandemicsyn/neondeck/pull/397) | Plan, acceptance sequencing and stack CI filters                                              |
| 1     | [#398](https://github.com/pandemicsyn/neondeck/pull/398) | Shared contracts, SQLite state, authority/budgets/ownership and GitHub transport              |
| 2     | [#399](https://github.com/pandemicsyn/neondeck/pull/399) | Frozen candidate evidence, supervised checks, independent Flue review and fresh Codex repairs |
| 3     | [#400](https://github.com/pandemicsyn/neondeck/pull/400) | Exact delivery grants, durable Git/PR effects, feedback, recovery, outcomes and cleanup       |
| 4     | [#401](https://github.com/pandemicsyn/neondeck/pull/401) | Human workbench, readable evidence/planning, operator guide and complete local integration    |

Both independent reviewers signed off on source candidate
`685ed532bdaa9674941c92747000990970831871`, tree
`88dcfa4d9a9513c57aa31f6c744e4940a6ee0ad1`, against merged Slice 2 base
`0b776ff6994b8d078aa550910ca143b61d643bbd`. They inspected the cumulative changes
and final corrections, including revision/receipt authority, model/process
recovery, legal payload bounds, PR identity before mutation, paused outcomes and
truthful UI publication status. Reviewers ran no tests or runtime commands.

The manager's product review confirms the
[implementation contract](SLICE_3_IMPLEMENTATION_PLAN.md): exact human consent,
ordinary scoped repairs without repeated approval, human scope decisions and
merge ownership, reuse of Codex/Flue/worktrees/watches, and no new coding agent.
Later changes in this layer record verification, PR metadata and separately scheduled follow-up scope; the tested runtime source remains unchanged.

## Verification

`npm run verify` passed on the reviewed source candidate using Node 26.4.0:

- 2,259 unit tests, 47 serial Git tests and 133 integration tests.
- Lint, import layers, database migration validation, backend/dashboard/docs
  type checks, formatting, web/server/docs builds, npm package inspection and
  installed-package/direct-entry smoke checks.
- Archived foundation, verification and delivery layers independently passed
  backend/dashboard TypeScript checks before integration. Stack PR CI provides
  the per-layer remote result; current status is visible on each PR.
- Mandatory gitleaks hooks remained enabled throughout; no bypass was used.
  The complete source commit range also passed a separate secrets scan.
- Actual desktop/mobile React screenshots using invented fixture data are
  attached to the workbench PR. The manager inspected grant, intervention and
  confirmed-publication views; captures have no page errors or horizontal overflow.

Five complete local service scenarios cover initial publication, uncertain PR
creation recovery, failed-check repair before publication, independent reviewer
findings entering repair, and a repair advancing the same PR branch. They use
real mockdex execution, candidate capture, check supervision, receipt validation,
repair admission, normal Git hooks and a temporary bare Git remote. Flue
dispatch/read and GitHub responses are synthetic in these flows. Separate tests
exercise actual Flue with a fake provider. These checks establish neither real
provider compatibility nor full visual/product acceptance.

## Manager architecture review after PR publication

Completed against all five published layers, with no outstanding findings.

- **IO contracts:** canonical shared Valibot schemas cover operator/API/UI,
  SQLite records, config, worker receipts, model submissions/results and GitHub
  responses. Git text and filesystem ownership are independently checked at
  their adapters. Frontend adapters consume shared contracts rather than copies.
- **Ownership:** foundation admission, aggregate rules, command reduction,
  persistence and ownership fences are separate. Routes use the delivery facade;
  deterministic orchestration delegates effects to explicit adapters. Existing
  worktree services retain resource ownership and legacy mutation guards.
- **Module responsibilities:** check supervision, reviewer lifecycle, repairs,
  commit proof, push admission, publication recovery and feedback are distinct.
  Evidence file/privacy handling, certification reads and feedback reads are
  separated. React grant, detail, evidence, commit status and planning serialization
  have focused modules. Import-layer checks pass; no new broad `any` escape or
  duplicate runtime/cache was found.
- **Authority and durability:** one grant per release retains cumulative budgets;
  new revisions require new evidence. Known nonadmission is distinguished from
  uncertain invoked effects. Existing PR identity and draft/open state are read
  before repaired pushes; Git head leases remain required. GitHub conditional
  reads reuse credential-scoped ETags without joining stale in-flight reads.
- **Human facts:** actual scope feedback leads the explicit planning handoff;
  local commits are not called published until a matching push is confirmed.
  Pauses permit read-only outcome observation. Cleanup retains unpublished,
  dirty, uncertain and historical work.

## Human touchpoints and retained obligations

Cross-cycle progress assessment is not implemented in Slice 3. The operator has
scheduled [Slice 3.1 progress supervision](SLICE_3_1_PROGRESS_REVIEW_PLAN.md) as the
next factory follow-up before OpenCode. A bounded read-only judge will evaluate
repair history while preserving hard limits and human authority.

The [operator guide](SLICE_3_OPERATOR.md) covers exact consent, diff and evidence
review, scope/budget conversation, revocation and reconciliation. Chat alone
cannot release a brief, grant publication, extend budgets or merge.

The [deviations ledger](../DEVIATIONS.md) records the accepted initial limits:
fixed grants without same-release extensions; private local job environments
without a hostile-code filesystem sandbox; configured checks plus separate code
review without a per-scenario browser harness; immutable initial PR-body evidence
with current repair evidence in Neon; and local cleanup only for the latest
confirmed publication after 24 hours and exact ownership/cleanliness/death checks.
Earlier workspaces, coding/repair work, evidence and frozen-tree refs remain
retained indefinitely. Remote provisioning, pruning, branch deletion, auto-merge
and deployment remain outside this slice.

Slice 1 remains operator-accepted with recorded checks deferred. Slice 2 is merged
with real Codex acceptance pending after the operator-authorized merge. Preserve
the [Slice 1 history](SLICE_1_HANDOFF.md), [Slice 2 acceptance](SLICE_2_ACCEPTANCE.md)
and separate Slice 3 postmerge exercise. No new live gate or live SSH/model/GitHub
write authorization is inferred from synthetic verification or these draft PRs.
