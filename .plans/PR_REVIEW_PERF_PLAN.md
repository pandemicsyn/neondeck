# PR Review / File Tree Performance Plan

Status: phases 1–5 implemented; real-PR verification complete; remediation pending discussion
Prior art: `.plans/archived/DIFF_UI_PLAN.md`, `.plans/archived/DIFF_REVIEW.md`

## 2026-07-17 reconciliation

PR #84 implemented phases 1–5 plus the original synthetic 305-file harness.
The old problem statement and findings remain below for audit history; they no
longer describe the current architecture. The current path uses registered
local git objects, a metadata-only file list, per-file patch reads, an
optimistic popout target, and a review-threads-only endpoint. PR #115 later
hardened refresh and popout loading behavior.

Phase 6 has now been run against a real registered repository and production
browser build. The intended architecture is sound, but the end-user tree,
first-patch, threads, and cold-fetch targets did not all pass. No production
optimization was made during this measurement pass; the candidate fixes remain
behind the performance discussion gate.

## Original problem (retained for history)

Opening the PR review popout on a large PR has a noticeable delay before the
file tree and first diff render. The whole review surface is fed by the GitHub
REST API, serially, with all patch text shipped up front.

## Original data path (retained findings)

1. **Popout boot waterfall.** `openPopout` opens a fresh window at
   `/review?repo=&number=` (`web/src/features/pr-review/GitHubPrReview.tsx:626`).
   The new window boots the SPA, lazy-loads the `GitHubPrReview` chunk, and
   `PrReviewPopoutPage` blocks on `getGitHubPullRequest` (PR detail + check
   summary, multiple GitHub calls) before the review component even mounts
   (`web/src/features/pr-review/PrReviewPopoutPage.tsx:30`). Only then do the
   files / review-threads / draft queries start. Nothing runs in parallel.
2. **Files fetch is serial REST pagination.** `GET /api/github/prs/:o/:r/:n/files`
   → `getGitHubPrFiles` (`src/modules/pr-events/service.ts:140`) →
   `fetchPullRequestFilesWithCache` (`src/modules/github/pr-file-cache.ts`).
   On cache miss it walks `/pulls/N/files` at 100 files per page **sequentially**
   (`src/modules/github/pull-requests.ts:199`), each page carrying full patch
   text, then makes an extra PR-detail call just to verify the head SHA before
   caching. A 400-file PR is 4+ sequential round trips and several MB of JSON,
   valibot-validated on every request.
3. **Review threads pay for full event state.** The threads endpoint calls
   `fetchEventState` → `fetchPullRequestEventState`
   (`src/modules/github/pull-requests.ts:77`), which fetches detail, commits,
   reviews, review threads, check suites, check runs, and branch permissions —
   roughly seven request groups — just to render the thread panel.
4. **GitHub truncates large diffs.** The REST API omits `patch` for large files
   and caps the file list, so big PRs are both slow _and_ incomplete (the UI
   already shows "N truncated" badges).
5. **All patches ship up front.** The file tree cannot render until every
   patch for every file has been fetched, parsed, and transferred, even though
   the viewer renders one file at a time (`web/src/features/diff-viewer/MultiFileView.tsx`).
6. **Cache-busting query keys.** Client query keys include `updatedAt`
   (`web/src/features/pr-review/queries.ts:24`), so any PR activity (a comment)
   forces a refetch round trip even when the head SHA is unchanged. The SQLite
   cache still hits server-side, but the transfer + validation repeats.

## Direction: local git as the diff source

We already have every building block:

- The repo registry stores a local `path` per repo
  (`repoConfigSchema`, `src/runtime-home/schemas.ts:298`).
- `gitDiff` (`src/repo-edit/git.ts:98`) already produces `RepoDiffFile`
  metadata via `--name-status`/`--numstat` plus per-path patches with a
  `maxPatchBytes` guard — exactly the `DiffFilePatch` shape the viewer consumes.
- The prepared-diffs feature already serves a **file list endpoint and a
  per-file diff endpoint separately** from a local worktree
  (`/prepared-diffs/:id/files` and `/prepared-diffs/:id/files/diff`,
  `src/server/routes/autopilot.ts:151`). The PR review surface should work the
  same way.

