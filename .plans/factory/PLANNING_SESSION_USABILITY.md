# Factory planning replies and session baselines

Status: implementation and independent static reviews complete, September 7, 2026.

## Requested behavior

- Factory planning replies use an obvious, labeled multiline text area with room
  to answer blocking questions. Preserve drafts and keep submission controls clear.
- Drafting remains possible while sending is blocked. Explain the reason and put
  any required context-refresh action next to the reply box. Sending retains the
  existing pending-request, lifecycle and authority checks.
- Release must explain any open local draft, recovery or other admission blocker
  beside its button. Comparison mode must offer a way to reveal a retained editor
  without silently discarding its contents or authorizing a release.
- A new planning session captures the latest fetched `origin` commit for the
  registered repository's configured default branch (normally `main`). Creating
  lightweight intake triage must not leave the first planning turn on an old HEAD.
- Initial coding attempts also fetch and capture the default branch when creating
  their snapshot. Running attempts and repair work keep their frozen authority.
- Fetches do not switch branches, modify working files, or update the operator's
  local default branch. Planning reads tracked files directly from its pinned
  commit; coding continues to use the existing managed worktree lifecycle.
- Existing planning sessions retain their captured revision across unrelated local
  checkouts or commits. Explicit refresh can adopt a new default-branch revision.
  Source, repository configuration and other meaningful context changes retain
  stale-state checks.

## Boundaries

Use the configured default branch rather than hardcoding `main`. Repositories with
no origin may use their local default branch; failure to reach a configured remote
must produce an actionable error rather than silently use an old local branch.
Keep fetches bounded and outside SQLite transactions. Validate remote/ref outputs,
recheck task/context versions after I/O, and preserve idempotent request replay.

Retain captured commits under SHA-addressed Neondeck Git refs so repository garbage
collection cannot remove evidence still used by a session. Temporary fetch refs
are removed after capture. Repeated captures of the same commit share one retained
ref. Automatic cleanup of historical retained refs is deferred until it accounts
for every planning, coding and repair snapshot; unique historical commits therefore
consume repository storage. Baseline provenance is retained internally, with a
dashboard revision display left for a later follow-up.

Planning and coding capture the branch at different times. This change does not
promise both phases use the same commit, automatically refresh an active session,
or grant permission to code or publish. Triage routing is outside this change.

## Delivery and verification

Use Astra-low implementers and two independent static reviewers before PR creation.
Deliver repository-baseline behavior first and the reply UI second in an official
GitHub stack. The manager reviews plan adherence and integration.

Test remote advancement with a bare local remote, stale local main, another checked
out branch, dirty working files, missing remote/branch, fetch failures, first
planning after triage, stable existing sessions and concurrent stale requests.
Verify multiline drafts, blocked-send behavior, recovery and ordinary-chat
compatibility. Capture desktop and narrow-screen screenshots with synthetic data.
Run relevant tests, types, import checks and required repository checks.

All tests and dev servers use a separate temporary `NEONDECK_HOME` or mocked APIs.
Never run feature-branch startup against the operator's normal database. No private
runtime paths, hostnames, task content or credentials belong in committed artifacts.

## Review and acceptance record

- Two independent Astra-low reviewers returned clean after the final changes.
  The manager checked scope, Git/ref ownership, Valibot boundaries, persisted
  snapshot compatibility and the shared composer's opt-in behavior.
- Broad verification caught a reservation-conflict regression. Reservation errors
  again propagate to callers; unbound reservations resume from their frozen
  snapshot without another fetch. Both reviewers checked the correction, and all
  47 focused coding tests passed, including the unchanged reservation test.
- Synthetic browser checks passed at desktop and mobile widths in light and dark
  themes. The labeled textarea starts at 100px, accepts multiline drafts while
  sending is gated, retains text across refresh, blocks Enter submission while
  stale, and submits once after recovery. No horizontal overflow or browser errors
  were observed. Synthetic screenshots accompany the reply UI PR.
- A follow-up browser check reproduced a hidden v1 editor with saved model v4.
  The release notice revealed the unchanged draft; explicitly cancelling that
  synthetic draft enabled Release v4. The live operator draft was not cancelled
  or released. Factory UI regression tests passed (329 tests).
- Lint, import boundaries, migration checks and types passed. The full unit suite
  passed 3,050 tests and serial Git tests passed 47 tests. Production/dashboard/docs
  builds, package validation, packed CLI smoke and formatting passed. Delivery
  integration fixtures now seed a real local remote for the new fetch path.
- After that fixture correction, representative Codex integrations passed for
  initial coding plus pre-publication repair (98 seconds) and watched-feedback
  repair (128 seconds). The earlier full integration run passed 142 tests but
  failed 11 cases on the unseeded fixture. Its full scenario matrix was not rerun;
  the two representative reruns exercise both corrected admission/repair paths.
  OpenCode/Kilo integration cases remain Linux-only and were skipped on macOS.
- Live operator acceptance remains open: answer an actual blocking question in
  the upgraded dashboard, and start a new task against a repository whose remote
  default branch has advanced. Browser verification used mocked APIs and is not
  a claim of live model/provider acceptance.
