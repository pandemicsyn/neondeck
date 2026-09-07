# Factory diagnostics layer handoff

Status: implemented in PR #416 of the operations stack; review/check clearance
required before merge. Live acceptance remains pending. This work follows Slice 4
and the #412/#413 UI polish, building on #415 observability. It precedes Linear
intake and remote execution expansion.

## Scope and ownership

- `factory-diagnostics` owns read-only health diagnosis, timeline projections,
  pagination and redacted export construction. Existing domain records remain
  authoritative; coding and delivery modules own their pure canonical decoders.
- The private diagnostics API exposes global/task health, task history and local
  preview data. Valibot validates IO and retained records. Inconsistent identities
  or domain invariants fail closed; diagnostics do not invoke external providers
  or grant execution/publication authority.
- CLI helpers are present here; command registration and optional setup arrive
  in #417. Dashboard inspection and reviewed downloads arrive in #418. The full
  operations implementation ledger is delivered in that top layer.

## Verification and review evidence

The layer has focused unit/route coverage for retained identity/invariant failures,
worker health, recovery precedence, stale cursors, bounded newest-history selection,
redaction and exact-preview serialization. The recent selection correction passed
130 route/export/timeline tests; writeback candidate validation passed a separate
133-test checkpoint with overlapping tests. Two independent static reviewers were
clear on the combined final source. The integrated upper-stack checkpoint passed
332 tests across 17 files, app/dashboard typechecks and formatting. These are local
synthetic results, not real provider or VM acceptance; linked PR checks govern the
current commit's merge readiness. Mandatory secret-scanning hooks remain enabled.

## Limits and acceptance handoff

Reads retain at most 200 records per source plus validation lookahead. Timeline
projection retains the globally newest 2,000 entries, ordered chronologically;
undated current states follow recorded timestamps. Exports retain the newest 100.
Health uses bounded current records and reports omitted coverage as partial.
These reads do not replace durable domain audit or claim full historical export.

No live credentials, provider authentication, GitHub publication, real VM restart
or end-to-end coding acceptance is completed by this layer. Existing factory slice
acceptance ledgers remain authoritative. The full operations stack must preserve
those obligations and separately record its live acceptance results.
