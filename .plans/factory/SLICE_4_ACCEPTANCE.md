# Slice 4 acceptance record

Status: implementation in progress, September 6, 2026. Live acceptance: **NOT RUN**.

| Evidence                                                           | Result                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Final cumulative `npm run check`                                   | PASS: lint/layers/db/types; 255 unit files, 2,504 tests                                          |
| Other integration suites                                           | PASS: 9 files, 103 tests                                                                         |
| Git suite                                                          | PASS: 6 files, 47 tests                                                                          |
| Web/server/docs build, package validation, smoke and formatting    | PASS                                                                                             |
| Layer 1 isolated typecheck and tests                               | PASS: 59 tests, head `03ac1826`                                                                  |
| Layer 2 / Layer 3 isolated typecheck and tests                     | PASS: 47 at `012fe5ab` / 72 at `5bb4a1ac`                                                        |
| Linux host lifecycle / factory matrix                              | Pending: 49 host cases (37 Codex, 12 optional) and 6 factory cases                               |
| Final legacy integration                                           | 9 cases running; pending                                                                         |
| Focused React UI checkpoint                                        | 88 tests; overlaps cumulative coverage                                                           |
| Actual synthetic React screenshots                                 | 12 captured; zero page errors, overflow or API mutations; parent inspected representative images |
| Two independent source reviews                                     | Clean on parent-reported manifest prefix `0a141c`                                                |
| Transitional UI/registry variants and four changesets              | Both independent reviewers clean                                                                 |
| Final documentation attestation                                    | Pending final results and standalone review                                                      |
| Parent pre-publication manager review                              | No findings; distinct from post-PR review                                                        |
| PR publication, CI and post-publication parent architecture review | Pending; no PR created                                                                           |
| CLI help/source compatibility                                      | Kilo installed 7.4.23 and temporary official OpenCode 1.18.29 verified; target auth unverified   |
| Real CLI/model/authentication/GitHub acceptance                    | NOT RUN                                                                                          |

Do not sum focused checkpoints and cumulative suites. No single all-inclusive
successful `npm run verify` invocation is claimed. See the handoff for the
writeback-fixture and Layer 1 typecheck failures and successful rechecks.

No live coding models, GitHub messages or deployments are authorized during
implementation. Later live exercises need separate authorization and must record
the tested source and CLI versions, finite limits, exact observed scenarios,
failures, recovery and unexercised cases. Public evidence must omit credentials,
private hosts and operator paths.

Earlier obligations are unchanged: Slice 1 operator-accepted deferrals remain
open; Slice 2/3/3.1 live acceptance remains pending, NOT RUN. Refer to the
[implementation plan](SLICE_4_IMPLEMENTATION_PLAN.md) for the full required matrix.

## Read-only target-host discovery

Parent-reported probe: `codex-cli 0.144.6`; OpenCode and Kilo did not resolve in
the default PATH or inspected common locations. This does not prove either is uninstalled. No system or model
settings changed. Target-host authentication and admission readiness are unproven.
The existing Codex support baseline remains 0.150.1 unless separately verified.

Optional executable-location clarification remains pending; no actual installation absence is claimed.

## Review fixes and remaining deterministic evidence

Review A P1/P2 findings have fixes and focused regression tests: original
executable identity remains pinned from admission through repairs and is checked
before `--version`; invalid credential failures are not cached. Both independent source reviewers cleared the fixes on the parent-reported
manifest prefix `0a141c`; lower-layer variants and changesets are also clean; final documentation attestation remains pending. Legacy attempts without executable identity retain
inspection/reconciliation but cannot start new repairs without fresh human release.

Linux optional-adapter shared-host lifecycle and the six-case production-path
factory matrix remain pending. The fourth unique test-only subprocess adapter
case was replaced by the accepted typed-registry/static-check/three-CLI matrix
substitution, with no fourth-ID child-process claim. Remaining Linux/legacy results and CI await the parent report. Provider-specific local checkpoints are in the
[OpenCode](SLICE_4_OPENCODE_COMPATIBILITY.md) and
[Kilo](SLICE_4_KILO_COMPATIBILITY.md) records; they are not aggregated here.
