# Slice 4 handoff

September 6, 2026: source implementation and recorded deterministic verification
complete. Published stack #410: draft [#406](https://github.com/pandemicsyn/neondeck/pull/406) → [#407](https://github.com/pandemicsyn/neondeck/pull/407) → [#408](https://github.com/pandemicsyn/neondeck/pull/408) → [#409](https://github.com/pandemicsyn/neondeck/pull/409). Published-source CI is green at the dated checkpoint below; live acceptance remains NOT RUN.
Startup base `00c3e3e5`; planning commit `d0d57dcd`.

## Ownership and stack

All implementation and independent review agents use Astra at medium effort.
The parent is orchestrator/manager only. Darwin owns the shared adapter host and
Codex baseline; Hilbert OpenCode; Dirac Kilo; Nietzsche generic factory integration;
Meitner UI, screenshots, changesets and handoff; Hegel factory integration tests.
All assigned source and test implementation is complete.

| Layer                             | Current head | Changeset                                      |
| --------------------------------- | ------------ | ---------------------------------------------- |
| Core and generic factory contract | `03b697f6`   | `factory-coding-adapter-foundation.md` (minor) |
| OpenCode                          | `2cce6b09`   | `factory-opencode-adapter.md` (minor)          |
| Kilo                              | `6255c952`   | `factory-kilo-adapter.md` (minor)              |
| UI and handoff                    | `473ab9ef`   | `factory-coding-selection-ui.md` (patch)       |

These are the published heads verified by the parent against reviewed local heads. All three lower-layer isolated typechecks passed again after restacking
and the Linux process/import correction. Earlier focused layer checkpoints passed
59, 47 and 72 tests respectively; those overlap other suites and are not added
to cumulative totals.

The Layer 1 transitional task-detail variant adds only
`expectedCodingConfigFingerprint: null` to the old release call, retaining legacy
Codex semantics. Layer 4 supersedes it with the full registry-driven UI and
actual displayed fingerprint binding. Both reviewers cleared the transitional
UI/registry variants and all four changesets.

## Final source reviews

Both independent static reviewers are **clean** on final v4: 1,335 source-manifest
files plus the Kilo fixture executable mode 755. Manifest:

`10d35b26816b5840d6e5f06d26bf2e643183c7309377a30ea847478bdaf5070c`

The parent's private pre-publication manager review reports no findings on
product separation, Valibot boundaries, absence of `any`, module structure or UI.
Both independent source and documentation reviews were clean before any PR was
created. The parent post-publication architecture review is also CLEAN: published
heads match reviewed local heads, bases are exactly main → #406 → #407 → #408 →
#409, and ownership, Valibot boundaries, module structure and CLI separation are
unchanged. CI passed at the exact published-source checkpoint below; later documentation heads require their own checks. Earlier source
manifests are superseded by final v4.

## Verification

Parent-confirmed results are separate checkpoints, not an additive grand total:

