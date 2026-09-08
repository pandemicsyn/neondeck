# Stable factory controls during background refresh

Status: implemented; independent static reviews clean, September 7, 2026.

## Acceptance follow-up: approval recovery

Live rehearsal after the lifecycle merge found that withdrawing approval correctly
returns the task to Plan, but a missing independent reviewer blocks the new
release. The setup explanation is separated from the disabled approval button.
Repeated failed policy reads may also replace that explanation during polling.

The follow-up must keep the actionable blocker visible beside approval, preserve
it through background retries until a successful response, and retain explicit
review of changed policy. It must not select a model, change configuration or
approve the operator's task automatically. Verify failure-to-failure and
failure-to-success polling, focus/scroll stability and blocked authorization with
synthetic fixtures. The scoped fix is implemented and both independent static
reviews are clean. `npm run check` passed 3,152 tests; all 366 factory regressions,
dashboard build, formatting and whitespace checks passed.

Synthetic browser QA reproduced the no-data error-to-pending transition and
verified the fix with actual 15-second polling and delayed failures. Desktop and
narrow runs each covered four failed requests: the warning stayed mounted,
approval stayed disabled and stationary, and the adjacent synthetic draft kept
its node, content, focus and selection. Success cleared the warning; changed
policy required explicit review. This isolated component harness does not prove
the full live chat lifecycle. Live provider acceptance remains incomplete.

Operator rehearsal found flashing labels and enabled/disabled buttons while idle
on the factory task page. Polling and event-driven invalidation set React Query's
`isFetching`, and several controls treated every fetch as a user operation.

## Scope and behavior

- Keep periodic and event-driven updates enabled; new task/run facts must arrive.
- Retain loaded content during background refresh. An unchanged response should
  not flash action buttons, replace labels, or add/remove loading notices.
- Distinguish initial loading, explicit refresh, actual mutations, and background
  revalidation. Initial loading and user actions retain appropriate busy feedback.
- Keep refresh errors visible. Reviewed execution settings and delivery authority
  remain bound to their fingerprints; changed settings still require review.
- Do not let a background fetch become an accidental authorization gate. A user
  action submits the reviewed version/fingerprint, and the backend validates it.
- Gate destructive writeback relinquish while its query refreshes: recovery has
  no expected-state binding, and an uncertain receipt may reconcile to sent.
  Keep read-only receipt checks and draft controls stable during that fetch.
- Preserve selected task, pagination, focus, scroll, and unsaved drafts. Do not
  broaden into a redesign, change worker scheduling, or alter backend authority.

## Delivery and verification

One Astra-low implementer owns the coherent frontend fix. Independent Astra-low
reviewers must return clean before PR creation. The manager checks product and
architecture adherence; a separate synthetic browser pass checks stable controls
across delayed refreshes and captures screenshot evidence. No live task release
or runtime mutation is part of verification.

Regression coverage must distinguish unchanged background fetches, manual
refreshes, failed fetches, and changed authority fingerprints. Record completed
checks and browser evidence here before handoff. Live operator acceptance remains
pending after upgrade.

The implementation uses a small factory-local manual-refresh hook rather than
using every query's transport status as button state. Pagination and manual
refresh are mutually exclusive for the shared infinite queries. Errors still
block authority actions while local publishing drafts remain editable and
cancellable. Publishing-policy previews also detect changed epochs/fingerprints.

Both independent static reviewers cleared the final production and regression
test changes after a pagination cancellation finding was corrected. The manager
confirmed the change stays within factory frontend state handling, with no new
API contracts or backend authority changes. Dashboard build, dashboard typecheck,
focused factory regressions, formatting and whitespace checks passed.

The `npm run check` lint, layer, migration-consistency and typecheck stages passed.
Its sandboxed unit phase hit local-listener/process-group restrictions and was
stopped; rerunning `npm run test` outside that sandbox passed all 280 files and
3,093 tests. The separate dashboard build passed. Backend integration suites were
not rerun for this frontend-only change to the factory page.

Synthetic browser comparison: unchanged delayed polling leaves health, coding,
and execution-settings labels and enabled states stable; manual refresh remains
visibly busy; fingerprint drift and request errors block release; recovery works.
The harness retained sibling draft text/focus and observed no browser exceptions.
Full task-editor preservation is covered by the component regression, not that
synthetic sibling field. Browser coverage excludes populated attempt pagination
and delivery controls; those rely on component regressions and static review.

## Reproduction

A synthetic browser harness mounted the real health, coding, and release
components against delayed mock responses. During an unchanged periodic fetch,
all three refresh labels changed, their buttons became disabled, and the release
button became disabled. The same harness confirmed the existing manual-refresh,
changed-fingerprint, and error gates before implementation. No operator data or
live task mutations were used.

## Separate lifecycle usability follow-up

The same rehearsal exposed a separate delivery setup problem. The candidate
preview API returned HTTP 409 because no enabled factory GitHub connection was
configured; the UI hid that actionable error behind a generic message. A manual
intake task can complete coding but its delivery checks/review currently require
the GitHub connection used to resolve the publication target. The reused local
findings panel also does not represent the independent delivery review status.

Follow-up: expose the exact safe setup blocker with navigation, distinguish
"review not started" from a completed review with zero findings, explain the
checks/review/repair/draft-PR authorization, and evaluate decoupling local
validation from publication configuration. This refresh fix does not change
those backend stages or grant publication authority.
