# Slice 3.1 implementation handoff

Status: published as a draft stack, September 6, 2026; **not merged**.
Official stack #405 contains draft PRs [#403](https://github.com/pandemicsyn/neondeck/pull/403)
and [#404](https://github.com/pandemicsyn/neondeck/pull/404). Real model/Codex/GitHub acceptance is
**NOT RUN**. Source base: merged Slice 3, `a897aa06dde6640ad8c8bf83b1683534d252ded5`.

## Delivery contract

Implements the [progress supervision plan](SLICE_3_1_PROGRESS_REVIEW_PLAN.md).
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

| Layer | Branch                           | Owner and responsibility                                                                                                       |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `agent/factory-s31-01-admission` | Poincare: contracts/admission; Raman: history/Flue reviewer; Franklin: coordinator/recovery; Leibniz: integrated runtime tests |
| 2     | `agent/factory-s31-03-workbench` | Halley: readable evidence, explicit planning, accessible operator states and screenshots                                       |

The published linear bases and draft status were verified:

| PR                                                       | Base                             | Reviewed head                              |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| [#403](https://github.com/pandemicsyn/neondeck/pull/403) | `main`                           | `99e6da3e460c6f9d4f01e74d41c613fb602d4d2c` |
| [#404](https://github.com/pandemicsyn/neondeck/pull/404) | `agent/factory-s31-01-admission` | `3224ee8ee66e54661382f6bfda4393366465458e` |

CI is pending a lower-layer test-fixture correction. PR #403 typecheck failed
because `FactoryDelivery.test.tsx` lacks three nullable progress proof fields;
those exact fields are already present in the upper PR. PR #404 typecheck passes,
and secrets checks are green. Move the existing `progressAssessmentId: null`,
`progressInputDigest: null` and `progressEvidenceDigest: null` fixture delta to the
lower layer, then have both static reviewers inspect the relocation before push.
The combined source tree remains unchanged; the published heads above identify
the earlier architecture review. Full CI success and merge remain pending.

Backend admission and assessment ship as one complete layer because requiring a
progress proof without its producer and recovery path would break existing repairs
in an intermediate PR. Shared evidence/API projection and fixture compatibility
accompany that backend; dashboard presentation is the dependent layer. Separate
source modules and agent ownership remain intact.

Use the official `github/gh-stack` extension. Each layer targets the preceding
branch. Run the existing gitleaks pre-commit hook on every commit; never bypass it.
Keep credentials, private addresses and raw live evidence out of this public repo.

## Review and verification gates

- [x] Focused contract, controller, runtime and UI tests pass.
- [x] All verification stages pass (full run plus targeted rerun), as detailed below.
- [x] Two independent static reviews are clean on production/UI source `87a3bbe0`.
- [x] Both independent reviews are clean on the final test-only assertion correction.
- [x] Manager pre-publication architecture and product review is clean.
- [x] Source and documentation static reviews were clean before PR creation.
- [x] Create draft stacked PRs with verification and actual UI screenshots.
- [x] Manager post-publication architecture review is clean on both exact heads above.
- [x] Record PR links and publication status.
- [ ] Review the final publication-status-only documentation delta.
- [ ] Complete CI and obtain merge approval.

The full verification run on `87a3bbe0` passed lint, import layers, database
migration validation and all type checks, then passed 2,351 unit, 47 serial Git and
145 integration tests. One integration case failed its final assertion: it
expected `human-authority`, but the existing `human-budget` intervention correctly
remained the first displayed intervention after two repairs. Authority revocation
was separately recorded; this assertion checks display priority. The test-only expectation was corrected;
the targeted `two-repairs` rerun passed (1 passed, 8 skipped, 135.537 seconds,
exit 0). The skipped cases had already passed in the full run. Combined unique
coverage is **2,544 passing tests: 2,351 unit, 47 serial Git and 146 integration**.

The remaining build, `check:npm-package`, `smoke:npm-pack` and `format:check`
stages passed separately. Local verification is complete across these runs;
this does not claim a single successful `npm run verify` invocation. Both independent reviewers also cleared the final
test-only delta, identified by SHA-256
`8cb5ea6ace7434d21583b25829e5e815177065dd05456542d18e78be36551f39`. Manager pre-publication architecture
review is clean: shared Valibot validates unknown inputs, pure shared schemas are
separate from Node fingerprints, atomic store enforcement is independent, and
runtime, recovery, evidence and UI responsibilities remain distinct. No new `any`
or GitHub transport/caching changes were introduced.

Manager post-publication architecture review is also clean on the exact published
heads above, with cumulative source head `3224ee8e`. It rechecked contracts,
atomic store/service admission, evidence gathering and reads, the Flue provider
fence and UI transport. Pure shared Valibot schemas validate unknown inputs; Node
hashing, store authority and model capabilities remain separate. Retained evidence
is redacted, validated and checked for changes during reads. Both repair paths use
the same gate. There are no new `any` types, unsafe TypeScript suppressions or
GitHub transport/caching changes. This status-only documentation update follows
that source review and awaits its own narrow static review.

Eighteen actual React UI screenshots use synthetic fixtures at 1440px desktop and
390px mobile widths. They cover decision states, expanded history, paused delivery
and transfer into the existing planning session with an unsent draft. Captures
recorded zero chat writes, page errors or horizontal overflow. Four images were attached successfully to the published PRs: desktop workbench,
mobile workbench, existing planning transfer and change approach. No live service
or model behavior is implied.

Reviewers use static inspection only. Fixes return to implementers, then both
reviewers recheck the final candidate. A synthetic model decision tests controller
behavior, not the quality of real model judgment. Live acceptance remains separate
in [SLICE_3_1_ACCEPTANCE.md](SLICE_3_1_ACCEPTANCE.md).

## Implementation decisions

Legacy stored deliveries load an empty progress ledger with the same finite
limits. Previously admitted repairs retain their original recovery path; new
repairs require a bound assessment. Additive JSON state needs no database schema
migration. Known judge execution counts at its recorded duration; unknown usage
retains the reservation within the same cumulative grant.

Flue's one-attempt setting alone does not prevent another model response after a
tool error. A durable create-only provider admission claim under the runtime home
fences new model operations for the assessment, including retries and restart.
Streaming continuations of the admitted operation remain allowed. The judge has no
capability to edit this controller-owned claim.

An uncertain assessment that raises human intervention remains paused after usage
reconciliation; see the Slice 3.1 decision in `.plans/DEVIATIONS.md`. The real model
exercise and Slice 2/3 live acceptance remain pending. Preserve Slice 1 deferred
checks. Record any further material deviations before merge.