| Check                                 | Result and scope                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run check` v3                    | PASS: lint/layers/db/types and 256 unit files / 2,511 tests                                  |
| Linux shared-host suite               | PASS: 49/49 in 85.43 seconds; 37 Codex, 6 OpenCode, 6 Kilo                                   |
| Linux factory matrix                  | PASS: 6/6 in 337.58 seconds under Node 26.4.0                                                |
| Final lower-layer isolated typechecks | All three PASS after restack and process/import fix                                          |
| Legacy integration                    | PASS: 9 cases, 679 seconds, before the Linux process-table fix                               |
| Other integration                     | Earlier green baseline: 9 files / 103 tests                                                  |
| Git suite                             | Earlier green baseline: 6 files / 47 tests                                                   |
| Build/package/smoke                   | Earlier full web/server/docs build PASS; post-fix dashboard/package (1,223 files)/smoke PASS |
| Formatting                            | Repository check PASS; final documentation formatting checked separately                     |

The six factory cases cover initial coding plus pre-publication repair and initial
coding plus watched-feedback repair for each of Codex, OpenCode and Kilo. They use
real fake-CLI subprocesses and signed host receipts, not real coding models or
online authentication. Host coverage is 49 total, not 49 optional-provider cases.
No deterministic verification run remains in progress. The broader per-harness
scenario combinations not established by these suites are identified in the
[acceptance record](SLICE_4_ACCEPTANCE.md). No single all-inclusive successful
`npm run verify` invocation is claimed; focused tests overlap cumulative suites.

## Failures and successful rechecks

- An earlier unit run had 2,493 passes and four writeback-fixture failures. QA
  corrected the fixtures; final check v3 passed all 2,511 tests.
- Layer 1 initially failed isolated typecheck because its old release caller
  lacked the output-typed fingerprint field. The reviewed one-field transitional
  variant fixed it; the isolated tests/types and final typecheck rerun passed.
- Initial Linux diagnosis failed without heartbeat/receipt; the broad run was
  aborted, not passed. Process-table validation rejected kernel process-group
  IDs of zero. The narrow observation fix accepts those system rows while owned
  identities remain strictly positive. Baseline inspection accepted 142 rows;
  eight focused tests passed before the final full rerun.
- The next host run passed 42/49: 36 Codex and all six OpenCode. Six Kilo cases
  needed fixture mode 755. The remaining fixture used `/usr/bin/true`, whose GNU
  version output exceeded the intended bound; a short private fake replaced it.
  Both corrections were committed in lower layers and restacked. The final host
  rerun passed 49/49 and factory matrix passed 6/6.

The production correction spans four source/type-config files, including explicit
`.ts` raw-Node imports and the web compiler option permitting them. Final v4
reviews and post-fix checks cover this correction. Earlier legacy/integration/Git
results retain their stated baseline scope.

## Implementation and compatibility

The common host owns process/workspace lifecycle, finite limits, death proof,
credential cleanup and receipts. Factory release fingerprints and original
executable identities remain pinned through repairs, with identity compared before
`--version`. Invalid credential failures are not cached. Review A P1/P2 and B1
strict-tuple validation, B2 docs, B3 identity fixtures and Kilo ordering corrections
are included in final review evidence.

Historical attempts without executable identity remain inspectable/reconcilable;
new repairs pause for fresh human release. The accepted fourth-ID subprocess test
substitution retains compiled registration, closed schema IDs and static phase
checks alongside the three-CLI matrix. See [deviations](../DEVIATIONS.md).

Kilo installed 7.4.23 help/pinned source and OpenCode temporary official 1.18.29
binary help/tagged source are verified. Optional adapters initially support Linux;
Codex defaults remain unchanged. See [OpenCode](SLICE_4_OPENCODE_COMPATIBILITY.md),
[Kilo](SLICE_4_KILO_COMPATIBILITY.md) and [operator guidance](SLICE_4_OPERATOR.md)
for exact auth and workspace limits. No real-provider acceptance is inferred.

## UI and remaining handoff

Registry-driven setup, readiness/authentication labels, release fingerprint binding
and selected-versus-pinned run identity are implemented. Failed refreshes retain
edits/evidence and disable mutations. Cancellation, uncertain ownership, candidate
and judge evidence, and planning controls remain available.

The focused UI checkpoint passed 88 tests; the affected Coding/TaskDetail rerun
passed 65. Twelve actual synthetic React screenshots cover setup, running,
unsupported OS, cancelling, uncertainty and judge intervention, at desktop
1440×1100 dark and mobile 390×844 light. Capture recorded no page errors,
horizontal overflow or API mutations. Preview sources were removed and server
stopped. The parent inspected representative setup/judge images. Four actual synthetic images were uploaded and verified in the #409 body.

Live acceptance and the explicitly unestablished scenario matrix remain;
follow-up documentation CI is shown on the PR. This publication-status documentation delta awaits review. Slice 1
operator-accepted deferrals and Slice 2/3/3.1 pending live obligations are unchanged.

## Published CI checkpoint — September 6, 2026

All nine checks succeeded on each exact published head:
[#406](https://github.com/pandemicsyn/neondeck/pull/406) `03b697f6`,
[#407](https://github.com/pandemicsyn/neondeck/pull/407) `2cce6b09`,
[#408](https://github.com/pandemicsyn/neondeck/pull/408) `6255c952`, and
[#409](https://github.com/pandemicsyn/neondeck/pull/409) `473ab9ef`.
Checks: Lint, Typecheck, Build app, Build docs, Validate npm package, TruffleHog,
CodeQL and two Analyze checks. At this check there were no PR reviews or inline
comments on any of the four PRs; the independent agent reviews are recorded
separately. These results certify these source heads only. Later documentation
commits do not inherit their CI status; linked PRs show follow-up/current CI.
