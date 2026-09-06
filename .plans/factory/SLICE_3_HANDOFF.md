# Slice 3 handoff — Candidate to PR

Status: plan written September 6, 2026 on `agent/factory-s3-00-plan`. Slice 3 runtime implementation is **IN PROGRESS** with agents assigned in the shared checkout. Runtime verification, independent review and live acceptance remain pending. This documentation task has made no commit, push or PR.

## Architecture proposal

See [implementation plan](SLICE_3_IMPLEMENTATION_PLAN.md) for full contracts and tests. Five dependent layers: plan; foundation and transport; independent verification and bounded Codex repairs; durable delivery and exclusive ownership; workbench and cumulative acceptance.

The critical integration gap is that Slice 2 stores one terminal attempt per release and its candidate may contain dirty/untracked work. Add a factory execution aggregate with immutable child attempts, reacquire the existing writer/worktree ownership, freeze a complete immutable Git `treeSha` through a private alternate index and certify its exact tree/spec/validation contract with original base/head and retained digest. No synthetic commit is created; the original checkout, real index and receipt stay unchanged. Preserve old receipts and uniqueness; do not reopen a terminal attempt or create a second repair writer pool.

Checks will run in an isolated verification checkout through a new typed bounded supervisor contract, reusing existing local-host lifecycle patterns; arbitrary check execution is not an existing Codex-host capability. A fresh read-only model reviewer receives the same materialized tree and executed evidence. Preserve the original head-to-tree mapping and never label tree checks as checks on a later commit. Scoped repairs use fresh explicit Codex sessions in the retained managed worktree, with at most two repairs per exact candidate delivery authorization and three-hour cumulative execution limits. Scope changes and exhaustion use the existing planning conversation and typed exact decisions. Ordinary authorized repair has no extra human approval.

Manager decision: existing `factoryPolicy` with `publish:false` acquires neither repairs nor publication on upgrade. Deliberately require `authorize-candidate-delivery` after the human sees the exact candidate. Proposed request: idempotency ID, expected execution version, candidate ID/digest, release/spec version/hash, target repo/base/head and config digest. The server validates and persists an immutable actor-attributed snapshot granting scoped checks, at most two repairs total (including watched feedback) and draft publication with at most three hours cumulative execution, including prior consumed execution. Replays never replenish budget. UI shows exact authority and consumed/reserved/remaining budgets; ordinary descendant repairs add no gate. Changed scope/target/config or unrelated candidate requires a new exact decision; merge is never granted.

A trusted service owns publication credentials and a durable per-execution delivery identity. Reconcile branch and draft-PR writes after uncertain outcomes; an absent read after a timeout is insufficient permission to create again. Attach the existing watch to the recorded PR, using a durable factory ownership generation checked by scheduler and direct legacy mutation paths. Human merge/close observations create auditable outcomes; cleanup requires dead compute, settled effects and preserved valuable work.

## Layer ledger and implementer boundaries

The manager owns stack branch creation and implementation assignments. The manager is coordinating implementers in this shared checkout using disjoint file sets so dependent contracts remain available. Agents are assigned; implementation verification and layer acceptance remain pending.

| Layer | Proposed branch                    | State                        | Handoff contract                                                                                                                                                                      |
| ----- | ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `agent/factory-s3-00-plan`         | Docs written; review pending | Plan and this ledger only.                                                                                                                                                            |
| 1     | `agent/factory-s3-01-foundation`   | In progress; unverified      | Store/migrations, aggregate/attempt contracts, ownership/budget primitives and GitHub transport; evidence identity contracts for layer 2.                                             |
| 2     | `agent/factory-s3-02-verification` | In progress; unverified      | Candidate freeze, evidence/certification, checks/reviewer, bounded repair and structured planning interventions; consume layer 1 identities, never independently reset budgets.       |
| 3     | `agent/factory-s3-03-delivery`     | In progress; unverified      | Exact authority/certification consumption, durable remote effects/receipt, exclusive watch ownership and feedback, outcome/cleanup backend; recover attachment without recreating PR. |
| 4     | `agent/factory-s3-04-workbench`    | In progress; unverified      | Workbench/operator flow for exact authorization and budgets, evidence/repair/intervention, watches/outcomes/cleanup, plus cumulative verification.                                    |

Agree shared schema/state transitions in layer 1 before parallel implementation against them. Layer 2 must settle admission and cancellation APIs before delivery integration. Layer 3 owns watch backend integration and must expose stored PR identity, recoverable attachment and outcome/cleanup state before layer 4 UI integration. Any materially changed contract returns to the manager and is recorded here; later approved deviations also belong in the deviations ledger. Do not share mutable runtime homes or run live providers from this shared documentation checkout.

## Acceptance carried forward

