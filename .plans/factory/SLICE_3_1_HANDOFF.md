# Slice 3.1 implementation handoff

Status: implementation in progress, September 6, 2026. No Slice 3.1 PRs have
been created. Source base: merged Slice 3, `a897aa06dde6640ad8c8bf83b1683534d252ded5`.

## Delivery contract

Implement the [progress supervision plan](SLICE_3_1_PROGRESS_REVIEW_PLAN.md).
The progress reviewer is a bounded read-only Flue assessment before an otherwise
authorized coding repair. Both check/review failure and actionable GitHub feedback
use the same gate. Atomic repair admission also requires the matching successful
assessment; calling the coding adapter directly cannot bypass the gate.

Continue uses the proposed scoped instructions. Change approach supplies revised
instructions for the same next fresh Codex repair and consumes its ordinary
allowance. Escalation persists an intervention and shows evidence in the existing
workbench and explicit human planning conversation. A verdict cannot release a
brief, increase budgets, execute code, publish, merge, or send a human message.

This is a checkpoint between attempts. It does not monitor or preempt a running
coding session continuously. Existing cancellation, revocation and execution
deadlines remain responsible for running work. Passing candidate checks/review
continue through the existing publication gates without a progress assessment.
Recognizing suspicious changes during a repair checkpoint does not prove the
model will detect every bad change or establish a new all-green publication gate.

## Delegation and stack

All implementation and independent review agents use GPT-6 Astra at medium effort.
The manager owns scope, integration, verification, Git commits and PR publication.
Agents edit disjoint source sets in the shared checkout and do not create PRs.

| Layer | Planned branch                    | Owner and responsibility                                                                              |
| ----- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | `agent/factory-s31-01-admission`  | Poincare: shared Valibot contracts, persisted assessment admission, finite budgets, exact repair gate |
| 2     | `agent/factory-s31-02-assessment` | Raman: bounded history and Flue reviewer; Franklin: coordinator, repair and recovery integration      |
| 3     | `agent/factory-s31-03-workbench`  | Halley: readable evidence, human planning context, accessible operator states and screenshots         |

Use the official `github/gh-stack` extension. Each layer targets the preceding
branch. Run the existing gitleaks pre-commit hook on every commit; never bypass it.
Keep credentials, private addresses and raw live evidence out of this public repo.

## Review and verification gates

- [ ] Focused contract, controller, runtime and UI tests pass.
- [ ] Full `npm run verify` passes on the cumulative source candidate.
- [ ] Two independent static reviewers return no findings on the final source.
- [ ] Manager checks product-plan adherence and recorded deviations before PRs.
- [ ] Create draft stacked PRs with verification and actual UI screenshots.
- [ ] Manager performs a post-publication architectural review of the full stack:
      Valibot IO validation, precise types, separated responsibilities and ownership.
- [ ] Record PR links, tested source, clean-review source and remaining acceptance.

Reviewers use static inspection only. Fixes return to implementers, then both
reviewers recheck the final candidate. A synthetic model decision tests controller
behavior, not the quality of real model judgment. Live acceptance remains separate
in [SLICE_3_1_ACCEPTANCE.md](SLICE_3_1_ACCEPTANCE.md).

## Implementation decisions

Pending integration. Record material scope changes in `.plans/DEVIATIONS.md` and
link them here. Preserve Slice 1 deferred checks and Slice 2/3 pending live work.
