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

## Further feedback on `5639a98d`

- [Capability-specific readiness](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952856265):
  provider reads/writeback need the API token; signed ingress needs the webhook
  secret. Losing one credential must not disable the independent capability.
- [Admission confirmation](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952856272):
  saving a draft must not clear a configuration-change blocker before a current
  Linear source read confirms eligibility under the new admission rules.
- [Writeback fairness](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952856275):
  writeback connections must rotate under the shared deadline. Boundary review
  also identified the need to advance retained item progress before slow reads.

Corrections are complete with Astra low developers. Both independent static
reviewers returned **CLEAN**, including final test-boundary corrections. Manager
architecture review is **CLEAN**: capability checks stay in connection readiness,
the shared source contract carries the confirmation requirement, and existing
factory eligibility/reconciliation controls its lifetime. Writeback reuses the
durable scheduler with an independent cursor and advances ordered item progress
before reads. Packages, model ownership and database schema remain unchanged.

Protected focused verification passed **82 tests across ten files**. Coverage
includes real HMAC ingress and actual release/reserved-run revocation under
credential loss, save-before-sync and legacy admission blockers, stale/ineligible
reads, independent connection/item progress, stale cursor recovery and abort
guards. Initial validation caught a server import in a domain test, the wrong
HTTP success assertion and an obsolete no-polling assertion; all were corrected
and independently re-reviewed. Dashboard/server builds and package validation
(1,274 files) passed with operator configuration access denied.

Final protected broad verification passed **3,111 tests across 290 files** in
62.32 seconds, plus lint, import layers, migration consistency, application/docs
types and repository formatting. The same five unchanged host-fixture cases
requiring `/bin/ps` were explicitly excluded. This does not claim a full final-head
`npm run verify` pass or live Linear acceptance.

## Feedback on `c79b2eaf`

- [Definitive source absence](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952930814):
  retained polling must reconcile a proven missing issue as removal while keeping
  provider, authentication and malformed-response failures separate.
- [Preflight retry](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952930816):
  a mutation not yet dispatched must remain retryable after transient organization
  preflight failures. Only dispatched requests have uncertain remote outcomes.
- [Composite record IDs](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3952930818):
  internal record identifiers need bounds distinct from provider/configuration IDs
  so valid long connections and workflow states remain visible through the API.

Corrections are complete with Astra low developers. Both independent static
reviewers returned **CLEAN** on the combined final delta. Manager architecture
review is **CLEAN**: transport establishes source absence and the dispatch boundary;
domain reconciliation owns authority, and persisted effect state distinguishes
pending from sending. A transactional dispatch claim prevents concurrent sends.
Source-equivalent configuration edits can safely rebind an unsent intent; legacy
sending records remain conservative. Shared composite IDs use one 2,000-character
schema, while external/configuration IDs retain their 240-character limit.
Existing packages, model ownership and database schema remain unchanged.

Protected focused verification passed **120 tests across 13 files**, including
actual transport absence, trashed-source and HTTP/GraphQL failure cases; repeated
absence idempotence; real organization-preflight 429/503 recovery; pending retry
and rebinding; concurrent dispatch claims; and durable API state with long IDs.
Dashboard/server builds and package validation (1,274 files) also passed.

Final protected broad verification passed **3,142 tests across 292 files** in
68.19 seconds, plus lint, import layers, migration consistency, application/docs
types and repository formatting. The five previously identified host-fixture
cases requiring `/bin/ps` remain explicitly excluded. All runs use temporary
runtime homes and deny access to the operator's `~/.config/neondeck`; this is not
a full final-head `npm run verify` pass or live Linear acceptance.

