# PR Review / File Tree Performance Plan

Status: proposed
Prior art: `.plans/archived/DIFF_UI_PLAN.md`, `.plans/archived/DIFF_REVIEW.md`

## Problem

Opening the PR review popout on a large PR has a noticeable delay before the
file tree and first diff render. The whole review surface is fed by the GitHub
REST API, serially, with all patch text shipped up front.

## Current data path (findings)

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
   and caps the file list, so big PRs are both slow *and* incomplete (the UI
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

### Phase 1 — Local PR diff provider (backend)

- New module `src/modules/pr-local-diffs/`:
  - Resolve the PR repo to a registered `RepoConfig` by `github.owner/name`.
  - Ensure objects exist locally: skip the fetch when both SHAs resolve
    (`git cat-file -e <sha>^{commit}`); otherwise
    `git fetch origin +refs/pull/<n>/head` and the base ref. Object-only —
    never touches the working tree or creates a worktree.
  - Compute `git merge-base <baseSha> <headSha>`; diff merge-base → head.
  - Extend `gitDiff` to accept an explicit `head` ref (today it diffs base vs
    the working tree; `git diff <base> <head>` is a trivial extension).
  - Return the file metadata list (path/status/additions/deletions) *without*
    patches, and per-file patches on demand with the existing `maxPatchBytes`
    guard.
- Single-flight the fetch per repo (reuse `src/modules/worktrees/locks.ts` or
  an in-process mutex) so concurrent viewers don't stampede `git fetch`.
- Fallback: unregistered repo, missing remote, or any git failure → the
  existing GitHub API path, unchanged.

### Phase 2 — API split: file tree vs patches

- `GET /prs/:o/:r/:n/files` gains `patches=all|none` (default `all` for
  compatibility) and `source=auto|local|github` (`auto`: local when the repo is
  registered, else GitHub).
- New `GET /prs/:o/:r/:n/files/diff?path=&head=` returning a single file's
  patch, mirroring the prepared-diffs file-diff response shape.
- Keep the SQLite payload cache for the GitHub fallback only; for the local
  source, git *is* the cache (optionally memoize merge-base per
  `(repo, baseSha, headSha)`).

### Phase 3 — Frontend lazy patch loading

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

### Phase 4 — Kill the popout waterfall

- Put `headSha` (and title) in the popout URL. The popout can then start the
  file-list query immediately, in parallel with the PR detail query, and paint
  the header from URL params while both load.
- If that's not enough, add a `GET /prs/:o/:r/:n/review-bootstrap` endpoint
  returning detail + file list in one round trip. Start with the URL-param
  approach; it's nearly free.

### Phase 5 — Slim the review-threads fetch

- Add a threads-only fetcher (just the review-threads calls) and use it for
  the review surface. Keep the full `fetchPullRequestEventState` for watchers
  and autopilot triage, which actually need commits/checks/permissions.

### Phase 6 — Verification and targets

- Add a timing harness against a large fixture PR (300+ files) covering: tree
  visible, first patch rendered, threads visible.
- Targets: warm (repo registered, objects fetched) tree < 500ms and first
  patch < 1s; cold (fetch needed) < 3s. GitHub-fallback path no worse than
  today.
- Extend existing tests: `src/repo-edit` git tests for the `head` ref support,
  pr-file-cache tests for the `patches=none` shape,
  `GitHubPrReview.test.ts` for lazy patch states.

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
