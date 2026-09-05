# Factory increment 1: manual intake

This increment is local/private only. Parent: documentation PR
[#382](https://github.com/pandemicsyn/neondeck/pull/382), base `9aba1ae2`.
It does not start model planning, GitHub ingress, coding, worktrees or external effects.

Open `/factory` in the existing dashboard. Factory is disabled by default; select
**Enable manual intake** to enable it through the typed local config API. When
enabled, **Factory inbox** appears in the dashboard. Existing runtime startup,
PR review, Autopilot, Kilo and chat behavior are preserved.

1. Create a task with a title and requested outcome. Pick a registered repository
   or leave it unresolved. The client retains a request key across retries, so an
   accepted retry returns the same task. Reusing a key with different content fails.
2. Open the task. **Choose repository** opens the source controls if unresolved.
   Repository registration continues to use the existing repo configuration flow.
3. Select **Edit draft**, enter outcome, scope, approach and acceptance criteria,
   and save a new immutable revision. Optional non-goals, constraints and assumptions
   stay in the same canonical spec. Structured decisions and commit/path references
   are supported by the API and rendered in the draft; their full interactive
   editing and version comparison belong to increment 3.
4. Review the current draft and its blockers. **Release vN** captures that exact
   version/hash, source version, repository fingerprint, local operator identity
   and `isolated-local-v1` policy. This authorizes future isolated-worktree
   implementation and repo-configured checks only. It never authorizes publishing,
   merging or deployment. The UI says **Released — awaiting coding executor**;
   this increment has no executor or queue consumer.
5. Pause or withdraw a release without deleting history. Reopening a paused or
   closed task returns it to shaping. Changing source/repo context requires a fresh
   reviewed spec revision. A new spec revision atomically withdraws prior release
   eligibility. Retained history shows each spec and release decision.

A conflicting save returns HTTP 409 with current detail. The spec editor preserves
local text and the original expected versions; copy/reconcile edits before canceling
and reopening the latest draft. It never silently resubmits against a new version.
The source editor binds all fields and its concurrency token to one snapshot,
including before first focus. After a conflict, compare the current saved source,
then select **Reload current source (discard local edits)** and reapply chosen edits.
Background refresh failures keep loaded editors mounted and show a refresh error.
Draft and source editing controls are disabled while a save is pending, so a
response cannot discard text entered after submission. Failed saves preserve text.

Spec saves also require the repository fingerprint captured by the editor. Changed
repo configuration cannot be adopted by a stale save. Review the displayed path,
branch and commands, then choose **Use this reviewed repository context** to accept
that exact context while preserving draft text. Polling never accepts it for you.
Each immutable revision retains the accepted repository context alongside its hash.

The inbox refreshes on factory events and periodically, with a manual Refresh action
for external-process changes. Detail recomputes eligibility against current config
and repo context; a stored `queued` lifecycle alone is not proof of eligibility.

## API contracts

All paths are below the existing local/private `/api/factory` surface. Existing
host/origin checks are browser guards, **not Internet authentication**. Do not expose
these routes publicly. The server assigns `local-operator`; request bodies cannot
supply actor identity, and no release/config operation is registered as a model tool.

| Method/path                 | Purpose                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /state`                | Enabled state, coding policy, registered repo choices and inbox                                         |
| `POST /config`              | `{ enabled, codingPolicy: "isolated-local-v1" }`                                                        |
| `POST /work`                | `{ requestKey, title, body, repoId }`; repo may be null                                                 |
| `GET /work/:id`             | Source, immutable revisions, release history, blockers and eligibility                                  |
| `POST /work/:id/spec`       | `{ expectedVersion, expectedSpecVersion, expectedRepoFingerprint, spec }`                               |
| `POST /work/:id/source`     | `{ expectedVersion, title, body, repoId }`                                                              |
| `POST /work/:id/release`    | `{ requestKey, expectedVersion, specVersion, specHash, sourceVersion, repoFingerprint, policyVersion }` |
| `POST /work/:id/transition` | `{ expectedVersion, action }`; pause, withdraw, reopen or close                                         |

`expectedVersion` is the work item's concurrency version; `expectedSpecVersion`
is the immutable draft version. All mutations validate at the service boundary and
serialize in an immediate SQLite transaction. Revocation remains available while
disabled. Replaying a withdrawn release request cannot restore its authority.
The forward migration adds five narrowly scoped tables: manual sources, work items,
spec revisions, release decisions, and lifecycle audit. No Flue runtime records are
copied into the app database.

Factory config lives in the existing app config and is available through its normal
read/validate interfaces. This increment adds a typed dashboard-owned config service;
it does not give models a new enablement or release capability.
