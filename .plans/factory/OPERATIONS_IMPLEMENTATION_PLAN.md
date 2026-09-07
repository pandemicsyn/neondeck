# Factory onboarding and observability

Status: implementation complete; independent static reviews clean, September 7, 2026.
Initial delivery used a draft stack above #412/#413. The stack is now ready for
review, with merge authorized after clearance; live acceptance remains separate.

This user-requested slice follows the UI polish stack (#412, #413) and precedes
further factory expansion. Slice 5 (Linear) and Slice 6 (remote execution) keep their
numbering. The manager orchestrates and performs final product/architecture review;
implementation and independent static reviews use Astra at low reasoning.
No new PRs may be created until two independent static reviewers are clean.

## Outcome

An operator can optionally configure the factory during `neondeck init`, understand
readiness without starting a coding job, and answer: what happened to this task,
who authorized it, why is it waiting, and what happens next?

## Scope and ownership

1. **Observability foundation:** typed, bounded, local structured diagnostics;
   durable correlation between work/release/run/submission/delivery/effect IDs;
   phase and external-operation timing spans; worker health across success,
   failure, scheduling, shutdown and restart. Reuse existing domain records as
   authority. Preserve useful sanitized error codes and correlation instead of
   replacing failures with generic warnings. Do not log request bodies, prompts,
   credential values, raw environment or private paths by default. Persisted audit
   remains independent of optional trace export and sampling.
2. **Optional CLI onboarding:** skip or resume factory setup; reuse typed existing
   configuration/readiness services for intake/repository/GitHub/adapter/model/
   credential references. Keep secrets local. Explain webhook versus dashboard
   routing and human release/publication gates. Present a review before applying
   configuration. Never grant release/publication authority or run coding as a
   side effect of setup. Support existing installations without resetting unrelated
   configuration or silently enabling additional automation.
3. **Operator reads and diagnostics:** a bounded task timeline joining existing
   authority/evidence records, with stable identities, actor attribution where
   actually recorded, exact revision bindings and evidence references. Do not
   fabricate historical events/actors. Health reports show last successful tick,
   stale/not-running distinctions, pending age, known next retry, remaining budgets
   and unresolved effects with actionable explanations. Add factory doctor and a
   redacted diagnostic export whose exact contents can be previewed before writing.
   Export is local-only; no automatic remote upload or credential-bearing paths.
4. **Dashboard:** integrate task history and global health with the existing factory
   workbench. Progressive details, useful empty/error/loading states, bounded
   keyboard-scrollable evidence, responsive layouts, copyable correlation IDs and
   diagnostic preview/download. Preserve the recently fixed scrolling and draft
   behavior. Reuse shared typed APIs; do not duplicate backend diagnosis in React.

## Architecture and delivery

Keep authority in existing factory/coding/delivery modules and app SQLite; do not
copy Flue transcripts into app state or introduce a second agent runtime. Put
observability contracts, persistence, instrumentation and read projections in
separate focused modules. Validate IO with Valibot, including persisted records,
query bounds, environment options and export contents. No `any` escape hatches.
Instrumentation must not change retries, limits, authority, cancellation, effect
idempotency or external API traffic. Avoid unbounded logs/events and repeated
warning floods. Trace export is opt-in and independent of durable authority data.
Document retention and its limits explicitly. Existing GitHub conditional reads
and caches remain the path for provider facts.

Implemented branch layers: observability foundation; diagnostics API/CLI helpers;
optional onboarding and CLI registration; operator UI and final evidence. Build above the unmerged UI polish stack,
using official `gh stack`. Each layer has relevant tests/docs/changesets. Normal
secret-scanning commit hooks remain mandatory. The initial implementation request was draft-only; the maintainer subsequently
authorized merging the cleared stack on September 7, 2026.

## Verification and acceptance

- Meaningful unit/integration coverage of skip/resume/setup validation, unchanged
  authority, worker lifecycle/restart, correlation, redaction, pagination,
  diagnostic failures and exact preview/export behavior.
- Full `npm run verify` for the integrated slice, plus focused diagnosis as needed.
- Two independent static source/docs reviews, followed by manager product and
  architecture review before publication.
- Actual browser interaction/screenshots with synthetic data at companion
  2560x720, desktop 1440x900 and mobile 390x844 in both themes. Verify task timeline,
  health, pending/error states, scrolling and diagnostic preview/download.
- Local isolated-home CLI exercise, without real credentials or external effects.
- Existing real-provider/GitHub/VM acceptance obligations remain pending. Synthetic
  tests or mock CLI checks do not satisfy those obligations.

## Handoff ledger

Implementation and verification evidence is recorded below.
Deferrals and sequencing changes also belong in `.plans/DEVIATIONS.md`.

### Review checklist for this slice

- Onboarding skip makes no factory writes. Re-running setup preserves existing
  policy, connections, budgets and unrelated runtime settings. Stale previews
  cannot overwrite newer configuration. Coding and publication stay separately
  authorized. Secret inputs are never echoed in previews, errors or checked-in
  artifacts. Supported installed CLI probes do not claim authenticated acceptance.
- Health distinguishes not observed, running, stopped, overdue and failed. A long
  valid in-flight tick must not be mislabeled as dead simply because it exceeded
  the idle poll interval. Unknown retries are explicitly unknown. Process-local
  health must not masquerade as durable recovery evidence.
- Timeline pagination has stable ordering even when timestamps tie; repeated
  effects are not invented as new approvals. Current projections and durable
  historical events are labeled honestly. Source actors are not upgraded to
  authenticated human identities. Evidence links resolve to the corresponding
  task/run/revision, not arbitrary filesystem URLs.
- Read-only doctor/export must not tick workers, admit a model, publish comments,
  mutate authority or refresh GitHub unnecessarily. A failed dependency is shown
  as partial/unavailable, not silently healthy. Diagnostic snapshots have a bounded
  schema and shareable summaries omit raw config, prompts, paths and credentials.
- Export downloads exactly the previewed snapshot even if background state changes.
  Copy/download failures are visible. Redaction tests use sentinel secrets and
  path-bearing/error-bearing inputs. No automatic network telemetry is introduced.
- Logging failure cannot mask a business result or cause a repeated external
  effect. Trace records have bounded retention; authority history has separate
  retention. Correlation IDs survive retries/restarts through existing domain IDs.

### Instrumentation scope

Use installed Flue 2.0.3 `guide/observability`: its runtime observer is live-only,
while submission identities correlate with existing retained app records. Native
Flue continues to own model/tool event details. This slice instruments Neondeck's
phase and external-operation boundaries and provides local content-free diagnostic
export; it does not build another model telemetry implementation. A remote
OpenTelemetry/Sentry/Braintrust exporter is not enabled. Such integrations can use
Flue's existing instrumentation later, after explicit provider/content policy.

### Implementation checkpoints

- Optional CLI setup source completed. Focused onboarding/config-lock verification:
  27 passing tests, scoped lint/format. Real source CLI exercised in an isolated
  runtime home with inherited credentials removed: help, PTY skip with byte-exact
  unchanged config, doctor JSON, synthetic task preview and exact private `0600`
  export. Zero releases/coding runs. See [onboarding record](OPERATIONS_ONBOARDING.md).
- Initial dashboard source checkpoint: 27 passing focused tests; synthetic App
  browser matrix covered companion/desktop/mobile in both themes, timeline
  pagination/keyboard scrolling, clipboard and byte-exact preview/download.
  Final read-only evidence and coverage checks are recorded below.
- Early independent static review identified timeline refresh invalidation,
  cross-process setup mutation serialization, overdue-worker detection and a
  fractional-duration export mismatch. These findings were corrected and tested;
  this historical checkpoint preceded the final clean reviews below.

Diagnostic span success means the instrumented operation returned without throwing;
it is not proof that coding, a check, model judgment or publication was accepted.
Use the bound domain result and recorded human grant for that determination.
Completed spans are retained within diagnostic limits; a process crash can leave
no closing span. Worker liveness and durable pending/uncertain domain records,
rather than invented terminal trace events, explain that case.

### Cumulative verification checkpoint (before final review corrections)

A restricted verification attempt encountered process/listener restrictions and
was stopped; the same representative tests passed with required local process
and listener access (28 tests). An unrestricted integrated run then passed
269 unit files / 2,618 tests and 6 Git files / 47 tests. Its integration stage
failed synthetic adapter cases and was stopped for isolated diagnosis. This is
not a successful full `npm run verify` claim. Later review corrections require
fresh verification; the final results are recorded below.

Final-review corrections include factory API preconditions inside the shared
mutation lock, incomplete health coverage reported as attention, matching
current-health data in exports, bounded nonblocking regular-file export reads,
GitHub writeback receipts in the timeline, and repair target bindings distinct
from their source revisions. Both independent cumulative static reviews are clean.

### Final verification evidence

| Check                                                   | Result and scope                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` after review corrections                | PASS: lint, import layers, migration consistency, app/docs types, 269 unit files / 2,626 tests. The later doctor-formatting correction passed 5 focused CLI tests and scoped lint/format. |
| Git/worktree suite                                      | PASS: 6 files / 47 tests in the integrated checkpoint; no subsequent Git implementation changes.                                                                                          |
| Remaining integration suites                            | PASS: 8 files / 100 tests. Opt-in live-model smoke obligations remain unexecuted.                                                                                                         |
| Linux local host, factory coding and delivery           | PASS: 3 files / 63 tests, including all three local CLI host paths, three factory coding cases and nine delivery modes.                                                                   |
| Linux corrected adapter matrix                          | PASS: all 6 Codex/OpenCode/Kilo initial-coding and repair cases, with no platform skips.                                                                                                  |
| Corrected macOS Codex adapter case                      | PASS: one selected pre-publication repair case, 108.26 seconds; five cases filtered out in that targeted run.                                                                             |
| App/docs build, package validation and packed CLI smoke | PASS; package contains 1,249 files. Managed-entry runtime environment, IPv6 private health and public isolation smoke passed.                                                             |
| Repository formatting                                   | PASS at the build/package checkpoint; final ledger formatting is checked separately.                                                                                                      |

Linux tests used an isolated official Node 26.4.0 Linux aarch64 container, locked
public dependencies and synthetic CLIs with network access disabled during tests.
No host credentials, Docker socket or real factory VM were mounted. These are
execution-host and factory integration checks, not provider authentication or
live GitHub acceptance. No single all-inclusive successful `npm run verify`
invocation is claimed; its failed attempt and successful replacement stages are
recorded explicitly above.

### Final review and delivery ledger

- Both independent Astra-low static reviewers returned cumulative **CLEAN** against
  base `7ff29cbf`, including all corrective source changes and the existing adapter
  fixture correction. No new PR was created before those verdicts.
- Manager product/architecture review is clean: shared Valibot contracts validate
  persisted diagnostics, API inputs/outputs and export files; instrumentation,
  read projections, CLI setup, and UI remain separate owners. No production
  `any`/suppression escape hatch was added. Diagnosis reuses durable domain data
  and existing evidence viewers without changing authority or making GitHub calls.
- Final CLI formatter follow-up: server rebuild, 1,249-file package validation
  and packed CLI smoke all pass on the final source, including private/public
  listener isolation. Existing build warnings remain; this is not a warning-free
  build claim.
- Three lower branch archives independently pass app/dashboard typechecking:
  `agent/factory-observability` (`81ef3aac`),
  `agent/factory-diagnostics` (`1726037e`), and
  `agent/factory-onboarding` (`f3e92a40`). The final UI/evidence layer is
  `agent/factory-operations-ui`. Official `gh stack` extends the existing stack.
- Shared factory-lock/API-precondition follow-up: 20 targeted tests passed. The
  lock covers factory writers only; unrelated configuration writers remain the
  explicit limitation recorded in `DEVIATIONS.md`.
- Final dashboard focused suite: 31 passing tests across 3 files. Browser QA uses
  the real App and production styles with synthetic API data. It covered all
  three sizes in both themes, 24 additional loading/error/empty/stale scenarios,
  and lazy read-only coding/delivery inspection. A final frozen-contract delta at
  desktop/mobile in both themes verified both coverage flags, exact preview versus
  download bytes, valid repair targets and rejection of wrong bindings before
  fetching. No horizontal overflow, page exceptions or mutation requests in that
  final delta. Screenshots accompany the UI PR.
- Evidence remains local test evidence. No new live provider authentication,
  GitHub writeback/publication, real VM restart, screen-reader or exhaustive
  contrast acceptance is claimed. Existing slice acceptance ledgers remain open
  where already deferred. No remote telemetry service was configured.
- Secrets remain environment references in setup; the operator supplies values
  privately using the documented runtime-home environment workflow. CLI version
  probes establish availability only, not authentication. Existing release and
  publication grants are preserved, never created by setup.
- Mandatory secret-scanning hooks run on every commit. Initial delivery was a
  draft stack; the maintainer subsequently requested ready-for-review status and
  authorized merge after review feedback and checks are clear.

### September 7 merge review follow-up

The six-PR stack is #412, #413, #415, #416, #417 and #418. The maintainer
requested feedback fixes and merge after clearance. Live acceptance remains a
separate obligation.

The first feedback pass corrected test-only fixture construction, clarified
export availability across stack layers, rejected mismatched writeback bindings,
validated bounded delivery candidates before outcome filtering, and fingerprinted
the exact repository snapshot shown during setup. Two independent static reviews
were clean, and the combined source passed app/dashboard types and 52 focused
tests. Delivery health validates at most 201 candidates; omitted history remains
partial, including when an older active delivery is outside the window.

A refreshed automated review then identified span parentage and recovery-log
scope, judge reservation inspection, planning metadata identity/stage validation,
missing writeback-state validation, and explicit runtime PATH setup for CLI
wrappers. The corrections now preserve effect span parentage, separate controller
operations, scope recovery logs by stable effect/run/delivery/task identity, and
make judge reservations reference-only. Planning stages are validated before
filtering, row/JSON identities and receipt/event parents are checked, and null or
missing writeback states fail closed. Setup explicitly reviews the executable
search PATH without importing the shell environment.

Latest correction evidence: 99 tracing/writeback tests, 65 diagnostics tests,
28 onboarding tests, and 26 focused UI tests passed in their respective source
worktrees. These counts have overlapping supporting suites and are not added
into a distinct-test total. App/dashboard types and scoped lint/format checks
passed. Synthetic actual-App desktop/mobile QA confirms reservations perform no
inspection requests and settled evidence still opens; the new screenshot is
attached to #418. The harness and temporary worktrees are task-owned and cleaned
up after use. No new production UI style or authority change is involved.

These checks do not complete live acceptance. The existing factory-only lock and
bounded diagnostic history limitations remain. Merge authorization applies after
independent static reviews and GitHub checks clear; the linked PR states record
the final merge outcome.

The next review identified lifecycle precedence in diagnosis (closed tasks with
unresolved effects and obsolete terminal runs after a pause or new specification)
and expected lock contention reaching API clients as an internal error. The corrections prioritize reconciliation over lifecycle summaries, retain active
work, and bind terminal-run guidance to the current repository, specification and
non-withdrawn release. Failed writebacks require attention, and retained multiple
pipelines keep their budgets/effects without falsely claiming omissions. Expected
factory-lock contention maps to a typed 409 across the three config endpoints;
unexpected failures remain 500. The respective focused suites passed 84 diagnosis
tests and 58 configuration/lock tests, with types and scoped formatting/lint.
Independent review and CI remain the final merge gates.
The preceding combined checkpoint passed 222 tests across 15 files, app/dashboard
typechecking and repository formatting; it does not certify later source changes.

The final independent review added coexistence regressions: benign pending
writeback/planning and activity in another pipeline must not hide current coding
failure or consumed budget exhaustion. Reconciliation remains highest priority;
zero headroom reserved for active work is not classified as spent-budget failure.
These corrections do not change public contracts or execution authority.

A further review found that indexed diagnostic spans and worker records needed
identity checks against their validated JSON before task export or health reads.
The correction validates task, finish-time and worker bindings, including the
bounded pagination lookahead; inconsistent retained records fail closed. SQLite
continues to own the diagnostic sequence cursor. Setup model validation now
applies only when enabling intake, so an already-enabled installation can repair
unrelated configuration after a provider is removed. Coding authority and stale
preview protections remain unchanged. The preceding combined checkpoint passed
247 tests across 16 files, types and repository formatting; final correction
verification and review are recorded with the PRs. Live acceptance remains open.

The browser API review also identified missing request-to-response task binding
for timelines. Timeline and task-scoped health reads must reject another task's
response before rendering evidence. Diagnostic exports retain their pseudonymized
identity contract; internal references can be checked for consistency without
adding raw task IDs. The preceding integrated checkpoint passed 260 tests across
16 files, app/dashboard types and repository formatting. This boundary follow-up
has its own focused regressions and independent reviews before publication.

The diagnostics domain-read review additionally requires the canonical coding
row identity decoder and delivery aggregate invariants, including parent runs
used by event history. Diagnostics reuse pure domain-owned validation on bounded
read-only projections; they must not project inconsistent retained authority as
valid history or budgets. Invalid retained records remain generic unavailable
responses, without changing coding/delivery mutations or authority.

The bounded history review adds two selection corrections: the global timeline
cap must retain the newest ordered entries regardless of source iteration order,
and diagnostic exports must include the newest 100 entries rather than the first
chronological page. Coverage continues to disclose omitted history. Writeback
reads also validate each indexed record kind before classifying bounded task
candidates, so a corrupt discriminator cannot silently hide an unresolved effect.
The prior integrated checkpoint passed 308 tests across 17 files, app/dashboard
types and repository formatting; this final selection correction is separately
verified and independently reviewed before publication.

The evidence-inspector review requires validation entries to resolve their exact
recorded evidence kind, ID/reference and revision instead of exposing every result
from the same historical revision. The browser fix preserves task/pipeline
bindings, current versus historical context and reservation-only judge entries.
The preceding integrated checkpoint passed 332 tests across 17 files, types and
formatting; evidence-association regressions and independent static reviews cover
this subsequent correction before publication.

Queued-task health must inspect the current durable release and specification even
before a coding run exists, reporting missing or stale authority as actionable
attention. It does not replace the existing full coding-readiness/admission checks.
The inspector follow-up binds settled judge entries to their exact assessment and
checks repair source/target candidate identities before showing the target run.
Available candidate base/head fields are checked; current worktree views remain
explicitly distinct from frozen historical artifacts. The preceding integrated
checkpoint passed 344 tests across 17 files, types and formatting, plus eight
synthetic desktop/mobile evidence-inspection cases with screenshots attached to
#418. These subsequent corrections receive their own tests and static reviews.
The optional GitHub factory setup path must also remain unavailable or return
cleanly when no registered repository has GitHub metadata, allowing the rest of
first-run initialization to continue without mutating factory authority.
