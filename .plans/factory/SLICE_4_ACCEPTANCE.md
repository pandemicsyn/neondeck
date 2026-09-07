# Slice 4 acceptance record

September 6, 2026: recorded deterministic verification complete; final docs review
and publication pending. **No PR created. Live acceptance: NOT RUN.**

## Confirmed evidence

| Evidence                                           | Result                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Final `npm run check` v3                           | PASS: lint/layers/db/types; 256 unit files, 2,511 tests                                      |
| Linux host suite                                   | PASS: 49/49, 85.43 seconds; 37 Codex + 6 OpenCode + 6 Kilo                                   |
| Linux factory matrix                               | PASS: 6/6, 337.58 seconds, Node 26.4.0                                                       |
| Final isolated typechecks                          | All three lower layers PASS after restack/process/import fix                                 |
| Legacy integration                                 | 9 PASS, 679 seconds, before Linux process-table fix                                          |
| Other integration / Git                            | Earlier baseline: 103 tests / 9 files and 47 tests / 6 files PASS                            |
| Build/package/smoke                                | Earlier full web/server/docs build PASS; post-fix dashboard/package (1,223 files)/smoke PASS |
| Formatting                                         | Repository check PASS; final documentation check separate                                    |
| Source static reviews                              | Both independent reviewers CLEAN on final v4, 1,335 manifest files plus mode 755             |
| Lower transitional variants / changesets           | Both reviewers CLEAN                                                                         |
| Parent pre-publication manager review              | No findings; not the post-PR review                                                          |
| UI screenshots                                     | 12 actual synthetic React captures; no page errors, overflow or API mutations                |
| Final docs review / PR / CI / post-PR architecture | Pending                                                                                      |
| Real coding-model/authentication/GitHub acceptance | NOT RUN                                                                                      |

Final source manifest:
`10d35b26816b5840d6e5f06d26bf2e643183c7309377a30ea847478bdaf5070c`.
Current restacked heads before this documentation update:
`03b697f6` / `2cce6b09` / `6255c952` / `1042d0e5`.
Do not add overlapping focused checkpoints to cumulative totals. No single
all-inclusive successful `npm run verify` invocation is claimed.

## What the synthetic evidence establishes

For each CLI, the Linux factory matrix covers initial coding followed by a
pre-publication repair and initial coding followed by watched-feedback repair.
These are actual fake subprocesses with signed host receipts. The shared-host
suite and separate parser/conformance fixtures cover their recorded failure,
identity, isolation, cancellation and ownership cases. The suites are complete;
no deterministic run is still pending.

The plan's broader combinations of every crash window, judge failure pattern,
publish uncertainty, cleanup outcome and feedback edge case for every CLI are
**not established as a complete per-harness matrix**. Shared generic suites and
six routing cases do not prove that full Cartesian coverage. This is an explicit
remaining matrix obligation, separate from the passing named runs and from live
acceptance. No fourth unique adapter-ID subprocess coverage is claimed; the
accepted substitution uses typed registry conformance/unknown rejection, static
phase checks and the three registered CLI matrix.

## Failure/recheck record

An early unit run reported four writeback-fixture failures; QA corrections were
followed by the passing final 2,511-test run. Layer 1's old release caller initially
failed typecheck; the reviewed null-fingerprint variant and later isolated reruns
passed. Initial Linux execution failed without heartbeat and its broad run was
aborted. Kernel zero process-group observations were rejected; the narrow schema
fix preserves positive owned identities. The subsequent host run passed 42/49;
six Kilo fixtures lacked executable mode and `/usr/bin/true` produced longer GNU
version output than intended. Mode 755 and a short private fake corrected those
fixtures; the final host rerun passed 49/49 and factory run passed 6/6.
See [handoff](SLICE_4_HANDOFF.md) for checkpoint scope and reviewed corrections.

## Compatibility and live boundaries

Kilo installed 7.4.23 help/source and temporary official OpenCode 1.18.29
help/source are verified; see their [Kilo](SLICE_4_KILO_COMPATIBILITY.md) and
[OpenCode](SLICE_4_OPENCODE_COMPATIBILITY.md) records. This does not establish
intended-host installed CLI or authenticated provider readiness. The read-only
intended-host probe found Codex 0.144.6, outside the preserved 0.150.1 baseline;
OpenCode/Kilo PATH/common-location misses did not prove installation absence.

Legacy attempts without executable identity retain inspection/reconciliation;
new repairs need fresh human release. Linux managed-state restrictions and the
24 exact Kilo autoload guards remain; harmless `.kilo/skills` is allowed. Provider
permissions are not an OS sandbox. Real authentication, coding quality, judged
repairs, delivery and operator acceptance remain NOT RUN. Slice 1 accepted
deferrals and Slice 2/3/3.1 pending live obligations remain unchanged.
