# Factory validation and publication lifecycle

Status: implemented and locally verified; both independent static reviews clean,
September 7, 2026. Live acceptance remains pending. Operator approved this
direction after a retained candidate reached a generic delivery error before
checks or independent review had run.

## Product contract

The primary flow is **Plan → Code → Validate → Approve PR → Watch PR → Done**.
Neon shapes the brief with the human. Approval of a new plan explicitly includes
local checks, independent review, and bounded in-scope repairs. A settled coding
candidate enters validation automatically. Clean validation produces a reviewed
result; creating a draft PR requires a separate explicit decision against the
exact reviewed candidate and target.

Local validation works for manual intake without a GitHub connection or webhook.
Publication uses the registered repository's GitHub identity and existing
credential infrastructure through typed configuration. Intake and publication
readiness are separate; missing publication setup cannot block local validation.

Reuse the existing delivery controller, immutable evidence, supervised checks,
read-only reviewer, CLI repair adapter, progress judge, watches and durable app
state. Do not add another coding agent, parallel workflow engine or auto-merge.
Keep the existing two-repair and three-hour cumulative bounds across validation,
publication and subsequent PR feedback. Publication approval does not reset them.

## Authority and existing test records

- New releases explicitly bind validation policy, checks, reviewer and budgets;
  explain these before approval.
- Maintain one execution lifecycle. The operator confirmed that existing use is
  testing only; do not retain the old combined validation/publication workflow or
  add a separate legacy candidate admission flow.
- Existing test releases may require a fresh release under the current policy.
  Preserve readable audit history, briefs and retained work without silently
  upgrading authority or mutating the live runtime during implementation.
- Validation/publication decisions bind exact revisions and configuration.
  Changed payloads reject; matching replays reuse the receipt and budget.
- Clean validation waits for publication approval. No commit/push/PR effect
  crosses this boundary on a local-validation-only authorization.
- After publication approval, watched feedback may repair, recheck, independently
  review and update the same PR within shared bounds. Scope questions, changed
  authority, uncertainty and exhaustion stop for human attention. Merge and
  deployment remain outside factory authority.

## Interaction contract

Put the current phase, activity/blocker and one primary next action at the top.
Use plain phase labels. Completed stages collapse into inspectable history;
collapse preserves drafts, selection, focus and scroll. Technical identifiers,
execution configuration and full logs live in details.

Code shows activity and elapsed time. Validate distinguishes checks, independent
review and repairs. Review states distinguish Not started, Reviewing, Changes
needed, Blocked and Passed; empty findings alone never means Passed. Show findings
with the reviewed diff/evidence revision, distinct from human comments. Remove
unsupported prepared-revision jargon from the factory surface.

Reviewed changes come from the retained immutable base/tree, including a current
failed review, independently of GitHub readiness. Publication approval requires
that displayed revision and evidence to match its exact decision. This reuses the
existing 1 MiB evidence display bound; oversized or private content has an explicit
unavailable reason and cannot be approved through an incomplete preview. Per-file
review beyond that bound and diff navigation for older review revisions remain
follow-up work; their retained evidence and work are not deleted.

Approve PR shows reviewed changes, checks, findings, target and remaining budget.
The Create draft PR confirmation explains post-PR repair authority. Watch PR shows
the PR link, CI, feedback and repairs. Exact safe blockers have actionable
recovery/setup links preserving the task. Never enable intake implicitly to fix
publication setup. Preserve quiet polling from PR #429, multiline chat, keyboard
accessibility, responsive scrolling and the existing Xeneon/Miami visual language.

## Ownership and stack

The manager owns plans/deviations, integration, final product/architecture review
and stack publication. Astra-low implementers own disjoint backend/shared and
frontend code. Two independent Astra-low static reviewers must return clean for
each publication candidate before new PR creation.

1. Existing refresh-stability prerequisite: PR #429.
2. Single-lifecycle backend/contracts and phase-oriented UI, setup/recovery,
   evidence, tests and synthetic screenshots.

