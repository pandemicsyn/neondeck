# Candidate snapshot recovery

Status: implementation and two independent static reviews complete. Live
acceptance exposed an unchanged large tracked asset blocking validation. The
original underlying exception was discarded; read-only inspection reproduced
the per-file guard that rejects it.

## Required behavior

Coding completion must hand the retained candidate to checks and independent
review. Snapshotting must not reject unchanged repository assets merely because
they exceed the bounded changed-file capture limit.

Reuse existing Git blobs after verifying the current file bytes match them.
Preserve exact file modes, additions, removals and symlinks. Do not trust a Git
stat cache, run repository filters/hooks, loosen ownership checks, or simply raise
the per-file limit. Keep bounded changed/untracked capture and repeat the current
candidate/evidence checks before admission. No commit, push or provider execution
is part of taking the snapshot.

Report known failures with safe, specific reasons and recovery instructions.
Unknown failures must retain a diagnostic identifier rather than suggesting an
undefined reconciliation action. Do not expose arbitrary exception/subprocess
text or credentials in public-facing errors. Retry must use the retained run and
existing release authority; no fresh coding run or authority upgrade is implied.
After the cause is resolved, an explicit recheck must remain available for
diagnostic blockers. Recheck preserves version, release, evidence and budget
guards; an unchanged failure remains blocked without an automatic retry loop.

## Delivery

This is the second layer above the approval/polling fix in PR #432. Astra-low
implementers own snapshot capture and admission/UI diagnostics separately. Two
independent static reviews must be clean before creating the new PR; the manager
reviews integration, product behavior and module ownership.

Verify large unchanged tracked files, rejected oversized changed/untracked files,
mode changes, deletions, symlinks, stale evidence, and precise retry messages in
isolated test repositories. Include synthetic UI evidence for changed messaging.
Do not alter the operator's candidate, runtime, configuration or approval while
implementing. After upgrade, the operator can explicitly retry validation against
the existing candidate. Live acceptance remains pending until that succeeds.

## Verification

- Node 26 `npm run check`: passed, including import boundaries, migration
  consistency, typechecks and all 3,198 unit tests across 288 files.
- Focused evidence verification: 23 tests across two files passed with isolated
  Git repositories, including a 4 MiB unchanged baseline file and staged/new
  oversized content. These files also passed in the consolidated unit suite.
- Dashboard/server build and formatting of all changed files passed.
- Additional `factory-delivery.integration.test.ts` run on macOS was stopped
  after roughly nine minutes without a result. This ten-mode run is incomplete,
  not a pass; completing the delivery integration run remains follow-up work.
- Two independent Astra-low static reviewers reported no actionable findings
  on the frozen implementation. Manager review confirmed module ownership,
  validated diagnostic boundaries, retained authority and explicit recovery.
- Synthetic component QA passed at 1280×900 and 390×844: readable diagnostics,
  no horizontal overflow, explicit recheck callback, pending/stale disabling,
  and unavailable controls for non-current runs. Screenshots use fixture data.
  This covers the component in a light-theme fixture, not live backend execution.
- Live acceptance is still pending: upgrade, explicitly retry validation for
  the retained candidate, and verify checks and independent review progress.
  Implementation did not mutate live work, runtime configuration or approvals.