Key insight: we do **not** need a checkout/worktree to diff a PR. We only need
the objects. `git fetch origin +refs/pull/<n>/head` (pull refs live on the base
repo, so this works for fork PRs too) followed by
`git diff <merge-base> <headSha>` is one incremental network op and then
instant local reads, with no truncation.

## Phases

### Phase 1 — Local PR diff provider (backend) — completed in PR #84

- New module `src/modules/pr-local-diffs/`:
  - Resolve the PR repo to a registered `RepoConfig` by `github.owner/name`.
  - Ensure objects exist locally: skip the fetch when both SHAs resolve
    (`git cat-file -e <sha>^{commit}`); otherwise
    `git fetch origin +refs/pull/<n>/head` and the base ref. Object-only —
    never touches the working tree or creates a worktree.
  - Compute `git merge-base <baseSha> <headSha>`; diff merge-base → head.
  - Extend `gitDiff` to accept an explicit `head` ref (today it diffs base vs
    the working tree; `git diff <base> <head>` is a trivial extension).
  - Return the file metadata list (path/status/additions/deletions) _without_
    patches, and per-file patches on demand with the existing `maxPatchBytes`
    guard.
- Single-flight the fetch per repo (reuse `src/modules/worktrees/locks.ts` or
  an in-process mutex) so concurrent viewers don't stampede `git fetch`.
- Fallback: unregistered repo, missing remote, or any git failure → the
  existing GitHub API path, unchanged.

### Phase 2 — API split: file tree vs patches — completed in PR #84

- `GET /prs/:o/:r/:n/files` gains `patches=all|none` (default `all` for
  compatibility) and `source=auto|local|github` (`auto`: local when the repo is
  registered, else GitHub).
- New `GET /prs/:o/:r/:n/files/diff?path=&head=` returning a single file's
  patch, mirroring the prepared-diffs file-diff response shape.
- Keep the SQLite payload cache for the GitHub fallback only; for the local
  source, git _is_ the cache (optionally memoize merge-base per
  `(repo, baseSha, headSha)`).

### Phase 3 — Frontend lazy patch loading — completed in PR #84

- Split queries: `useGitHubPullRequestFileList` (metadata only — renders
  `FileTreePane` immediately) and `useGitHubPullRequestFilePatch(path)` for the
  selected file, react-query cached per `(repo, number, headSha, path)`.
- Prefetch the first renderable file alongside the list, and prefetch tree
  neighbors on selection.
- `MultiFileView` already accepts `isLoadingPatch`/`patchError` — wire per-file
  loading states through.
- Draft-comment staleness (`patchAnchorIndexesByPath` in
  `web/src/features/pr-review/review-helpers.ts`) currently needs all patches.
  Rather than blocking on everything, fetch patches eagerly only for files that
  carry draft comments or unresolved threads (a small set), lazily for the rest.

### Phase 4 — Kill the popout waterfall — completed in PR #84

The URL-priming path shipped. The conditional bootstrap endpoint was not needed
for that implementation and remains deferred.

- Put `headSha` (and title) in the popout URL. The popout can then start the
  file-list query immediately, in parallel with the PR detail query, and paint
  the header from URL params while both load.
- If that's not enough, add a `GET /prs/:o/:r/:n/review-bootstrap` endpoint
  returning detail + file list in one round trip. Start with the URL-param
  approach; it's nearly free.

### Phase 5 — Slim the review-threads fetch — completed in PR #84

- Add a threads-only fetcher (just the review-threads calls) and use it for
  the review surface. Keep the full `fetchPullRequestEventState` for watchers
  and autopilot triage, which actually need commits/checks/permissions.

### Phase 6 — Verification and targets — measured 2026-07-17

- Add a timing harness against a large fixture PR (300+ files) covering: tree
  visible, first patch rendered, threads visible.
- Targets: warm (repo registered, objects fetched) tree < 500ms and first
  patch < 1s; cold (fetch needed) < 3s. GitHub-fallback path no worse than
  today.
- Extend existing tests: `src/repo-edit` git tests for the `head` ref support,
  pr-file-cache tests for the `patches=none` shape,
  `GitHubPrReview.test.ts` for lazy patch states.

The implementation tests and synthetic 305-file harness shipped with PR #84.
The new `npm run bench:pr-review` command measures the actual API and production
browser path against an immutable PR revision. Results remain local evidence,
not timing assertions in the unit suite.