The provider contract uses an organization-bound exact-ID `issues` query with a
complete result page and archived issues included. An empty result means absent
from the accessible source, not proven deletion; an explicitly trashed issue is
also unavailable. HTTP/GraphQL errors and malformed or partial pages remain read
failures. The official [filtering guide](https://linear.app/developers/filtering)
and [GraphQL schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)
define the ID comparator, archive inclusion and trashed field. No synthetic
deletion timestamp is introduced.

## Broad review after `c847d6a0`

The operator requested fixes plus a wider review to reduce repeated PR feedback.
The three reported findings were [superseded pending effects](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3953007885),
[delivery selection before parsing](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3953007888)
and [the 100-label bound](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3953007892).
Developers, two independent reviewers and the manager examined the surrounding
source/delivery/effect lifecycle, outages, configuration transitions, replay,
capacity, retention and schema boundaries rather than only those lines.

The review additionally found and corrected HTTP 400 rate-limit classification,
provider/storage cursor limits, composite canonical source keys, unbounded history
decoding, permanently occupied intake capacity, orphaned delivery backlogs,
superseded-intent capacity accounting, restored targets, completed A→B→A target
cycles, and a stale worker's ability to replace newer desired-target metadata.

Unsent effects have an explicit terminal `superseded` state. A fresh intent can
serve a restored target without lifecycle churn; unique intent tokens fence old
preflights. One private desired-target record per work item supplies generations
for renewed targets while preserving completed receipts and legacy evidence.
Only pending effects retire; sending/uncertain evidence remains conservative.
Retirement runs locally before provider readiness/cooldown checks. Diagnostics
exclude retired effects from unresolved work without claiming a successful send.

Only pending non-removal deliveries consume the 5,000 active slots, including manual sync.
Completed/attention deliveries share bounded history and retain their real status.
Removed, disabled or stale source bindings are quarantined locally in bounded
batches, allowing unrelated intake to recover without provider credentials.
SQL narrows connection, state, due time and batch before decoding; retained-source
pagination and exact tombstone lookup avoid repeatedly decoding unrelated history.

Both independent broad static reviews are **CLEAN** on the frozen correction.
The manager architecture/behavior review is **CLEAN** after also addressing stale
work/source snapshots at desired-target mutation and the writeback-side SQL batch.
Provider IO, source authority, desired-target generation, effect retirement and
persistence each retain distinct modules. Existing packages, model ownership and
the Neondeck SQLite/Flue state separation are unchanged; private record variants
use the existing table without a migration.

Protected focused verification passed **155 tests across 16 files**. Regressions
exercise maximum-capacity recovery, oldest-first batch progress, stale/removed
bindings without credentials, repeated completed target cycles, fresh-intent ABA
fencing, transactional work/source guards, retirement health projection and
provider/schema limits. The earlier focused checkpoint passed 154 tests before
the final transactional guard regression; these results are not cumulative.

Final protected broad verification passed **3,172 tests across 294 files**, plus
lint, import layers, migration consistency, app/docs typechecking and repository
formatting. Dashboard/server builds and package validation (1,276 files) passed.
The five unchanged host-process repair cases described above remain excluded
because the protective sandbox blocks their process inspection; this is not a
full `npm run verify` claim. Temporary runtime/config roots and the OS denial of
access to the operator's existing Neondeck home remained in place throughout.

Main advanced to `815eb21e` during publication of correction `22db330b`. The
integration preserves upstream fresh repository baselines, planning usability,
native coding skills and development worker ownership. Linear joins the shared
cleanup set so startup rollback, replacement startup and shutdown retain the
same owner. The deviations ledger preserves both branches' entries. A dedicated
mocked regression covers a Linear startup failure after earlier workers start.
Both independent integration reviews and the manager architecture review are
**CLEAN**. The protected merged-branch run passed **3,243 tests across 298 files**,
lint, layers, migration checks, app/docs types, dashboard/server builds, package
validation (1,281 files) and formatting. The same five host-process cases remain
excluded; no live acceptance or full final-head verify pass is claimed.

## Final merge preparation

Final merge preparation addressed [removal capacity feedback](https://github.com/pandemicsyn/neondeck/pull/423#discussion_r3953929792):
authenticated removals bypass the 5,000 pending provider-read limit, including
during credential loss. Their pending records remain durable without a separate
hard cap; processing still selects 25 removals per connection. Ordinary intake
and manual retries share the bounded non-removal queue. Signed-ingress regression
coverage verifies release withdrawal and reserved-run cancellation with a full
create/update backlog and no API token. Identity conflicts and duplicates retain
their existing behavior.

Main `384a13fd` is integrated, preserving upstream candidate validation, separate
publication approval and stable background refresh controls. Linear fixture
releases now supply the reviewed validation policy. Both independent static
reviews and the manager architecture review are **CLEAN** for this correction
and integration. No package, model or persistence boundary changes were needed.
Protected verification passed **3,308 tests across 304 files**, lint, layers,
migration consistency, app/docs types, dashboard/server builds, package validation
(1,286 files) and formatting. The same five host-process repair cases remain
excluded under operator-home protection; live acceptance remains pending.

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
Both loops also give each connection a ten-second budget. Independent private durable
cursors rotate each loop's starting connection once per tick, independently of how many
connections finish. Writeback advances its stable ordered item cursor before each read.
A per-connection source cursor rotates delivery, discovery and retained
refresh phases. The retained-source cursor advances before each read. This gives
each connection/phase a fresh budget in turn and preserves progress across restarts.
Scheduler records are separate from sync diagnostics.
Provider rate limits persist a per-connection cooldown shared by both controllers;
remaining requests stop until the retained retry time, with a visible sync reason.
Authenticated removal deliveries still withdraw authority during cooldown because
they require no provider request; pending updates cannot starve their batch.
Completed and attention deliveries share the latest 10,000 history entries;
ordinary admission stops at 5,000 pending non-removal deliveries. Manual sync shares that capacity gate;
refreshing an already-pending retry consumes no new slot. Removed, disabled and
stale bindings are quarantined in local batches of 25 before provider work.
Authenticated removals bypass that cap and have no separate pending hard limit;
their local processing remains bounded to 25 per connection per pass.
Removal watermarks are retained independently of task
admission and delivery pruning.

Failed retained reads use separate per-source retry records with a one-minute
backoff and preserve task/release/coding authority. The state API shows the latest
100 failures; retry records remain durable until a successful authoritative read
or explicit task sync clears them. Canceled reads do not increment failure attempts.

Completed writeback evidence retains the latest 20 records per task; a separate
20-record history retains superseded unsent intents without evicting receipts.
Pending, sending, uncertain and attention records are not pruned. New or reactivated
intents pause at 1,000 unresolved
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
