# Repository setup and validation workflows

Status: source implementation, two independent static reviews and manager
product/architecture review and full local verification complete. Live acceptance
remains pending. This operator-approved follow-up addresses
validation commands being inferred without preparing their dependencies.

Published as [backend PR #435](https://github.com/pandemicsyn/neondeck/pull/435)
and [dashboard/CLI PR #436](https://github.com/pandemicsyn/neondeck/pull/436)
in stack #437. Publication occurred only after both static reviewers were clean.
Live acceptance remains an operator follow-up, separate from PR review/merge.

## Product behavior

Repository setup exposes a Factory workflow editor, both from the dashboard and
the optional factory onboarding flow. A repository can have named profiles, such
as a web application and a nested extension, with a visible default.

Each profile declares setup commands, validation commands, each command's
repository-relative working directory, separate setup/validation time budgets,
runtime requirements and environment-variable references. Secret values and
deployment addresses remain private runtime configuration. Existing explicit
repository-required checks remain mandatory regardless of profile selection.

Neon can inspect bounded repository evidence and propose editable configuration.
The proposal cites its inputs and does not execute or save itself. Lockfiles,
package scripts, documentation and CI can inform suggestions; npm is not the
only supported package manager. Ambiguity should remain visible for human review.

The operator can save and explicitly test a profile. Testing uses a disposable
checkout of the current remote default branch, reports setup and validation
progress, captures bounded redacted output and supports cancellation and cleanup.
Testing does not approve factory work or publish anything.

Planning receives the available profiles and can propose a profile for the task.
The operator reviews the selected profile and its resolved commands at plan
approval. Capture that exact workflow in release authority: later settings do
not silently change existing runs. Keep unchanged historical records readable
without introducing another execution path or upgrading their authority.

Factory validation prepares its owned candidate checkout, runs setup, then runs
validation and independent review. Setup failures are reported as environment
setup failures with the failed command/output. They stop before judge or coding
repair dispatch. A deliberate retry after the environment is corrected reuses
the candidate and exact approved workflow; changed workflow settings require
renewed plan approval. This work does not provision Node installations or build
a new coding agent. Existing coding CLIs receive workflow context and retain
their own repository-skill behavior.

## Contracts and ownership

- `shared/repo-workflows.ts`: bounded Valibot profile and configuration schemas.
  Named profiles contain per-command cwd, setup/validation arrays, timeouts,
  Node/package-manager requirements and environment variable names.
- `repo-workflows`: repository configuration, concurrency checking, resolution
  and model-assisted proposals. Reuse repository registry and guardrail policy.
- `repo-workflow-runs`: explicit disposable trials with inspectable state,
  bounded execution, cancellation and cleanup. Reuse execution primitives.
- `repo-workflow-runtime`: dependency-light runtime, environment and directory
  checks shared with the detached verification worker. This worker must not load
  the model runtime or dashboard trial controller through a module import.
- Factory planning/release: selected workflow and frozen approval context.
- Factory delivery: setup-before-validation, receipts and failure/retry routing.
- Dashboard and CLI: shared typed services, clear progress, durable drafts,
  comfortably sized command fields, usable narrow layouts and visible next actions.
  Commands are ordered entries using the existing executable/argument contract;
  complex shell logic can live in a repository script. Do not invent an implicit
  shell interpreter for pasted multiline text.

Reference-only settings are safe to inspect; resolved secret values never enter
public snapshots or logs. Validate commands, paths, profiles, API/model replies,
persisted state and process results at their boundaries. Preserve ownership,
current-candidate, no-writer, execution-policy and total-budget checks. Setup may
prepare ignored dependencies; it must not silently certify altered tracked
candidate content. Only explicit environment references are provided, never the
operator's complete environment, credentials, home or runtime config pointers.

## Delivery and verification

The manager owns this plan, integration review and PR operations. Astra-low
implementers own foundation, execution, setup UI/CLI and planning integration.
Two independent static reviewers must return no findings before any PR creation.
The manager then reviews product adherence, module boundaries and authority.

Use the official stacked-PR workflow. Split only at coherent runnable boundaries;
do not publish a settings UI without its backend. Include synthetic screenshots
for desktop and narrow layouts. Never bypass the pre-commit secrets scan.

Required regressions include named/default profile resolution, mandatory checks,
non-npm suggestions, configuration races, runtime/env/cwd validation, proposal
non-mutation, setup ordering and failure classification, cancellation/cleanup,
exact approval capture, stale settings, bounded redacted logs and UI draft
preservation. Exercise a fixture whose validation requires a dependency created
by setup, with no real provider calls or network dependency installation.

Run focused checks followed by repository checks and full verification for this
multi-surface integration. Record incomplete checks rather than treating them as
passes. Live acceptance remains separate: the operator must configure, test and
approve the workflow for the real repository after upgrade.

## Source review record

Two independent Astra-low reviewers cleared all 100 feature files against base
`25789095591e1e92249d83b2f90a77c4b1acc8ba` before PR creation. Corrections cover
large-lockfile evidence, cross-process trial ownership and cleanup, terminal
cleanup progress, executable discovery and Node identity, authenticated CLI
proposal requests, and the detached worker dependency graph. The manager checked
workflow selection, exact approval capture, required checks, environment retry,
Valibot boundaries, module ownership and synthetic desktop/narrow screenshots.

The layer checker recognizes exactly two additional public worker entrypoints:
`execution/worker.ts` and `coding-runs/worker.ts`. Existing implementations are
moved/re-exported; private import and layer-direction rules remain enforced. A
Vite build-graph regression restricts the detached verifier to its audited
deterministic dependencies.

### PR feedback follow-up

PR #435's trial-remote finding is corrected: test checkouts fetch from the
unambiguous remote matching the registered GitHub repository, including an
`upstream` remote or a matching URL after an unrelated URL. Missing or ambiguous
matches report a setup blocker without falling back to stale local content.

The backend also exposes read-only discovery of the repository's owned workflow
test so the dashboard can recover its progress and cancellation handle after a
refresh. Discovery validates the lock, signed ownership and bounded result; it
does not start recovery, execute commands or remove locks. Both independent
reviewers cleared this backend correction, with 44 focused tests, typechecking,
lint and formatting passing.

PR #436 now restores the owned test after refresh or repository switching,
preserves unsaved workflow edits and retains final output after lock removal.
Ownership discovery cannot overwrite a newer status observation. An uncertain
outcome has an explicit status-refresh action; duplicate starts remain blocked
until ownership and progress settle. Both independent reviewers cleared the
final UI correction after two recovery edge cases were fixed. All 44 focused
UI/API tests, root/web typechecks, lint, formatting and import checks pass.

The selected-workflow comment on #435 concerns its dependent UI integration in
#436: the viewed brief's workflow feeds the execution preview and approval
payload. An initial nondefault-profile regression verifies this behavior; the
manager's final review covers the combined stack and exact approval capture.

Further automated review found that workflow edits did not survive page reload.
The editor now retains a bounded, versioned per-repository session draft,
including its original base fingerprint, incomplete edits and selected profile.
Successful save or explicit discard clears it. Storage failures are visible and
stale restored settings still require reconciliation. Both independent reviewers
cleared this correction; 98 tests across seven focused dashboard/API suites,
root/web typechecks, lint and formatting pass.

The environment-retry UI comment on #435 is covered by dependent #436: an
explicit retry button submits the current pipeline version and operator reason
to the typed retry endpoint. A regression confirms rendering does not retry and
an explicit click submits that exact request.

The remaining #435 corrections unify reserved environment-name validation at
configuration and execution, and retain signed cleanup evidence before terminal
persistence and repository-lock release. Receipt hashes normalize through the
ownership schema. Recovery continuation requires authenticated cleanup proof,
proven claimant death and an exclusive SQLite guard that releases on process
exit. Partial or unproven claims remain retained; a later run's lock is protected.
Both independent reviewers cleared the final backend correction. Its 91 focused
tests include real-schema persistence and a recovery process exiting while
holding its claim; root typechecking, lint and formatting pass.

Joint review added configuration repair and UI completion-race coverage. Bounded
stored settings remain inspectable and repairable, while new saves, proposals,
approval and execution use strict environment-reference validation. The SQLite
guard now opens through the existing shared gateway; its boundary check remains
unchanged. Both reviewers cleared these backend changes with 127 focused tests.

The dashboard polls ownership until a completed test releases its lock and
offers explicit status recovery after interruption. It does not show a transport
failure when discovery recovers an owned test. Delayed responses from a replaced
progress panel cannot overwrite a newer run or invalidate its ownership. Both
reviewers cleared the final UI correction; 27 focused tests and web typechecking,
lint and formatting pass.

## Verification record

- Final restacked source passed `npm run check`: 321 files and 3,549 unit
  tests, including the unchanged SQLite-access boundary check. Both independent
  reviewers cleared the combined corrections and the stored-proposal integration.
  The latter also passed 34 focused dashboard/API tests and web typechecking.
- PR feedback corrections passed `npm run check`: 320 test files and 3,503
  unit tests. The independent UI review subsequently identified two related
  ownership/progress recovery cases; the final 44 focused UI/API tests and both
  reviewers' clean re-reviews cover those corrections before publication.
- Repository `npm run check` passed before the final review corrections.
- The subsequent full verification run passed lint, import layers, migration
  consistency, application/docs typechecks, 3,480 unit tests, 47 Git tests and
  154 integration tests (16 skipped). Integration completed in 944.87 seconds;
  the earlier apparent stall was a slow run, not a reported failure. The full
  `npm run verify` command finished with exit code 0, including builds, package
  contents, isolated packed-CLI smoke and formatting.
- The final worker-boundary change additionally passed its real Vite build-graph
  regression, 19 process/supervision tests, typecheck, lint and import checks.
- Dashboard/server/docs builds, npm package contents, isolated packed CLI smoke
  and repository formatting passed separately on the final combined source.
- The backend stack layer passed root/web typechecks and dashboard/server build
  in its own isolated checkout. Two existing UI compatibility hunks were moved
  into that layer; the final combined implementation was unchanged.
- Synthetic desktop and narrow screenshots cover configuration, approval and a
  setup failure. No live task, provider run, dependency installation or private
  runtime configuration was used for screenshot QA.
- Both pre-PR independent static reviews are clean. Live acceptance and the
  separate omitted judge-diff evidence issue remain open.

## Related open issue

The live progress judge also reported omitted candidate-diff evidence. That
independent review-context issue is not repaired by environment setup. It remains
an explicit follow-up before declaring the entire live candidate lifecycle
accepted. This implementation must not weaken review requirements to bypass it.
