# Slice 3.1 acceptance record

Status: implemented and verified locally, September 6, 2026. No Slice 3.1 PRs
have been created; publication and post-publication architecture review are
pending. Real model/Codex/GitHub acceptance is **NOT RUN**. Slice 1 operator
acceptance with deferred checks and Slice 2/3 pending live acceptance are unchanged.

## Deterministic implementation verification

All verification stages pass (full run plus targeted rerun): 2,544 unique tests
comprise 2,351 unit, 47 serial Git and 146 integration tests. The full run on
`87a3bbe0` had one final assertion failure in `two-repairs`; its corrected test-only
expectation passed the targeted rerun (1 passed, 8 already-covered cases skipped).
Build, package inspection, package smoke and formatting passed separately. This
is not a claim that one `npm run verify` invocation exited successfully. See the
[handoff](SLICE_3_1_HANDOFF.md#review-and-verification-gates) for the precise record.
Two static reviewers are clean on production/UI `87a3bbe0`; the final test-only
delta remains in review. Synthetic
judge output proves routing and enforcement only; fixture names such as
oscillation or weakened tests are not evidence that a real model detected them.

| Scenario                                                   | Required evidence                                                                         | Status                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| First repair                                               | Current facts and proposed approach; no fabricated prior history                          | Local pass                 |
| Repeated failure and unchanged candidate                   | Deterministic fingerprints plus revision-bound history                                    | Local pass                 |
| Oscillation, weakened tests, scope drift, partial progress | Meaningful packet contents and synthetic decision routing                                 | Local pass                 |
| Both repair entry paths                                    | Checks/review and actionable PR feedback cannot skip supervision                          | Local pass                 |
| Continue and change approach                               | Exact accepted instructions enter one fresh coding repair under the same grant            | Local pass                 |
| Escalate                                                   | Durable pause, readable evidence and explicit human planning action                       | Local pass                 |
| Bound authority                                            | Wrong grant, revision, ordinal, request, instructions or evidence cannot authorize repair | Local pass                 |
| Duplicate and concurrent work                              | One admission per prospective repair ordinal; one coding writer                           | Local pass                 |
| Restart and unknown admission                              | Retain original deadline, submission identity and reservation; no replacement judge       | Local pass                 |
| Limits and bad results                                     | Exhaustion before model admission; malformed/missing/late/unknown usage fails closed      | Local pass                 |
| Human surface                                              | Pending, uncertainty, outcome/history and narrow/wide screenshots                         | Local pass                 |
| Regression checks                                          | Verification stages pass; production/UI reviews clean, final test-delta review pending    | Local pass; review pending |

Coverage is recorded in `progress-store.test.ts`, `progress-reviewer.test.ts`,
`progress-reviewer-admission.test.ts`, `progress-service.test.ts`,
`progress-evidence-paths.test.ts` and `evidence-progress.test.ts` under
`src/modules/factory-delivery/`, the agent integration tests,
`src/server/factory-delivery.integration.test.ts`, and the delivery/progress/planning
UI tests. Eighteen actual React screenshots use synthetic fixtures, with zero
writes during explicit planning transfer and no page errors or horizontal overflow.

The checkpoint runs between attempts; it does not continuously monitor or preempt
live coding and adds no new gate for candidates whose checks and review pass.
Real model judgment quality is unevaluated. Synthetic decisions establish routing,
binding and limits, not detection accuracy for suspicious changes.

## Real model and operator exercise — NOT RUN

Exercise only a bounded operator-selected test environment and repository. Keep
credentials, private addresses and raw model/session evidence outside this repo;
publish sanitized outcomes and tested public source revisions only.

- [ ] Record source build, Node, Flue, Codex, configured reviewer model and scope.
- [ ] Observe a real progress assessment after an actual failed candidate or
      actionable PR feedback. Verify the displayed facts match retained evidence.
- [ ] Evaluate labeled examples of repeated failure, oscillation, weakened tests,
      scope drift, legitimate partial progress and an initial repair. Record each
      expected outcome, actual rationale, misclassification and unperformed case.
- [ ] Observe continue/change-approach entering one fresh repair under the existing
      grant. Confirm judge usage plus coding/check/review usage remain cumulative.
- [ ] Observe escalation and discuss its evidence through an explicit human
      message. Confirm discussion does not replenish execution or publish work.
- [ ] Rehearse a bounded restart/revocation case and inspect original admission,
      deadline, submission and retained unknown usage without editing receipts.
- [ ] Record operator/manager acceptance and outstanding cases. Do not infer that
      synthetic scenarios establish real-provider reliability or sandbox isolation.

This record adds no unrequested merge gate and does not authorize live external
writes or deployment. Existing [Slice 3 live obligations](SLICE_3_ACCEPTANCE.md)
remain pending and should be exercised with this checkpoint in place.