## Real registered PR result

Target: open `Kilo-Org/kilocode#12204` at head
`3e0d20c03d43124ac1bc7841ba4ba6aa503d96bd`, with 1,019 files, 45,053
additions, 23,744 deletions, 47 review threads, and two unresolved threads on
two paths. Both head and base objects were absent before the first local call,
so the initial auto result is a genuine cold measurement.

| Path                           |                                           Result |                         Budget | Verdict                                   |
| ------------------------------ | -----------------------------------------------: | -----------------------------: | ----------------------------------------- |
| Cold local metadata            | 4,978 ms; 295,250 B; 1,019 files; zero truncated |                     < 3,000 ms | Miss                                      |
| Warm local metadata            |                                    311 ms median |    < 500 ms backend diagnostic | Pass                                      |
| Warm sequential first patch    |                                    643 ms median |  < 1,000 ms backend diagnostic | Pass                                      |
| Production tree visible        |                     869 ms median (852–1,057 ms) |                       < 500 ms | Miss                                      |
| Production first patch visible |                 1,971 ms median (1,944–2,244 ms) |                     < 1,000 ms | Miss                                      |
| Production threads visible     |                 2,183 ms median (2,065–2,495 ms) |        < 500 ms harness target | Miss                                      |
| Production LCP / CLS           |                    876 ms median / 0.0012 median |                    exploratory | Healthy                                   |
| Four concurrent local patches  |                                    1,952 ms wall | compare with 643 ms sequential | Contention confirmed                      |
| GitHub fallback, cold          |          3,894 ms; 764,826 B; one truncated file |       no worse than prior path | Faster cold, incomplete and 2.6× metadata |
| GitHub fallback, cached        |                                 24 ms; 764,826 B |       no worse than prior path | Fast cache hit, larger response           |

The three-sample production-browser run had no long tasks. Median FCP was 464
ms. Every sample started two review-thread requests after optimistic PR state
was replaced by authoritative detail. One sample fully transferred both copies
(762,488 B of thread JSON and 1,122,324 B total API transfer); the other samples
aborted one copy after it started. A complete trace also reproduced two aborted
unresolved-thread patch reads followed by two replacements, with the last API
response completing around 3.7 seconds.

## Confirmed follow-up candidates — discuss before implementation

1. **Stabilize review-thread identity.** `reviewThreads(pr)` still includes
   `pr.updatedAt`. The popout's synthetic timestamp and later authoritative
   timestamp create two query identities for the same revision. Avoid that
   optimistic-to-authoritative key churn while preserving explicit SSE,
   mutation, and refresh invalidation for real thread changes.
2. **Reuse immutable local metadata.** `readLocalPullRequestFileDiff()` first
   recomputes metadata for all 1,019 files, then runs the path-scoped diff.
   Active, neighbor, draft, and unresolved paths repeat that full work in
   parallel. Cache or single-flight metadata by `(repo, mergeBase, head)` and
   share it with per-file reads before considering a broad concurrency cap.
3. **Prioritize the active patch.** Re-run after metadata reuse. If neighbor
   prefetch still competes with first-patch latency, start adjacent and
   unresolved background reads only after the active patch settles.
4. **Revisit cold fetch last.** The 4.98-second object fetch misses the target,
   but it is a one-time revision cost. Separate network fetch time from local
   metadata time before changing refspecs or the `<3s` budget.

Acceptance for a follow-up PR is the same real target with no duplicate thread
request, no abandoned patch request caused by PR-detail settlement, tree under
500 ms, first patch under 1 second, and no regression to fallback completeness.
Raw results are gitignored at
`benchmarks/results/pr-12204-real-local.json`.

## Risks / notes

- **Fork PRs**: `refs/pull/N/head` lives on the base repo's remote. Resolve
  the correct remote from `RepoConfig.github`; if `origin` doesn't match,
  fall back to the GitHub path rather than guessing remotes.
- **Patch parity**: `@pierre/diffs` and `shared/patch-anchors` consume unified
  patch text. Use `git diff --no-color` with default 3-line context to match
  GitHub's `patch` field format.
- **Staleness**: local objects for a PR head can lag a force-push; always key
  by the PR detail's current `headSha` and fetch when it's not resolvable.
- **Offline/degraded**: local source still works for already-fetched heads;
  GitHub fallback covers the rest.
