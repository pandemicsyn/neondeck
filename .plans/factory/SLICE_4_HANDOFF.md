# Slice 4 handoff

Status: source implementation complete; final packaging validation and documentation
review pending, September 6, 2026. **No Slice 4 PR created.**
Startup base: `00c3e3e5`; planning commit: `d0d57dcd`.

## Ownership

All implementation and independent review agents use Astra at medium effort.
The parent is orchestrator/manager only; assigned agents implement and fix source.

| Owner     | Scope                                                        | Status                                     |
| --------- | ------------------------------------------------------------ | ------------------------------------------ |
| Darwin    | Adapter contract, Codex compatibility and shared local host  | Source complete                            |
| Hilbert   | OpenCode adapter and conformance fixtures                    | Source complete                            |
| Dirac     | Kilo adapter and conformance fixtures                        | Source complete                            |
| Nietzsche | Generic factory release, admission and pinned repair routing | Source complete                            |
| Meitner   | Factory UI, screenshots, changesets and handoff              | Source complete; final docs review pending |
| Hegel     | Factory adapter integration suite                            | Suite complete; Linux result pending       |

## Stack and reviews

Four complete layers: core plus generic factory contract; OpenCode; Kilo; UI and
handoff. Each has its own changeset (minor, minor, minor, patch respectively).
The parent integrates and publishes only after both independent reviewers clear
the exact publication candidate. No PR has been created; CI and the separate
post-publication parent architecture review are pending.

Both independent static **source** reviews are clean on the source manifest
reported by the parent with prefix `0a141c`. Both reviewers also cleared the lower-layer transitional UI and registry
variants and all four changesets. Final documentation review remains pending.
The parent's private pre-publication manager review reports no findings on
product separation, Valibot boundaries, absence of `any`, module structure or UI.
This is not the separate post-PR architecture review.

The Layer 1 transitional task-detail variant adds only
`expectedCodingConfigFingerprint: null` to the old release call, preserving its
legacy Codex semantics. Layer 4 supersedes it with the full registry-driven UI
and displayed fingerprint binding. The final working-tree UI was not changed
for this staging variant.

## Confirmed verification

Parent-reported cumulative results, recorded separately to avoid double counting:

| Check                                           | Result                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Final `npm run check`                           | PASS: lint, import layers, database checks, types, 255 unit files / 2,504 tests |
| Other integration suites                        | PASS: 9 files / 103 tests                                                       |
| Git suite                                       | PASS: 6 files / 47 tests                                                        |
| Web/server/docs build, package checks and smoke | PASS                                                                            |
| Repository formatting                           | PASS                                                                            |
| Layer 1 isolated typecheck and focused tests    | PASS: 59 tests; head `03ac1826`; transitional caller correction included        |
| Layer 2 isolated typecheck and focused tests    | PASS: 47 tests; head `012fe5ab`                                                 |
| Layer 3 isolated typecheck and focused tests    | PASS: 72 tests; head `5bb4a1ac`                                                 |
| Linux shared-host lifecycle                     | 49 cases running: 37 Codex and 12 optional-adapter cases; result pending        |
| Linux factory adapter matrix                    | 6 cases running; result pending                                                 |
| Final legacy integration cases                  | 9 cases running; result pending                                                 |

No single all-inclusive successful `npm run verify` invocation is claimed.
Focused checkpoints overlap cumulative runs and must not be added to these totals.

Earlier cumulative unit execution reported 2,493 passes and four writeback-fixture
failures. QA corrected the fixtures; the final `npm run check` above passed.
Layer 1 initially failed isolated typecheck because the old release caller lacked
the newly output-typed fingerprint field; the one-field private variant corrected
it, and the isolated typecheck plus 59 tests passed. Earlier UI mock failures
were corrected before the passing focused reruns.

## Source fixes and compatibility

Reviewed corrections include B1 strict-tuple validation, B2 documentation
alignment, B3 executable-identity fixtures and Kilo ordering corrections. These
are incorporated into the cleared source/lower-layer evidence; they do not add
live acceptance or certify the still-running Linux and legacy tests.

Review A P1/P2 fixes have regression tests and are included in the clean source
reviews: the original executable identity remains pinned from admission through
repair and is checked before `--version`; invalid credential failures are not
cached. Historical attempts without captured identity keep inspection and
reconciliation, but new repairs pause for fresh human release. This narrowing
and the accepted fourth-ID subprocess validation substitution are recorded in
[DEVIATIONS.md](../DEVIATIONS.md).

Kilo installed 7.4.23 help/pinned source and OpenCode temporary official 1.18.29
binary help/tagged source are verified. Optional adapters initially support Linux.
See [OpenCode](SLICE_4_OPENCODE_COMPATIBILITY.md),
[Kilo](SLICE_4_KILO_COMPATIBILITY.md) and [operator guidance](SLICE_4_OPERATOR.md)
for exact provider/auth and workspace limits. Local CLI evidence does not prove
intended-host availability or authenticated execution.

## UI evidence

Registry-driven CLI/credential selection, structured readiness, displayed release
fingerprint binding and selected-versus-pinned identity are implemented. Stale
reads retain edits/evidence and disable mutations. Existing cancellation,
uncertain ownership, candidate/judge evidence and planning controls remain.

The focused UI checkpoint passed 88 tests across four suites; the final affected
Coding/TaskDetail rerun passed 65. Web typecheck and owned formatting passed.
Twelve actual React screenshots cover desktop 1440×1100 dark and mobile 390×844
light: setup, running, unsupported OS, cancelling, uncertain ownership and judge
intervention. Fixtures are visibly labeled; capture recorded zero page errors,
horizontal overflow and API mutations. Preview sources were removed and the
server stopped. The parent inspected desktop/mobile setup and desktop judge
images and accepted their presentation. Four representative images await later
PR attachment; none are published yet.

## Live acceptance boundaries

Slice 1 remains operator-accepted with recorded deferred checks. Slice 2/3/3.1
real model/Codex/GitHub acceptance remains pending, **NOT RUN**. Slice 4 real
model/authentication/GitHub acceptance is **NOT RUN**. Synthetic tests and
screenshots establish neither judgment quality nor live delivery. See the
[acceptance record](SLICE_4_ACCEPTANCE.md).
