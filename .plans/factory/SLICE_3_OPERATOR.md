# Slice 3 operator flow: candidate to draft PR

Status: UI implementation with synthetic verification, September 6, 2026. Live Codex/GitHub acceptance remains pending. See the [implementation contract](SLICE_3_IMPLEMENTATION_PLAN.md) and [handoff](SLICE_3_HANDOFF.md) for backend delivery and acceptance status.

## Grant an exact candidate

Open a factory task and its retained coding attempt. Review the retained worktree through the existing read-only diff viewer. Current worktree changes can differ from captured candidate content; the delivery preview identifies the frozen tree and candidate digest separately.

Under **Candidate delivery**, review the specification version, short candidate/tree label, target and check commands. Expand **Revision details** for the exact candidate/run/attempt, release, specification hash, frozen tree, original base/head and configuration fingerprint. Existing `publish:false` releases do not authorize publication or repairs automatically.

Select the explicit consent checkbox and choose **Grant bounded draft delivery** only when this exact preview is intended. The grant permits scoped checks, at most two repairs total and draft-PR publication. Cumulative execution is limited to three hours including initial coding, verification and review, with 45 minutes per attempt. New feedback does not replenish the allowance. Merge and deployment remain outside this authority.

An unconfirmed grant retains its original request and preview in browser session storage. **Retry original delivery grant** replays that exact request; it does not reset budget. A version conflict requires **Review a fresh grant**, a refreshed preview and new consent. A failed or unsupported read disables granting. Unreadable saved request storage blocks another grant until restored.

## Follow execution and evidence

The delivery view displays authoritative consumed, reserved and remaining execution and repairs used/remaining. Unknown in-flight usage remains reserved. It separately shows independent checks and fresh read-only review outcomes. Prior-revision results remain visible as history and do not certify the current tree. Missing current evidence is pending, never passed. Expand each receipt to inspect bounded check output and review findings, current/prior revision, settlement, accounting and publication eligibility. Released acceptance criteria are review inputs, not proof that behavior was executed. Failed refreshes retain prior content with a stale warning.

The frozen tree and later publication commit are separate identities. Check evidence pertains to the tree; commit receipts retain the published commit/tree mapping. PR links open the provider and the existing Neondeck review workbench. Watch attachment is shown only when recorded; a missing attachment does not imply another PR should be created.

## Human intervention and revocation

Scope, budget, authority and uncertainty states expose the intervention reason and exact revision. **Discuss delivery evidence with Neon** opens the task's existing conversation and attaches delivery version, revision, budget, interventions, bounded actual check output, review findings and receipt eligibility to the next explicit human message. The triggering external scope classification appears beside the intervention with its actual findings and retained feedback text. Discussion prioritizes that report before other feedback and check/review history. Current and prior revisions, receipt accounting and classification binding remain explicit; external feedback does not certify publication. Failed evidence reads leave an error and do not send an incomplete briefing. Existing unsent text is retained. Inspect or clear the evidence before sending. Selecting this control does not admit a model turn automatically.

Use the conversation to clarify scope or determine the next bounded decision. Conversation alone cannot release a new brief or grant execution/publication. This API has no budget-reset or extension endpoint: changed scope or exhausted authority needs the reviewed exact release/candidate/grant path supported by the backend.

**Revoke delivery authority** opens a reason field and explicit confirmation. Revocation fences new work; it does not undo a push or existing PR. **Reconcile delivery receipts** requests observation of uncertain effects using the displayed delivery version. A conflict refreshes the detail and requires another human action. Failed refreshes retain evidence but disable mutation controls.

Merged, closed, cancelled and failed outcomes are displayed distinctly. An outcome does not imply deployment success or authorize deletion. No merge or cleanup button is introduced; protected retained-work cleanup depends on the backend's supported operator flow and evidence policy.

## Verification coverage

Focused UI tests cover exact consent, immutable grant replay, conflicts, canonical API parsing, stale controls, authoritative budgets, current and prior evidence, readable external feedback, explicit planning transfer, PR review routing and revocation gating.

Five local integration flows cover initial publication, uncertain PR-creation recovery, failed-check repair before publication, repair republishing to the same PR, and reviewer findings followed by scoped repair and a passing review. They use real mockdex coding execution and production candidate capture, check supervision, reviewer validation, repair and commit hooks. Flue admission/settlement and GitHub responses are simulated; push transport targets a temporary local bare repository. Four separate tests exercise the actual Flue runtime with a fake provider. Live providers and watch polling are outside these local integration fixtures.

Screenshots at 1440px and 390px show the actual React UI with invented synthetic data, including expanded check output, external feedback and classifier findings. They demonstrate presentation, not live provider or backend acceptance. The temporary harness and screenshots remain outside tracked source. Final test results, source hashes and attachment paths are recorded in the manager handoff.
