# Slice 3 operator flow: candidate to draft PR

Status: updated for the single validation/publication lifecycle, September 7, 2026.
Implementation verification is tracked in the [current lifecycle plan](VALIDATION_AND_PUBLICATION_UX.md).
Live Codex/GitHub acceptance remains pending. The [original implementation contract](SLICE_3_IMPLEMENTATION_PLAN.md)
and [handoff](SLICE_3_HANDOFF.md) retain earlier delivery and acceptance history.

## Release the plan, then approve publication

The task header shows **Plan → Code → Validate → Approve PR → Watch PR → Done**,
the current activity or blocker, and its next action. Completed stages can be
expanded without losing the conversation or unsaved text.

Review the brief, coding settings, independent reviewer and repository checks,
then release the plan. Coding proceeds into local checks, independent review and
bounded in-scope repairs automatically. GitHub intake and publication setup are
not required for validation. Existing test records without the current policy
need a fresh release; their brief, history and retained work remain available.

Under **Review result**, inspect checks, findings and the immutable reviewed diff.
Current failed reviews also have an inspectable diff. The separately available
live worktree view can differ from reviewed evidence. A clean result waits at
**Approve PR**. Configure publication using the registered repository and an
existing credential reference if necessary; this does not enable intake.

Select explicit consent and choose **Create draft PR** for the exact reviewed
candidate, target and remaining limits. This separate decision permits a draft PR
and bounded feedback repairs updating that same PR. There are at most two repairs
and three hours cumulative execution, including initial coding, checks, review
and progress assessment. Each attempt is limited to 45 minutes or the configured
smaller bound. Publication and new feedback do not replenish the allowance.
Merge and deployment remain outside factory authority.

An unconfirmed approval retains its original request in browser session storage.
**Retry original decision** recovers that receipt without new authority or budget.
A version conflict requires **Review a fresh decision** and new consent. Changed,
missing, private or oversized reviewed content cannot be approved through an
incomplete preview; the UI explains the reason and recovery. The immutable diff
uses the existing 1 MiB evidence display limit.

## Follow execution and evidence

The delivery view displays authoritative consumed, reserved and remaining execution and repairs used/remaining. Unknown in-flight usage remains reserved. It separately shows independent checks and fresh read-only review outcomes. Prior-revision results remain visible as history and do not certify the current tree. Missing current evidence is pending, never passed. Expand each receipt to inspect bounded check output and review findings, current/prior revision, settlement, accounting and publication eligibility. Released acceptance criteria are review inputs, not proof that behavior was executed. Failed refreshes retain prior content with a stale warning.

The frozen tree and later publication commit are separate identities. Check evidence pertains to the tree; commit receipts retain the published commit/tree mapping. PR links open the provider and the existing Neondeck review workbench. Watch attachment is shown only when recorded; a missing attachment does not imply another PR should be created.

## Human intervention and revocation

Scope, budget, authority and uncertainty states expose the intervention reason and exact revision. **Discuss delivery evidence with Neon** opens the task's existing conversation and attaches delivery version, revision, budget, interventions, bounded actual check output, review findings and receipt eligibility to the next explicit human message. The triggering external scope classification appears beside the intervention with its actual findings and retained feedback text. Discussion prioritizes that report before other feedback and check/review history. Current and prior revisions, receipt accounting and classification binding remain explicit; external feedback does not certify publication. Failed evidence reads leave an error and do not send an incomplete briefing. Existing unsent text is retained. Inspect or clear the evidence before sending. Selecting this control does not admit a model turn automatically.

Use the conversation to clarify scope or determine the next bounded decision. Conversation alone cannot release a new brief or grant execution/publication. This API has no budget-reset or extension endpoint: changed scope or exhausted authority needs the reviewed exact release/candidate/grant path supported by the backend.

**Revoke delivery authority** opens a reason field and explicit confirmation. Revocation fences new work; it does not undo a push or existing PR. **Reconcile delivery receipts** requests observation of uncertain effects using the displayed delivery version. A conflict refreshes the detail and requires another human action. Failed refreshes retain evidence but disable mutation controls.

Merged, closed, cancelled and failed outcomes are displayed distinctly. An outcome does not imply deployment success or authorize deletion. No merge or cleanup button is introduced; protected retained-work cleanup depends on the backend's supported operator flow and evidence policy.

## Verification coverage

The counts and flows below describe the original Slice 3 checkpoint. Current
single-lifecycle regression results and remaining acceptance are recorded in the
[lifecycle plan](VALIDATION_AND_PUBLICATION_UX.md).

Focused UI tests cover exact consent, immutable grant replay, conflicts, canonical API parsing, stale controls, authoritative budgets, current and prior evidence, readable external feedback, explicit planning transfer, PR review routing and revocation gating.

Five local integration flows cover initial publication, uncertain PR-creation recovery, failed-check repair before publication, repair republishing to the same PR, and reviewer findings followed by scoped repair and a passing review. They use real mockdex coding execution and production candidate capture, check supervision, reviewer validation, repair and commit hooks. Flue admission/settlement and GitHub responses are simulated; push transport targets a temporary local bare repository. Four separate tests exercise the actual Flue runtime with a fake provider. Live providers and watch polling are outside these local integration fixtures.

Screenshots at 1440px and 390px show the actual React UI with invented synthetic data, including expanded check output, external feedback and classifier findings. They demonstrate presentation, not live provider or backend acceptance. The temporary harness and screenshots remain outside tracked source. Final test results, source hashes and attachment paths are recorded in the manager handoff.
