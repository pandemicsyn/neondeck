# Slice 5 handoff

September 7, 2026: source implementation complete on
`agent/factory-slice-5-linear`, based on `51a5caea`.

The [implementation plan](SLICE_5_IMPLEMENTATION_PLAN.md) defines scope and
ownership. Developers and independent reviewers use Astra at low effort. The
parent manages integration and final architecture review. Both independent static
reviews and the manager architecture review are clean, including final triage
wiring. [PR #423](https://github.com/pandemicsyn/neondeck/pull/423) is published
ready for review after verification. Implementation commit: `95c5ef31`.
Merge and live acceptance remain pending.

Current-main integration: main advanced to `8e35a0d8` (#420 local Codex login and
#421 guided setup) during implementation. It is merged into the feature branch;
both deviations entries and the upstream independent diagnostics fixture are
preserved. Linear source authority and the upstream coding-enablement gate remain
separate. Both independent reviewers returned **CLEAN** on the merge resolution;
the manager found no architecture compatibility issue. Targeted diagnostics,
Linear domain/routes and coding-release verification passed 53 tests across four
files. The merged dashboard/server rebuild, package validation (1,269 files),
packaged CLI smoke and repository formatting passed.
Post-integration `npm run check` also **PASS**: 3,066 unit tests across 285 files
in 82.10 seconds, lint, import layers, migration consistency and app/docs types.

## PR feedback follow-up

The review of `95c5ef31` identified three valid findings that the earlier local
reviews missed:

- [Transient read failure](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952649071):
  retained refresh errors revoked release/coding authority without confirmed source
  changes. Track retryable synchronization failure independently of source authority.
- [Connection starvation](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952649078):
  a slow early connection could exhaust every shared tick. Persist fair progress
  across deadlines/restarts and process authenticated local removals before remote IO.
  Independent re-review also found that a sustained delivery backlog could starve
  retained refresh within one connection, and the last connection could repeatedly
  receive only the remainder of the shared deadline. Rotate both the starting
  connection once per tick and the starting provider phase once per connection visit.
- [Project mapping scope](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952649084):
  configuration invalidation included unrelated projects in the same team. Match
  the source's original connection and effective wildcard/exact-project overlap.

Corrections and focused regressions are complete with Astra low developers.
Both independent static reviewers returned **CLEAN** after the connection and
phase fairness follow-ups. Manager architecture review is **CLEAN**: scheduling,
local removal processing and per-source read health have separate helpers; source
authority changes remain in reconciliation/config invalidation. Existing packages,
model ownership and the SQLite table are reused without another migration.
These corrections restore the intended slice behavior; no scope deviation or
new live acceptance claim is introduced. All nine CI checks passed on `bde0eb70`
before this follow-up; that result does not cover the corrections.

Final focused verification: **39 tests passed across four files**, including
actual released/reserved runs under network/server/cancellation failures,
continuous intake backlog, five busy connections sharing a deadline, and disjoint
versus overlapping project edits. Server bundling, package validation (1,272
files) and changed-file formatting also passed.

After the operator requested protection for their existing runtime home, final
verification uses temporary `NEONDECK_HOME`/`XDG_CONFIG_HOME` directories and an
OS sandbox denying all access to `~/.config/neondeck`. The focused fixtures also
pass explicit temporary runtime paths. This safeguard was verified before running
the final checks; no operator configuration is used by those runs.

The protected final `npm run check` passed lint, layers, migration consistency and
application/docs types. Its unit stage reported **3,079 passed, five failed** across
287 files (256.87 seconds). All five failures are the unchanged
`factory-delivery/repair.integration.test.ts` host-fixture cases: the protective
macOS sandbox refuses to execute `/bin/ps`, preventing supervisor identity evidence
and resulting in `Fixture writer did not stop`. A read-only process probe confirmed
that restriction; static tracing identified failure before the first heartbeat.
No live fixture processes remained. This run is **not** a full-check pass; the
five host cases require a disposable environment where process inspection is
available. The operator-home protection was not removed to rerun them.

## Additional feedback on `73c68fd9`

- [Accepted removals during credential loss](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952745591):
  local processing must validate the retained delivery's current configuration
  binding without requiring the API token or webhook-secret environment value.
- [Writeback-only configuration edits](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952745594):
  source invalidation must compare source mapping, admission and binding fields,
  excluding outbound writeback settings. The same separation must preserve queued
  source deliveries and recognition of authorized status echoes across such edits.

These corrections are complete with Astra low developers. Source fingerprints
and full outbound configuration fingerprints have distinct roles; the full binding
continues to guard new mutations. Legacy source/effect evidence can gain a source
fingerprint only when its retained full fingerprint matches the trusted previous
configuration, before the replacement configuration is published. Both independent
static reviewers returned **CLEAN**. The manager architecture review is **CLEAN**:
source binding lives in one domain helper, persistence preserves proven bindings
without reading configuration, and full outbound guards still fence mutations.
Existing packages, model ownership and database schema remain unchanged.

Protected focused verification passed **70 tests across eight files**, including
credential-loss removals against real release/reserved-run fixtures, legacy and
current queued deliveries, exact authorized echoes, stale asynchronous record
writes and outbound configuration races. Lint, import layers, migration consistency,
application/docs types, server bundling, package validation (1,274 files) and
repository formatting also passed. Runtime paths are temporary and the operator's
configuration directory remains inaccessible to these checks.

The protected broad unit suite passed **3,099 tests across 288 files** in
70.02 seconds. It explicitly excluded the five unchanged host-fixture cases in
`factory-delivery/repair.integration.test.ts`, whose `/bin/ps` restriction was
confirmed above. This is a passing included suite, not a claim that the excluded
cases or full `npm run verify` passed on this correction.

## Delivered scope and boundaries

- `src/modules/linear`: fixed-origin GraphQL reads/mutations, complete-response
  validation, sanitized errors, organization binding and a final synchronous
  before-mutation guard after the asynchronous identity check.
- `src/modules/factory/linear-*`: typed connection readiness, persisted delivery/
  sync/removal/effect records, source reconciliation and configured state writeback.
  Removal watermarks survive before admission and win against equal/older source
  snapshots. Retained-source refresh progresses independently from discovery
  failure/backoff and past inaccessible individual issues.
- Eligible reconciled issues enter the existing durable utility-triage path after
  the source transaction commits. Existing planning intent and dispatch identity
  prevent duplicate delivery/discovery from starting duplicate model work.
- Existing factory service transactions revoke release authority and fence coding.
  Linear's stable semantic source identity participates in coding authority;
  authorized state echoes and transport timestamps do not invalidate active work.
  Independent content/mapping/state changes still require renewed review.
- Public Issue webhooks share the separate ingress listener; private configuration,
  state and sync routes use the existing typed app surface. The managed Linear
  worker participates in health/export diagnostics, including unresolved effects.
- Setup/source components use shared API contracts and the existing factory UI.
  GitHub remains the delivery target. There is no new coding coordinator, model
  selection path, Flue conversation runtime, SDK dependency or remote executor.

## Explicit bounds and recovery

Webhook bodies are limited to 1 MiB with a four-second read deadline; provider
responses to 4 MiB and a 15-second deadline. Discovery pages contain at most 25
issues; issue labels are complete-or-fail at 100. Oversized/malformed provider
facts fail visibly rather than being truncated into an accepted task.

Delivery processing handles up to 25 removals per matching enabled connection across all
connections before provider I/O, then up to 25 provider-dependent deliveries per
connection. Retained-source refresh and writeback each use
batches of 25. Remote discovery cursors and local nonnegative integer offsets are distinct.
The source loop and writeback controller each receive a 45-second per-tick signal.
Reconciliation also gives each connection a ten-second budget. A private durable
cursor rotates the starting connection once per tick, independently of how many
connections finish. A per-connection cursor rotates delivery, discovery and retained
refresh phases. The retained-source cursor advances before each read. This gives
each connection/phase a fresh budget in turn and preserves progress across restarts.
Scheduler records are separate from sync diagnostics.
Provider rate limits persist a per-connection cooldown shared by both controllers;
remaining requests stop until the retained retry time, with a visible sync reason.
Authenticated removal deliveries still withdraw authority during cooldown because
they require no provider request; pending updates cannot starve their batch.
Completed deliveries retain the latest 10,000 entries; admission stops at 5,000
non-complete deliveries. Removal watermarks are retained independently of task
admission and delivery pruning.

Failed retained reads use separate per-source retry records with a one-minute
backoff and preserve task/release/coding authority. The state API shows the latest
100 failures; retry records remain durable until a successful authoritative read
or explicit task sync clears them. Canceled reads do not increment failure attempts.

Completed writeback evidence retains the latest 20 records per task; sending,
uncertain and attention records are not pruned. New sends pause at 1,000 unresolved
effects globally, with a visible sync attention reason. Effect reads are scoped
to task/issue/identity; the setup/source API returns the latest 100 effects and
deliveries. Task diagnostics retain their existing bounded coverage semantics.

**Sync Linear source** performs read-only reconciliation of uncertain effects.
Exact current source/configuration/state matches can establish receipts; mismatches
remain attention without blindly repeating a mutation. External terminal states
are not overwritten by reflecting the resulting local paused state.

## Verification

Early checkpoints, before integrated review:

- Generated `20260907204240_factory_linear_intake` through installed Drizzle Kit;
  `npm run db:check` passes. The forward SQL only creates the Linear records table.
- Operator UI owner reports 10 focused UI/API tests and web TypeScript passing.
- Transport owner reports 14 focused provider/ingress tests passing. This initial
  ingress checkpoint mocks storage; real persistence coverage is separate.
- Backend initial five tests pass for deduplication/conflicts, reordered reads,
  admission loss, ambiguous mapping, exact echoes and discovery pagination.
  Writeback and private-route integration are still being refined.
- Actual synthetic Chrome screenshots cover 1440×1050, 390×844 and 2560×720;
  owner reports no horizontal overflow and reachable writeback/save controls.
  Parent inspected desktop setup and mobile writeback screenshots. These are
  isolated component fixtures, not live Linear or full deployed-app acceptance.

Later checkpoints:

- Independent regression development added actual private-route tests, repeated
  exact-echo recovery, release/reservation cancellation, retained-source pagination
  and failure/backoff cases. Final numeric-offset cleanup passed 17 focused domain
  tests and application TypeScript.
- All 338 tests in 19 factory web/API files pass after updating the existing
  FactoryPage response fixture for the new optional configuration default.
- Diagnostics integration corrected the old three-worker bound and duplicate
  export enum to derive both from the shared worker schema. The owner reports
  183 diagnostics tests passing and a separate passing regression for Linear in
  both health and safe export, plus application TypeScript.
- The first full fast check exposed a pre-existing backend import in the web
  diagnostics API test; a self-contained typed fixture restores the layer rule
  while preserving its identity-binding tests. The next sandboxed run exposed
  the two integration mismatches above and could not exercise process/listener
  tests reliably; it was stopped. Neither run is recorded as passing.
- Full `npm run verify`: **PASS**, with the process/listener permissions required
  by existing suites. Unit tests: 2,986 passed across 281 files; Git tests: 47
  passed across six files; integration: 153 passed and 16 skipped across 12 files.
  App/docs builds, package validation, packaged CLI smoke and formatting passed.
  This run preceded final triage wiring; its unit stage also preceded cooldown
  corrections. The later checks below cover those final source changes.
- Manager review found that provider retry metadata needed enforcement in the
  domain loops. The shared durable cooldown correction, including removal during
  cooldown, passed 20 focused tests and application TypeScript. Its regression
  covers an actual release/reserved run, a 24-hour cooldown and 30 older pending
  updates, with release withdrawal/cancellation and zero provider calls. Final
  broad verification is recorded below.
- Post-cooldown `npm run check`: **PASS**, including lint, import layers,
  migration consistency, application/docs types and 2,989 unit tests across
  281 files in 84.82 seconds. This includes the final cooldown/removal changes.
- Manager end-to-end review found missing automatic utility triage. The correction
  reuses existing planning helpers after commit, with no provider/model work in
  webhook handling or source transactions. All 21 focused domain tests and app
  TypeScript passed; the new regression exercises real intent/dispatch helpers
  with synthetic transport and verifies one dispatch across duplicate intake and
  no dispatch for removal.
- Final frozen-source `npm run check`: **PASS**, including 2,990 unit tests
  across 281 files in 81.26 seconds, lint, import layers, migrations and types.
  Final dashboard/server rebuild, package validation (1,266 files) and packaged
  CLI smoke also **PASS**. This final checkpoint includes automatic triage.
- Final repository formatting and staged gitleaks secret scan: **PASS**.

These checkpoints overlap later suites and must not be added together as a
cumulative result.

## Reviews

Independent reviewers A and B both returned **CLEAN** on the completed production
source after fixes for removal ordering, stale effect reads, retained-source
starvation and effect retention. Both also cleared the diagnostics schema/fixture,
numeric-offset and documentation deltas, followed by the final cooldown/removal
correction and automatic triage wiring. These were static-only reviews. Result/publication-only ledger updates
do not change reviewed source.

The manager's architecture review is **CLEAN** after replacing overloaded string
cursor state with a validated numeric offset and enforcing provider cooldown
without delaying local authority revocation, and connecting eligible intake to
the existing durable utility-triage path after commit. Provider transport, persistence,
reconciliation, effect handling and UI have separate responsibilities. Existing
Valibot, native fetch/Hono and React Query patterns are reused; package/model
configuration is unchanged. Factory SQLite remains separate from Flue runtime
state, and release/delivery authority is shared across source providers. No
remaining plan/module/package/model adherence finding is open at this checkpoint.

## Live acceptance

Real Linear authentication, public webhook delivery and authenticated state
writeback are NOT RUN. Earlier slice live obligations remain unchanged.

## Provider contract references

The transport owner checked the official [GraphQL guide](https://linear.app/developers/graphql),
[webhook contract](https://linear.app/developers/webhooks),
[pagination](https://linear.app/developers/pagination),
[rate limits](https://linear.app/developers/rate-limiting) and
[published GraphQL schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)
on September 7, 2026. No Flue API changed; existing runtime ownership and model
configuration are retained.
