# Static Review: Diff UI + PR Review Actions Implementation

Status: **resolved** — findings log from a static code review (no tests executed) of the
implementations of `.plans/archived/DIFF_UI_PLAN.md` (commits `b935105`, `1e8d89a`) and
`.plans/archived/PR_REVIEW_ACTIONS_PLAN.md` + PR-files cache follow-up (commit `a778d7e`, PR #67).
Reviewed 2026-07-05 on `fix/diff-review` (tree identical to main at `7e634af`).
**Re-reviewed 2026-07-05 against the fix commit `77ab999` (PR #70)** — all 14 substantive
findings verified fixed; leftover trivia and two new minor observations are listed at the end.

## Re-review verdict (commit `77ab999`)

Every finding was addressed with a real fix (not a suppression), and each fix has test
coverage. Verified by reading the full diff:

1. **Head re-anchoring** — `upsertPrReviewDraft` now preserves `head_sha` on updates unless
   the new explicit `reanchorHeadSha: true` flag is passed (`reviews.ts`,
   `updateExistingReviewDraft`); routine UI autosaves never pass it; the staleness banner gained
   an explicit "Update draft head" button (`refreshDraftHead`). Contract restored.
2. **Re-anchor flow** — implemented end-to-end: `PATCH .../comments/:id` accepts
   path/side/line/startLine/startSide (schema + service pass-through + anchor validation in
   `updatePrReviewDraftComment`); UI adds a re-anchor mode (Re-anchor button on stale
   annotations and in a new `StaleDraftCommentPanel` footer, then click a new line), with a
   banner hint and anchor-validity gating before save.
3. **Typing clobber** — reviewBody now seeds once per draft id and only syncs from the server
   when the textarea is unfocused and no local edit is pending
   (`isReviewBodyFocused`/`hasPendingReviewBodyEdit`).
4. **Selection ordering** — `orderSelectionEndpoints` orders cross-side endpoints by patch
   anchor position (same hunk) with a same-side numeric fallback; both composer open and save
   validate `commentAnchorExists` and refuse invalid ranges; backend
   `assertValidReviewCommentAnchor` rejects same-side inverted ranges on create *and* update.
5. **Failing-comment attribution** — server parses GitHub's 422 `errors[]` for `comments[N]`
   indexes, falls back to path+line matching, then to all ids
   (`failingReviewCommentIdsFromGitHubError`); UI renders failures as `path L#` labels, tracks
   `submitFailedCommentIds`, and excludes them from the next submit.
6. **Live-head validation at submit** — `submitPullRequestReview` fetches the PR's current
   head (injectable `fetchHeadSha`) and requires *both* the draft's and the client's sha to
   match it; `commit_id` is the verified live head. The server stale check now has real teeth.
7. **Approvals next to the diff** — `ApprovalRow` receives the matching prepared diff, renders
   `PreparedDiffReview` inline (auto-expanded for `prepared-diff` approvals) with approve/deny
   beside it, and shows an honest fallback when the diff is no longer retained.
8. **Rename-only files** — `isRenameOnlyPullRequestFile` checked before the binary heuristic;
   message names the previous path.
9. **Draft-PUT race** — insert is attempted first and a unique-constraint failure re-reads the
   winner and updates it (`isUniqueConstraintError`); `putGitHubPrReviewDraft` is wrapped in
   try/catch like its siblings. Covered by the "coalesces parallel review draft PUTs" test.
10. **Thread updates in place** — reply/resolve `onSuccess` now splices the returned thread
    into the query cache via `setQueryData` (`upsertReviewThread`); no event-state refetch.
11. **Worker pools hoisted** — `DiffWorkerProvider` moved out of `UnifiedPatchView` up to
    `MultiFileView` and the single-file surface wrappers; one pool per mounted surface.
12. **Pop-out** — header "pop out" button opens the deck with `prReviewRepo`/`prReviewNumber`
    params; `GitHubPrList` reads them and auto-expands the matching PR's review. Docs
    (dashboard page + README) now name the pop-out/`neondeck open` path for compact.
13. **Configured-repo gate** — review submit, thread reply, and thread resolve/unresolve all
    require `isConfiguredRepoTarget`, matching the `pr_comment` posture; covered by the
    "keeps outward PR review mutations scoped to configured repos" test.
14. **Tests** — added: captured-real-patch addressing matrix
    (`web/src/features/pr-review/fixtures/captured-review.patch`), re-anchor + explicit head
    refresh submit flow, precise failing-id extraction (indexed and path/line), 403→scope and
    not-scope classification (heuristic tightened: `GitHubApiError.status === 403` or specific
    phrases; `githubFetch` now throws typed `GitHubApiError` with status + parsed body),
    parallel-PUT coalescing, thread cache splicing.
15. **Nits** — `pr-file-cache` uses `openDb`; unanchorable threads no longer emit
    `lineNumber: 0` annotations (skipped; the file-level panel covers them); pending count is
    a button that cycles through pending-comment files.

## Remaining items (minor, non-blocking)

Carried over from finding 15 or observed in the fix diff. None affect correctness of the
happy path; fold into any future touch of these files.

- **Stale deck vs. stale draft are indistinguishable in the error.** "Update draft head"
  anchors to the deck-cached `pr.headSha`; if the *queue* is behind GitHub, submit still fails
  `stale-draft` (correct, fail-safe) but the message doesn't tell the user the deck itself
  needs to refresh, and the banner button can't fix it. Consider triggering a queue/files
  refetch from `refreshDraftHead` or distinguishing the two cases in the submit error.
- **Cross-side range ordering is client-enforced only.** `assertValidReviewCommentAnchor`
  validates ordering for same-side ranges; cross-side ranges pass the backend unchecked and
  rely on the UI's `commentAnchorExists` gate (and ultimately GitHub's 422). Fine for a
  user-surface-only API; noting the asymmetry.
- `window.open(..., 'noopener')` in `openPopout` defeats the named-window reuse
  (`neondeck-pr-review-<n>`) — each click opens a fresh window. Cosmetic.
- `fetchPullRequestReviewThreads` still silently truncates at 5 pages; the file-cache head
  verification still skips caching silently on transient fetch errors — both would benefit
  from a log line.
- `reviewCommentPreview` still runs on the user's own draft-comment bodies in annotations,
  so markdown they wrote renders mangled in the preview line.
- In `submitReview`, `draft.body !== reviewBody` compares `null` to `''`, so submitting with
  an empty body and a body-less draft fires one redundant (harmless) draft save.

---

## Original findings (2026-07-05, pre-fix) — retained for history

Ordered by severity. `[bug]` = incorrect behavior, `[gap]` = plan requirement not met,
`[hardening]`/`[perf]`/`[test]`/`[nit]` as labeled. All items below were fixed in `77ab999`
as verified above.

### What held up in the original review (verified, no action was needed)

- **Neon has no path to review actions.** No `defineAction`/`defineTool` exists for reviews,
  thread replies, or resolution (`src/modules/pr-events/actions.ts`); safety entries for every
  new route say user-surface-only (`src/modules/safety/policy-entries.ts:764-823`);
  `neondeck_pr_comment` remains the only agent PR write.
- **One-live-draft invariant is enforced in the schema**, not just app code: partial unique
  index `idx_pr_review_drafts_live ON (repo, pr_number) WHERE status = 'draft'`
  (`src/runtime-home/app-db/schema.ts:289`, migration `20260705064138_pr_review_drafts`).
- **Modern line addressing only** — `side`/`line`/`start_line`, never `position`. Audit row
  written on submit with verdict, comment count, skipped count, and review URL.
- **Thread mutations verify PR ownership** before mutating (`verifyReviewThreadTarget`) —
  exceeds the plan; draft comment mutations are scoped to the route PR.
- **`@pierre/*` isolation held**: imports exist only in `web/src/features/diff-viewer/` and
  `web/src/features/pr-review/`; all consuming surfaces load the feature via `React.lazy`.
- **Deck profiles implemented in CSS**: portrait/compact hide the tree pane and show the file
  dropdown; compact collapses the review bar to count + submit.
- **File cache is harder than the plan asked**: the plan's "store under the client-supplied
  sha, a wrong sha is harmless" claim was actually a cache-poisoning bug (the files endpoint
  returns _current_ files regardless of the requested sha); the implementation verifies the
  live head before writing. Good deviation — don't "fix" it back.
