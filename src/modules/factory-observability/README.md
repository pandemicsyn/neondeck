# Local factory diagnostics

App SQLite retains completed operation spans separately from immutable factory,
coding and delivery audit/state. Diagnostics never authorize work, retry an effect,
change a budget or read a Flue transcript. App wrappers correlate native Flue
submission receipts; Flue owns detailed model/tool tracing (installed 2.0.3
`guide/observability` and `reference/errors`). There is no runtime event replay,
network exporter or environment switch.

`listFactoryDiagnostics(paths, {workItemId?, limit?, before?})` is a read-only,
newest-first sequence cursor. Default 100, maximum 500 records per page.
`getFactoryWorkerHealth(paths)` reads four durable worker records. Both validate
persisted JSON. Invalid/missing storage throws to the diagnostic caller rather
than returning a healthy empty result. Instrumentation catches its own write
failures, preserving the original business result/error. A later successful
worker write retains `diagnosticsDegraded: true` for known diagnostic loss; complete
storage failure cannot itself be durably reported. No repeated warning flood.

Retention: every append transaction deletes spans older than seven days, then
keeps the newest 10,000 records globally. Reads exclude expired rows even without
new traffic. No sampling; high-volume recovery ticks can evict spans sooner than
seven days. The fixed schema caps each ID at 200 safe identifier characters and
has no free text/metadata bag. SQLite reuses deleted pages; this is a logical row
bound, not secure erasure, immediate file shrinking or a bound on database backups.
Completed spans interrupted by process death are absent, not fabricated as
success/failure; consult durable domain records and worker health for unfinished
work. A trace can be partial after retention or diagnostic storage failure.

Worker start, tick start/settlement, next schedule and stop are persisted, with a
15-second unref heartbeat while running or waiting. After 60 seconds (or three
intervals, if larger) without a heartbeat, status is stale. Waiting beyond the
same tolerance after `nextTickAt` is also stale even with fresh heartbeats; an
in-flight tick is not stale merely because it runs longer than one interval.
Known dead PID means not-running; graceful stop is stopped; missing records mean
not-running. PID probes work from a separate local doctor process; PID reuse can
only be distinguished by the subsequent heartbeat deadline, so this is observed
liveness rather than an execution lease. Instance IDs change on restart, failure
history persists, and successful ticks reset consecutive failure count. Worker
health measures controller ticks, not task outcomes: a handled task failure can
coexist with a successful recovery tick. Domain diagnoses and failed external
spans remain the source for task-level failure details.

Coverage: Linear source sync and native status writeback ticks; GitHub source sync and writeback ticks, per-source reconciliation and
per-effect writeback/publication; planning dispatch/read/abort with durable
intent/submission IDs; coding host prepare/launch/inspect/reconcile/cancel/collect;
delivery advancement, verification, model review, progress checkpoint, repair,
commit, push, draft PR creation, recovery and watch calls. Correlation includes
work/release/run/attempt/delivery/effect IDs where those identities exist. New
source reconciliation before task admission may have no work ID. Timings describe
app call boundaries, not independent provider CPU time; nested durations overlap.

The local span read API returns raw local correlation IDs for internal diagnosis;
it is not the public export format. This foundation layer (PR #415) does not
provide diagnostics export. The dependent layers provide these surfaces:

- PR #416 provides the strict `FactoryDiagnosticExport` snapshot schema in
  `shared/factory-diagnostics.ts` and the diagnostics API, with pseudonymized
  identifiers and nested, bounded span summaries.
- PR #417 registers the diagnostics preview and export CLI commands.
- PR #418 provides the dashboard diagnostics preview and download UI.

With the complete stack installed, run
`neondeck factory diagnostics preview <workId>` to inspect/save the canonical JSON,
then `neondeck factory diagnostics export <previewFile> <outputFile>` to validate
and copy exactly those previewed bytes to a new local file. Dashboard preview and
download use the same redacted snapshot. These instructions require the dependent
layers; they are not available from the foundation alone. There is no JSONL file
export, automatic export or upload. The JSON-line console logger described below
is a separate operational output. Remote OpenTelemetry/vendor integration is
outside this slice.

Operational logger: completed failed span transitions emit one JSON warning to
stderr (`factory.operation.failed`) with fixed operation, safe error class/code,
span/trace IDs and correlation. Recovery emits JSON info to stdout
(`factory.operation.recovered`). Repeated identical failures are silent; changed
failure/recovery output is limited to once per home, operation and tagged stable
identity per minute. Identity uses the first present field in this order:
`effectId`, `runId`, `deliveryId`, `workItemId`; calls without these fields share
an uncorrelated scope. Different identities (including identical values under
different identity tags) or uncorrelated successes cannot clear a scoped failure. `github.writeback-controller` tracks controller calls,
separately from `github.writeback` effects and their nested `github.publish`
spans. Recovery describes a successful operation for that scope, not proof of a
successful domain outcome; consult durable domain state. The in-memory
state cache is capped at 256 entries. This console path is independent of SQLite
writes. Diagnostic storage failure emits `factory.diagnostics.degraded` with fixed
`DIAGNOSTIC_STORAGE_FAILED` code at most once per home per minute, never the path
or raw storage error. Process restart resets suppression; console retention is
owned by the foreground terminal or service manager.