- **Slice 1: operator-accepted with deferred checks.** Preserve human iteration/version comparison/exact release, post-release recovery/revocation, attributed replies/questions/writeback repair/missed-delivery and full manual-source live exercises as unperformed. See [Slice 1 handoff](SLICE_1_HANDOFF.md).
- **Slice 2: real Codex acceptance pending postmerge.** Operator-authorized merge sequencing supersedes earlier premerge live holds. Mockdex/local checks are not CLI/auth/model proof; the manager verified Slice 2 merged on main `0b776ff`. See [Slice 2 acceptance](SLICE_2_ACCEPTANCE.md).
- **Slice 3: implementation in progress; not verified or live accepted.** No premerge live gate. Separately authorized postmerge evidence remains required before claiming live Candidate-to-PR acceptance. Remote/Linux/VM work remains separate.

## Required evidence ledger

Record exact tested/reviewed revision and actual result per layer; never copy historical test counts as evidence for a new tree.

| Evidence                                                                            | Status                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------- |
| Candidate freeze includes dirty/untracked content; stale evidence fails closed      | Unperformed; implementation in progress |
| Independent checks plus fresh read-only reviewer; blocked evidence never passes     | Unperformed; implementation in progress |
| Ordinary repair without human gate; scope and exhaustion decisions through planning | Unperformed; implementation in progress |
| Restart-safe budgets, writer exclusion, cancellation and receipt reconciliation     | Unperformed; implementation in progress |
| Timeout/crash PR delivery reconciliation without duplicate create                   | Unperformed; implementation in progress |
| Exclusive factory ownership including queued/direct legacy actions                  | Unperformed; implementation in progress |
| Watched feedback re-enters same bounded verification/delivery flow                  | Unperformed; implementation in progress |
| Human merge/close outcome; safe dirty/uncertain/squash cleanup                      | Unperformed; implementation in progress |
| API/UI states, synthetic screenshots and unchanged legacy behavior                  | Unperformed; implementation in progress |
| Focused/cumulative verification and two independent reviews plus manager acceptance | Unperformed; implementation in progress |
| Separately authorized real Codex/GitHub postmerge exercise                          | Pending; not run                        |

## Documentation task record and follow-ups

Read the roadmap, factory proposal, Slice 1 handoff, Slice 2 plan/acceptance/handoff, README/SOUL, Hermes notes and nearby coding-run, factory, GitHub, watch and worktree backend contracts. The Hermes notes are at `.plans/research/HERMES_RESEARCH.md` in this tree.

Edited `SLICE_3_IMPLEMENTATION_PLAN.md`, `SLICE_3_HANDOFF.md`, and the explicitly authorized branch-filter additions in `.github/workflows/pr-checks.yml`, `.github/workflows/npm-package.yml` and `.github/workflows/secrets-scan.yml`. Existing filters, permissions and checks are preserved. No runtime tests were run for this documentation task, as requested. Workflow YAML structure and exact filter-only deltas were checked locally; GitHub CI has not run for these edits. Documentation inspection is not independent reviewer or manager signoff.

Manager follow-ups: review this contract; assign layer ownership; update roadmap/planning indexes as part of integration; record approved deviations in `.plans/DEVIATIONS.md`; carry prior acceptance obligations forward unchanged. Before runtime implementation, read relevant version-matched Flue documentation for reviewer/planning APIs rather than guessing framework behavior. No new coding harness, remote host, cache subsystem, merge authority or premerge live gate is part of this proposal.

Keep raw logs, private issue/work/session identifiers, credentials and deployment addresses outside this public repository. Public evidence should contain only sanitized outcomes and relevant source revisions.

## Manager decision — exact delivery grant

This intentionally narrows the proposal's per-cycle repair default to two repairs under the exact authorization; fresh PR feedback cannot replenish it. The implementation plan includes the proposed API and UI contract. Manager owns propagating this decision to the deviations ledger under the manager's assigned ownership. Slice 2 real Codex acceptance stays pending postmerge and is not a merge blocker.

The manager additionally requires a final architectural review after all stack PRs exist, separate from the two independent static prepublication reviews and manager candidate review. Both review stages remain unperformed for this proposal. Work proceeds in the shared checkout with disjoint file ownership; the manager owns ROADMAP and DEVIATIONS, while this assignment owns the two Slice 3 docs and three workflow filter edits.

## Manager refinement — tree certification and publication commit

Independent checks/review certify the immutable Git tree materialized in a separate verification checkout. Delivery uses a separate publication checkout to make a normal commit with configured author and hooks enabled. Prove its tree equals the certified tree; hook edits reject delivery and require rechecking. Persist the commit SHA effect and explicit head/parent-to-tree mapping before push, reconciling crash windows without blindly committing again. Original retained checkout and receipt remain unchanged. UI/evidence distinguishes the certified tree from its later publication commit. Required tree-freeze, hook-mutation and commit-effect recovery tests remain unperformed until implementers record results.
