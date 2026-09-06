# Slice 2 acceptance record

## Current decision — 2026-09-06

The operator explicitly accepted Slice 1 and deferred its remaining unchecked cases, then authorized merging the stack after the acceptance updates are integrated. This decision supersedes the earlier requirement to complete both live acceptance gates before any Slice 2 merge. It does not mean that the deferred checks passed or that the stack has already merged.

| Area                                | Recorded status                                      | Remaining obligation                                                                     |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Slice 1                             | Operator-accepted with deferred checks               | Preserve the unperformed cases below and record their eventual outcomes.                 |
| Slice 2 local implementation        | Historical verification and review checkpoint passed | Rebased revisions require their own manager verification and CI record.                  |
| Slice 2 real Codex acceptance       | **PENDING — NOT RUN / NOT PASSED**                   | Complete the bounded local adapter exercise below as a post-merge acceptance obligation. |
| Slice 2 Linux/VM and remote workers | Deferred later work                                  | Separate from the local Codex exercise; no remote acceptance is claimed.                 |

This documentation and merge authorization do not authorize live provider, GitHub write, SSH or deployment tests. Arrange the bounded exercise separately. Record actual results before changing any unchecked item or acceptance status.

## Slice 1 acceptance decision

[PR #396](https://github.com/pandemicsyn/neondeck/pull/396), merged as `2ca0edfded3618824636bb40fa166bc35025c681`, records **partial observed live evidence with zero releases**, not complete live test coverage. See the [September 6 Slice 1 record](SLICE_1_HANDOFF.md#september-6-2026--merged-build-and-partial-live-acceptance). The subsequent operator decision accepts that bounded result and defers the remaining cases; it does not change the recorded observations.

The partial exercise covered real GitHub admission, live triage/planning, opted-in managed status updates, graceful restart/replay and selected anonymous route probes. Its isolated-home compatibility boundary and routing limitations remain as documented in Slice 1. The following remain unperformed or unproven, despite operator acceptance:

- [ ] Live human iteration, version comparison and exact-version release.
- [ ] Post-release recovery and revocation, including crash windows beyond the observed graceful restart.
- [ ] Attributed replies, approved questions, writeback repair and missed-delivery recovery.
- [ ] Full manual-source live acceptance.

Do not infer exact-release or post-release proof from the observed model draft repair or zero-release restart. Existing-home migration and broader external route coverage are not established by the bounded rehearsal.

## Historical Slice 2 evidence — before the main rebase

The published feedback candidate passed cumulative `npm run verify` on Node 26.4.0: **2,156 tests** (1,981 unit, 47 Git, 128 integration), lint, import layers, migration consistency, TypeScript, builds, package validation, installed-package smoke and formatting. The verification log SHA-256 is `77f6e66f6d39baa2400f0dcd65a2aa5c2b40e0340882b3a9d11409f5dd182fbe`. These checks were not rerun to write this document.

Two independent static reviewers and the manager accepted the published feedback candidate and reviewed the evidence addendum. The local host suite contained **34 actual local-process tests**, including bounded shutdown and checkout-root protection; provider execution remained synthetic/mockdex only. The separate mockdex fixture had 32 tests. Those tests and the bridge's local candidate/cancellation flows establish local process behavior, not real Codex authentication or model compatibility. See the [feedback checkpoint](SLICE_2_HANDOFF.md#pr-feedback-verification-checkpoint--2026-09-06).

The recorded CI snapshot at **2026-09-06 17:32:51 UTC** contained **36 passing checks**, nine on each old published head:

| PR                                                       | Published head at that checkpoint          | Passing CI checks |
| -------------------------------------------------------- | ------------------------------------------ | ----------------- |
| [#391](https://github.com/pandemicsyn/neondeck/pull/391) | `6687416b8a3858a9497a2ba21eebf9fa797406dd` | 9                 |
| [#392](https://github.com/pandemicsyn/neondeck/pull/392) | `fd4f3d459aee5f7e9b916339e8f7318e4144e8f8` | 9                 |
| [#393](https://github.com/pandemicsyn/neondeck/pull/393) | `1084953a375bd4d178f1b5514aa901cdb147270e` | 9                 |
| [#394](https://github.com/pandemicsyn/neondeck/pull/394) | `f613461387bb7bd8a647f014a1ef99265680ccaa` | 9                 |

These identities bind the historical review/CI record. They do not certify the rebased stack, later changes, live provider behavior or deployment. The manager records new revisions, verification and CI separately after integration.

Earlier on September 6, the plan required both live Slice 1 acceptance and real Codex smoke before any Slice 2 merge. At the published checkpoint both were pending. The operator's later acceptance/defer-and-merge decision supersedes those merge conditions; preserve that history without treating the real Codex exercise as passed.

## Slice 2 acceptance after merge

Use the [operator guide](SLICE_2_OPERATOR.md) for private configuration and controls. This is a bounded local exercise through the actual factory adapter, not a direct CLI invocation that bypasses factory admission. All boxes start unchecked.

### Setup and exact release

- [ ] Record the tested application revision, Node/OS versions and supported `codex-cli 0.150.1`. Confirm the configured absolute executable resolves to that version. Missing or unsupported Codex must fail readiness; mockdex must not substitute.
- [ ] Use an isolated runtime home and a trusted test repository, with an app-managed checkout pinned to its base commit. Record a before snapshot of primary-checkout head/status/content for comparison. No private repository identifiers belong in the public result.
- [ ] Select the explicit model, credential-reference kind and allowlisted executable search path. Keep credential values private. Confirm per-attempt harness home/scratch and finite time/output limits, with one writer and `workspace-write`; this is not an OS sandbox.
- [ ] Shape a small, reviewable task, resolve decisions and human-release the exact spec version/hash. Record privately how release, attempt and context identities match. Ordinary chat must not launch coding. With coding explicitly enabled, eligible release dispatch is automatic; no extra launch approval is implied.

### Completion and retained review

- [ ] Observe actual adapter invocation and authentication with the selected model. Capture bounded, sanitized summaries of `thread.started`, item events, provider session identity and `turn.completed` or `turn.failed`. A new attempt must use a fresh session; retain actual identities privately.
- [ ] Confirm terminal receipt, process death and collected Git evidence agree before displaying a candidate. Record pinned base/head and captured receipt/diff evidence without publishing private source or run identifiers.
- [ ] Inspect changed and untracked files in the retained checkout using the existing read-only review surface. Distinguish the capture from current worktree changes, which may have changed since capture. Candidate completion is not task verification, approval or publication; record the human review outcome separately.
- [ ] Compare the primary-checkout snapshot after completion; head and tracked/untracked content remain unchanged. Confirm credential material is absent from public logs/UI and that per-attempt credential cleanup has the expected outcome without exposing its contents.

### Cancellation, failure and ownership

- [ ] In a separately bounded attempt, cancel a running task with a child dev server when the authorized test task includes one. Observe durable cancellation, bounded TERM/KILL handling and verified death of the owned CLI and child group before writer release. Record elapsed cleanup time and credential cleanup outcome, not raw process or credential identifiers.
- [ ] Record failed execution or rejected launch behavior: bounded errors and retained evidence, primary checkout unchanged, and no automatic retry. Label any intentionally injected failure as synthetic; do not present it as real provider-failure evidence.
- [ ] Confirm uncertain receipt/process ownership remains `needs-reconcile` and retains the writer reservation. Reconciliation follows the known attempt and does not blindly launch a replacement. Do not manually delete receipts, credentials or ownership state to manufacture recovery evidence. Cite existing mock coverage where applicable and explicitly mark any unexercised live case.

### Restart scope and signoff

- [ ] Decide and record whether controller restart during a running attempt or cancellation is included in the separately authorized local exercise. If included, verify recovery follows the same supervisor/receipt with no duplicate writer and completes the same cancellation intent. If omitted, record it as deferred with the manager's rationale; historical mock tests do not become live restart evidence.
- [ ] Keep local controller recovery separate from Linux/VM deployment, remote workers and existing-home migration, which remain later acceptance work.
- [ ] Record failures, repairs and repeat checks. Operator and manager review the evidence, identify remaining limitations and explicitly sign off the bounded real Codex outcome. No CLI success event alone establishes acceptance.

## Sanitized evidence template

Copy this template for each exercise. Use `PASS`, `FAIL`, `NOT RUN` or `DEFERRED`; an empty field is not a pass. Retain raw evidence privately. Do not publish hostnames, private paths/IPs, repository or issue identities, work/run/session identifiers, credentials or private code. Use neutral aliases and a sanitized artifact digest if useful.

| Field                                    | Result to record                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Date/time (UTC), scope and authorization | Pending; state which local scenarios were authorized.                                                                           |
| Application revision and build           | Pending; exact public code revision and check result.                                                                           |
| Runtime and CLI                          | Pending; Node/OS and actual Codex version.                                                                                      |
| Configuration summary                    | Pending; public-safe model label, auth kind/reference alias, permission profile and finite budgets; no values or private paths. |
| Exact release and admission              | NOT RUN; version/hash matching verified privately, one attempt/writer outcome.                                                  |
| Events, session and terminal receipt     | NOT RUN; event types, fresh-session check, receipt/process agreement; no raw identities.                                        |
| Candidate and human review               | NOT RUN; retained diff/current-worktree distinction and review outcome, separate from task verification.                        |
| Primary checkout and credential cleanup  | NOT RUN; before/after comparison and cleanup result without sensitive contents.                                                 |
| Cancellation and owned-child death       | NOT RUN; bounded timing and confirmed termination/ownership outcome.                                                            |
| Failed or uncertain attempt              | NOT RUN; retention, reconciliation/no-retry result and real-versus-synthetic provenance.                                        |
| Controller restart                       | NOT RUN; tested scope or explicit deferral/rationale.                                                                           |
| Failures and repeats                     | Pending; sanitized defect description, repair revision and repeated result.                                                     |
| Evidence references                      | Pending; sanitized artifact labels/digests only.                                                                                |
| Operator signoff                         | PENDING for real Codex; date, role and bounded decision.                                                                        |
| Manager signoff                          | PENDING for real Codex; date, role, accepted scope and deferred checks.                                                         |
| Remaining obligations                    | Real Codex acceptance pending; carry forward any deferred cases and later remote acceptance separately.                         |
