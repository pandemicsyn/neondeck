# Slice 2 local implementation handoff

**Current decision (2026-09-06): Slice 1 is operator-accepted with unchecked cases deferred; the user authorized stack merge after the acceptance updates are integrated.** Real Codex acceptance is **PENDING, NOT RUN**, as a post-merge obligation. See the [Slice 1 acceptance decision](SLICE_2_ACCEPTANCE.md#slice-1-acceptance-decision) and [Slice 2 acceptance after merge](SLICE_2_ACCEPTANCE.md#slice-2-acceptance-after-merge) for the superseded merge-gate history, evidence boundaries and deferred cases. This decision does not authorize live tests.

## Delivered scope

Exact human releases can enter an explicitly enabled local Codex executor. Each attempt has a durable reservation, immutable context, managed worktree and branch, private harness home, selected credential reference, supervised process group and retained evidence. Neon continues to own triage and model/human shaping; Codex owns coding. No new coding-agent loop is introduced.

The Factory workbench exposes readiness/configuration, newest-first attempt history, admission attention, session/provenance, bounded logs, cancellation, reconciliation and the existing read-only worktree diff viewer. The viewer clearly distinguishes current worktree changes from immutable evidence captured at completion. Candidate means awaiting human review; the work remains queued and is not accepted, verified or published. Existing opted-in GitHub status comments receive finite coding facts through the existing cached transport; no private context or new consent is published.

## Reviewable stack

| Branch                        | Responsibility                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| agent/factory-s2-00-plan      | Plan, corrected Slice 1 landing status and mandatory merge gate.                                               |
| agent/factory-s2-01-runs      | Validated durable run records, single-writer reservation, provenance and ownership checks.                     |
| agent/factory-s2-02-codex     | Local host, Codex CLI adapter, immutable evidence, launch/cancel gate and test-only mockdex.                   |
| agent/factory-s2-03-workbench | Released-brief dispatch, guarded worktrees/diffs, API/UI, issue status, integration coverage and this handoff. |

The manager used the repository's official `gh stack` workflow. Implementers used isolated worktrees; two dedicated independent static reviewers inspected the final candidates and fixes before PR publication. The manager checked product/plan adherence. The required gitleaks pre-commit hook must pass on every commit; it is never bypassed. The stack was initially published as draft PRs and subsequently marked ready at the user's request. At that publication checkpoint both merge gates were pending; the later operator decision in the acceptance record supersedes those merge conditions. Remote CI and feedback are checked separately and are not asserted complete by this document.

## Initial local verification checkpoint

Node 26.4.0, locked dependencies, isolated runtime homes and Git repositories. At the initial candidate checkpoint, before PR feedback revisions, `npm run verify` passed: **2,113 tests** (1,943 unit, 47 Git, 123 integration), lint, import layers, migration consistency, TypeScript, dashboard/server/docs builds, package manifest and installed-package smoke, and formatting.

These counts and the review evidence below describe that initial candidate, not the post-feedback tree. See the post-feedback checkpoint below for the combined local result; GitHub CI remains a separate publication check.

The initial 29 host tests used actual local processes, including controller/supervisor loss, retained ownership, child server cancellation, output limits, immutable candidate retries, filter/submodule rejection, and compiled workers executed from an actual npm package under `node_modules`. The separate 32-test mockdex fixture never calls a model. Three bridge integration flows use the real host: released brief to retained candidate; release withdrawal while the actual anchor waits before authorization with no CLI launch; and cancellation after authorization with confirmed group death and credential cleanup. The primary checkout stays unchanged and generic forced cleanup cannot discard factory work.

The full check caught renderer tests being included in the npm package. Moving those tests to the established backend test location corrected packaging without changing production code or weakening the package check. Independent reviewers inspected that final delta too.

UI screenshots use the actual components and synthetic data at 1,440px and 390px widths: retained candidate/diff, running, reconciliation, setup and admission attention. Screenshots accompany the workbench PR; they are not evidence of live provider or VM operation.

## PR feedback verification checkpoint — 2026-09-06

The corrections for all 13 review comments across PRs #391–#394 passed two independent static reviews and the manager's implementation/product-plan review. Reviewers also caught and rechecked blank CLI-version caching and double-dot-prefixed path containment edge cases. The stack test conflict preserves both ownership and pagination coverage.

Cumulative `npm run verify` passed on Node 26.4.0: **2,156 tests** (1,981 unit, 47 Git, 128 integration), lint, import layers, migration consistency, TypeScript, dashboard/server/docs builds, package manifest and installed-package smoke, and formatting. The stricter expiry schema exposed one old writeback fixture with a date-only timestamp; correcting that fixture retained all assertions and production validation. The host suite now has 34 actual local-process tests, including shutdown grace beyond five seconds and no-write checks for both checkout roots. Provider execution remains synthetic/mockdex only.

This checkpoint supersedes the initial local counts for the feedback candidate. The existing stacked PRs remain ready for review; publication and final-head GitHub CI are checked separately. Required commit-hook and range secret scans remain mandatory. At this historical checkpoint both live acceptance merge gates remained **PENDING**. The later operator decision supersedes those merge conditions; it does not change the test outcomes or establish real Codex acceptance.

## Explicit limits and next acceptance

- Real Codex 0.150.1 authentication/model behavior remains untested here. A real smoke through the local adapter remains a post-merge acceptance obligation under the operator's subsequent merge authorization. No real provider, SSH or deployment exercise was performed or is authorized by this documentation correction.
- Slice 2 Linux process observations, VM deployment and remote-host acceptance remain later work. Keep that later scope separate from the local Codex obligation and the unchecked Slice 1 cases explicitly deferred by the operator.
- Local POSIX process isolation assumes trusted repositories; it is not an OS sandbox. Remote execution hosts remain later work.
- Executable Git clean/process filters and submodules are unsupported for initial evidence collection. Uncertainty retains/quarantines ownership instead of running unowned subprocesses or discarding work.
- A shared host gate orders cancellation and provider authorization. Database cancellation is recorded first; no atomic transaction across SQLite, filesystem and process creation is claimed. Stale gates are not stolen.
- All factory worktrees remain retained. Seven-day cleanup attention and 30-day evidence dates are metadata, not automatic deletion authority. Explicit reviewed discard, independent checks/repair, PR publishing and remote workers remain later slices. No automatic retry or resume-last-session exists.

Use the [operator guide](SLICE_2_OPERATOR.md) for private setup and controls. Keep credentials, hostnames, SSH configuration and raw private operational evidence outside this public repository and PRs. Record the post-merge real Codex result using the [acceptance template](SLICE_2_ACCEPTANCE.md#sanitized-evidence-template), with operator/manager signoff, failures fixed and rechecked, and any unperformed cases still explicit.