- **Truncated/binary patch gaps are honest**: typed messages, placeholders, stats badges.

### 1. [bug] Every autosave silently re-anchored the draft's head SHA — **fixed**

`saveDraft` always sent the live `pr.headSha` and `upsertPrReviewDraft` unconditionally
overwrote `head_sha`, so the staleness banner vanished on the next body blur or verdict click
after a PR moved, against the plan's "no silent re-anchoring" contract.

### 2. [gap] The re-anchor flow did not exist — **fixed**

The PATCH route accepted only `body`; stale comments could only be deleted or skipped.

### 3. [bug] Review-body autosave could clobber in-flight typing — **fixed**

The draft-sync effect reset `reviewBody` on every refetch, losing keystrokes typed between a
blur-save and its invalidation refetch.

### 4. [bug, plausible] Selection→anchor mapping could emit ranges GitHub rejects — **fixed**

Reversal was normalized only for same-side selections; nothing enforced start-before-end.

### 5. [gap] Failed submits blamed every comment, not the failing one — **fixed**

`failingCommentIds` was all submitted ids, rendered as raw UUIDs.

### 6. [hardening] The server-side stale check could never fire from the shipped UI — **fixed**

Submit compared two client-supplied values; nothing validated against GitHub's actual head.

### 7. [gap] Prepared-diff approvals weren't next to the diff they gate — **fixed**

`ApprovalRow` had approve/deny with no diff affordance, violating the DIFF_UI DoD.

### 8. [bug, minor] Rename-only PR files were labeled "binary" — **fixed**

The binary heuristic (0/0/0 changes, no patch) matched pure renames.

### 9. [bug, minor] Draft-PUT race returned an unhandled 500 — **fixed**

Read-then-insert without a transaction; the unique-index constraint error propagated uncaught.

### 10. [gap] Thread reply/resolve ignored the returned thread and refetched everything — **fixed**

`invalidateThreads` refired the full event-state fetch per click.

### 11. [perf] One worker pool per mounted diff view — **fixed**

`DiffWorkerProvider` lived inside `UnifiedPatchView`; hoisted per surface.

### 12. [gap] No pop-out affordance, and the docs didn't recommend it for compact — **fixed**

Compact hides verdicts/textarea, so pop-out was the only full-review path — and it didn't exist.

### 13. [gap] Review mutations accepted unregistered repos — **fixed**

Unlike `pr_comment`, the outward review mutations didn't gate on the repo registry.

### 14. [test] Plan-mandated fixtures missing or weakened — **fixed**

Scope-error surfacing untested (and the 403 heuristic was loose); the addressing matrix was
synthetic rather than from a captured real patch; no draft-race coverage.

### 15. [nit] Assorted — **mostly fixed**

`openDb` adoption, `lineNumber: 0` thread annotations, and pending-count cycling were fixed;
the log-line and preview-mangling nits remain (see "Remaining items" above).
