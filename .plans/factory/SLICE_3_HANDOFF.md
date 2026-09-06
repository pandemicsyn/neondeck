# Slice 3 handoff — Candidate to PR

Status: implementation and integration review in progress, September 6, 2026.
**No Slice 3 PRs have been created.** Independent reviewers have found issues;
fixes and renewed review are in progress. Cumulative verification and the final
post-publication architecture review are not yet complete. Real-provider
acceptance remains pending in [SLICE_3_ACCEPTANCE.md](SLICE_3_ACCEPTANCE.md).

## Scope and ownership

The [implementation plan](SLICE_3_IMPLEMENTATION_PLAN.md) follows the
[roadmap](../ROADMAP.md) and records the concrete local Candidate-to-PR contract.
The manager delegates implementation to Astra agents at medium effort. Independent
Astra/medium agents perform static review; the manager checks product adherence,
verification evidence, stack structure and final architecture. Implementers do not
create PRs. Both independent reviews must be clean before publication.

| Layer | Branch                             | Responsibility                                                                                           | Current status                                                          |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 0     | `agent/factory-s3-00-plan`         | Plan, acceptance sequencing and stack CI branch filters                                                  | Local checkpoint; final documentation integration pending               |
| 1     | `agent/factory-s3-01-foundation`   | Shared contracts, SQLite migration, budget/certification/ownership rules and GitHub transport            | Local checkpoints and focused tests; final review pending               |
| 2     | `agent/factory-s3-02-verification` | Exact tree evidence, supervised checks, independent Flue review, fresh Codex repairs and execution usage | Implemented; recovery fixes and cumulative verification in progress     |
| 3     | `agent/factory-s3-03-delivery`     | Exact grant, durable Git/PR effects, feedback ownership, recovery and cleanup                            | Implemented; integration/review in progress                             |
| 4     | `agent/factory-s3-04-workbench`    | Human grant/evidence/planning/revocation UI and complete local integration                               | Implemented; readable evidence and integration verification in progress |

All local commits run the mandatory gitleaks precommit hook. No deployment
credentials or private host identifiers belong in this stack. Runtime exercises
use private temporary homes, mockdex, fake model providers, local Git repositories
and synthetic GitHub transport; they do not grant live provider acceptance.

## Implemented boundaries

- One immutable delivery grant per released brief binds the original candidate,
  target, configuration/check contract and cumulative budget. Regranting repair
  descendants cannot reset the two-repair/three-hour ceiling. Coding, checks and
  model review count; unknown usage retains its reservation.
- The original retained candidate and receipt stay intact. Freeze complete
  tracked/untracked content and executable modes into a Git tree through a
  private index. Keep owned tree refs for historical reachability. Legacy
  untracked receipts without sealed modes need a fresh explicit released attempt.
- Each revision has a separate managed checkout/local branch for supervised
  checks and the later normal publication commit. Scoped repairs use the existing
  Codex adapter, a fresh session and a new coding workspace. One durable remote
  PR branch receives certified revisions. No new coding harness is introduced.
- Publication uses configured author/signing and trusted source hooks, with
  durable intent and validated success receipts. A matching tree/message alone
  does not prove hooks succeeded. Expected-head leases also require fast-forward
  ancestry; uncertain GitHub creates are reconciled through reads, never blindly
  repeated. Existing credential-scoped ETag/cache transport is reused.
- App state remains in Neondeck SQLite. Model sessions remain in Flue. Store
  admission, aggregate rules, persistence and ownership are separate modules.
  Check supervision, reviewer lifecycle, publication, feedback normalization and
  human evidence reads have distinct responsibilities and Valibot boundaries.
- Existing watches provide cadence and shared facts. Factory ownership fences
  legacy mutation paths, including pending/direct owner actions. Scoped feedback
  uses the same repair budget and renewed checks/review; merge remains human.

## Human touchpoints and deliberate limits

The [operator guide](SLICE_3_OPERATOR.md) covers exact candidate consent, current
versus historical evidence, readable check output/findings, planning context,
revocation and receipt reconciliation. Scope or budget decisions return to the
existing conversation. Chat alone cannot release a brief, extend authority or
publish. Review the diff and unexercised acceptance criteria before merging.

The [deviations ledger](../DEVIATIONS.md) records these scoped decisions:

- Existing `publish:false` releases require a separate delivery grant. Ordinary
  in-scope repairs under that grant have no extra approval gate.
- Same-release budget extensions are deferred; fixed exhausted grants cannot reset.
- Local check homes/config/data/temp are private with an allowlisted environment.
  This is not filesystem isolation from malicious code with equivalent OS access.
- Certification covers configured checks and independent code review, not full
  visual/product acceptance. A separate per-scenario/browser-artifact harness is
  deferred; actual criteria/evidence remain visible to the human.
- The PR body labels immutable initial publication evidence. Certified repairs
  advance the same branch; current evidence is in Neon. Body updates are deferred
  until conflict-safe writes can preserve concurrent human edits.
- Only the latest published clean/dead/settled revision checkout is eligible for
  cleanup after 24 hours following observed merge/close. Earlier revisions, coding
  and repair work, frozen-tree refs and evidence remain retained indefinitely.
  Seven-day attention, 30-day pruning and remote branch deletion are deferred.

## Verification and review ledger

The first cumulative verification checkpoint passed 2,182 unit tests, 47 serial
Git tests and 132 integration tests, plus lint, import layers, migrations,
TypeScript, builds, package inspection and installed-package smoke checks. Its
final format check encountered two files being corrected concurrently. This is
an intermediate functional checkpoint, not a final all-green verification claim.
The publication candidate still requires a frozen full verification run.

Reviewers cleared the original unique-release, receipt-backed certification,
execution-duration, remaining-repair-budget, untracked-mode, publication-hook,
commit-proof, worktree-ownership, prepublication-repair and frontend-schema
findings. Further corrections cover reviewer receipt compatibility and deadlines,
bounded check contracts, private check environments, feedback crash boundaries,
PR identity before repair pushes, large reports and paused human outcomes. The
readable external-feedback planning handoff is also undergoing renewed review.
No whole-candidate clean signoff is claimed yet.

| Required final evidence                                                                      | Status                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Full `npm run verify` on the publication candidate                                           | Pending                                          |
| Actual mockdex → check worker → fake-provider review → local Git/draft transport integration | In progress                                      |
| Real desktop/mobile screenshots of implemented UI                                            | Captured; final evidence-content refresh pending |
| Two independent clean static reviews of the exact candidate                                  | Pending                                          |
| Manager product/implementation review                                                        | In progress                                      |
| Draft stacked PR publication and per-layer CI                                                | Not started                                      |
| Final architecture review after all PRs exist                                                | Pending                                          |
| Real Codex/GitHub postmerge acceptance                                                       | NOT RUN                                          |

## Acceptance carried forward

Slice 1 is operator-accepted with the recorded checks deferred, not all passed.
Slice 2 merged on main at `0b776ff6994b8d078aa550910ca143b61d643bbd` with real Codex
acceptance pending after the operator-authorized merge. Preserve the
[Slice 1 record](SLICE_1_HANDOFF.md) and [Slice 2 acceptance](SLICE_2_ACCEPTANCE.md).
No new premerge live gate is introduced, and no live SSH/model/GitHub exercise is
authorized by documentation or synthetic checks alone.