Published as [PR #429](https://github.com/pandemicsyn/neondeck/pull/429) →
[PR #430](https://github.com/pandemicsyn/neondeck/pull/430), grouped by the official
stack tool as [stack #431](https://github.com/pandemicsyn/neondeck/pull/431).
PR #430 includes three GitHub-hosted synthetic desktop/narrow screenshots.

The lifecycle layer includes backend and UI together: removing the old grant
endpoints changes their shared contract. Keeping an obsolete endpoint solely to
split these into two PRs would contradict the requested simplification. The
refresh prerequisite and lifecycle remain a linear stack.

Adjust layer boundaries only to keep each PR independently valid; record
substantive substitutions in this plan and the deviations ledger.

### Implementation interface

The existing `/api/factory-delivery` surface is extended with a repository
validation-policy read, automatic released-candidate validation, publication
readiness and exact publication grant for an existing pipeline. Current releases
explicitly submit validation policy. An old test release without that policy
requires a fresh release rather than opting old work in.

The delivery record binds local validation and a separate publication receipt.
Clean local validation exposes `awaiting-publication`.
Publication setup uses a narrow GitHub repository/token-reference identity, with
repository metadata resolved through the existing conditional HTTP cache. It
does not manufacture a webhook connection. Retain only historical record reading
needed for inspection and actionable recovery, not a second execution mode.

## Verification and acceptance

Prove manual/no-GitHub local validation, automatic release admission,
failed-check/finding repairs, clean-candidate publication wait,
exact publication authorization, stale/replay/restart handling and shared
budget continuity. Preserve post-PR feedback, progress judge and cancellation.

UI regressions and synthetic browser rehearsal cover the single lifecycle,
fresh-release recovery for old test records, all phases,
not-started versus passed reviews, actionable blockers, stale authorization,
post-PR feedback and draft preservation. Capture desktop and narrow screenshots
with synthetic data. Run focused tests, `npm run check`, and cumulative
`npm run verify` for the backend/frontend integration.

Use isolated runtime homes and mockdex/model/GitHub fixtures. Never bootstrap or
mutate the operator's live runtime during implementation tests. Do not publish
private hostnames, credentials, task contents or screenshots. Required secrets
hooks remain enabled. Live operator/provider acceptance after upgrade remains
pending until exercised and recorded; deterministic tests are not live acceptance.

### Implementation and review checkpoint

Both independent Astra-low reviewers cleared the frozen cumulative backend,
shared contracts and frontend before PR creation. Findings corrected during
review included stale validation settings, selecting an older release's phase,
preserving access to a single historical attempt, returning navigation to the
current attempt, exact accepted-publication receipt recovery, and binding approval
to a complete immutable diff (including lossless quoted-path fallback).

The manager confirmed normal module exports, Valibot at the new I/O boundaries,
factory-owned admission attention, separate validation/publication responsibilities
and reuse of the existing controller, CLI adapters, GitHub transport/cache and
diff components. No generic coding-run record gained factory-specific state.

Synthetic browser verification passed 16 full-page state presentations across
1440px and 390px, two actual-timer polling checks and eleven action checks, with
zero browser exceptions or observed horizontal viewport overflow. Draft text,
selection, focus, outer scroll and conversation scroll stayed stable during
delayed polling. All 45 captured UI source hashes were unchanged across the run.
The apparent narrow blank tail was a full-page screenshot artifact of nested
scrolling; viewport geometry and the primary action confirmed visible, reachable
review content. Screenshots are synthetic fixtures, not provider execution.

The production mockdex integration exercises no-GitHub automatic validation,
clean waiting with no commit/push/PR effects, typed publication setup without
intake enablement, exact publication consent and replay, then current-head CI and
review feedback leading to repair and the same PR under the original budget.
Providers and GitHub responses are simulated; Git worktrees, hooks and local
execution are real. Live acceptance remains pending below.

Final `npm run verify` passed on the frozen source: 3,134 unit tests, 47 Git tests
and 154 integration tests passed. The 16 Linux-only OpenCode/Kilo host and adapter
cases were skipped on macOS; that Linux matrix remains unverified by this run.
Lint, module layers, database consistency, app/docs typechecks,
dashboard/server/docs builds, package validation, packed-CLI smoke and formatting
passed. Earlier `npm run check` fixture failures were corrected; its checks and
complete unit suite passed in the cumulative verification run. The staged secrets
scan passed, and the required pre-commit hook remains enabled. Existing lint and
bundle-size warnings are not treated as proof of a warning-free repository.

The final manager architecture pass after publication confirmed that the published
implementation commit `fb8452e5` matches the frozen reviewed source, the stack base
is correct, and there are no new product/architecture findings. All nine PR #430
CI checks passed on that implementation head. Later documentation status updates
do not change the tested implementation or establish live acceptance.

### Live acceptance still required after upgrade

- Start a small manual task with a registered repository and working coding CLI,
  but no GitHub intake connection. Shape and approve its plan once. Confirm coding
  proceeds into checks and independent review automatically.
- Confirm that a clean result shows the exact reviewed changes, check results,
  findings and remaining repair budget before any branch push or PR creation.
- Configure publication from the repository and an existing private credential
  reference. Confirm that this neither enables intake nor reruns coding.
- Approve draft-PR creation. Leave actionable review feedback or exercise a
  controlled CI failure, and verify bounded repair, fresh checks/review and an
  update to the same PR without resetting the cumulative budget.
- Exercise a scope question or exhausted budget and confirm a clear human next
  action. Verify that the factory does not merge or deploy.
- Reload during active work and an unsent planning reply. Confirm phase, draft,
  scroll and controls remain stable, and retained evidence remains inspectable.

Use only operator-selected test work for this acceptance. Record the actual result
and any deferred checks; a synthetic screenshot is not evidence of a live provider
or GitHub operation.
