# PR Review / File Tree Performance Plan

Status: complete for now; phases 1–5, real-PR verification, request-path remediation, active-patch prioritization, and warm review-thread remediation are complete; the missed tree, cold-object-fetch, and cold-thread budgets are explicitly deferred below
Prior art: `.plans/archived/DIFF_UI_PLAN.md`, `.plans/archived/DIFF_REVIEW.md`

## 2026-07-18 completion-for-now decision

This specialized workstream is complete for now, not complete against every
retained budget. The production tree median remains 642 ms against the <500 ms
target. The one-time cold local object fetch remains 4,978 ms against the
<3,000 ms target. The uncached lean review-thread surface remained 1,511 ms,
and its initial GitHub-backed read remained 655 ms, outside the warm UI path
that reached a passing 459 ms median through bounded 15-second reuse. These
misses are deferred future performance work; none is reclassified as passing.

The implemented data path, immutable measurements, and completed remediation
items remain active foundations for the broader diff plan. Phase B can proceed
because the remaining misses are now explicit, measured deferrals rather than
unreconciled acceptance gaps. Future work should remeasure the same immutable
target before changing implementation or relaxing a retained budget.

## 2026-07-18 shared Phase A fixture baseline

The broader diff-improvements Phase A now has deterministic 8-file, 90-file,
and 305-file registered-repository fixtures through
`npm run bench:review-fixtures`. The recorded five-sample warm medians were
73.2/73.1/75.6 ms for metadata-only trees and 271.0/274.5/272.4 ms for the
first patch, inside the existing 500 ms and 1,000 ms targets. Results are
retained in `benchmarks/results/review-fixture-baseline.json`. This shared
fixture evidence complements, rather than replaces, the immutable real-PR and
production-browser evidence below.

## 2026-07-18 final Phase B audit evidence

The lead reran `npm run bench:review-fixtures` on Node 26.4.0. The large
committed-PR fixture recorded 41.9 ms tree, 163.7 ms first-patch, and 0 ms
in-process thread-projection medians, inside the retained 500/1,000/500 ms
fixture budgets. This deterministic harness exercises `pr-local-diffs` only;
it does not replace the retained production-browser misses below.

A dedicated 305-changed-file worktree approximation measured at the pre-final
PR #154 measurement commit `aa8716783874fdf9c38bfa5fdd396b00df779788` on Node
26.4.0/arm64 exercised the production Phase B step 5 functions. The fixture
contained 120 modified, 30 deleted, 25 renamed, and 130 added files. Five warm
samples produced:

| Production B5 path           |   Median | Range          | Retained budget / verdict |
| ---------------------------- | -------: | -------------- | ------------------------- |
| Repo unscoped metadata       | 140.9 ms | 134.8–143.4 ms | tree <500 ms / pass       |
| Prepared unscoped metadata   | 137.0 ms | 134.4–139.0 ms | tree <500 ms / pass       |
| Repo scoped active patch     | 179.1 ms | 177.7–188.1 ms | patch <1,000 ms / pass    |
| Prepared scoped active patch | 177.2 ms | 173.9–181.1 ms | patch <1,000 ms / pass    |

The approximation exercised `readRepoDiff`,
`readPreparedDiffChangedFiles`, `readStableDiffMetadata`,
`gitWorktreeRevision`, and expected-revision checks before and after scoped
patch reads in `readRepoDiff` and `readPreparedDiffFileDiff`. The final PR #154
commit after the measurement changed only prepared-summary stable-read code
and coverage, not those measured paths. Machine-local raw evidence was retained
at `/private/tmp/neondeck-pr154-b5-results-exact-aa87167.json`.

The mounted prepared/Kilo 30-second fingerprint polling cadence and changed-path
metadata query are bounded, and patch bodies are not loaded by the poll.
Content work is not byte- or time-bounded: `gitWorktreeRevision` hashes the full
content of every changed regular file. Pathological huge changed files can
therefore make a poll expensive. No caching or hard byte/time bound was added
during the Phase B audit because that changes revision identity and freshness
semantics; it remains an explicit deferred performance limitation for lead/user
discussion.

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
behind the performance discussion gate. A later 2026-07-17 remediation pass,
documented below without removing the baseline, implemented the two approved
request-path fixes and repeated the same real-PR harness.
The agreed active-patch pass then delayed neighbor, draft, and unresolved-file
reads until the selected patch settled and repeated the immutable target again.

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

## 2026-07-17 approved remediation result

The follow-up kept the local object architecture and changed only the two
measured repeat-path causes:

- Review threads now use their actual server contract as the query identity:
  `(repo, PR number)`. File data remains revision-keyed. Mutations still update
  or invalidate the stable thread entry, and a later authoritative PR
  `updatedAt` change explicitly invalidates it. The initial
  optimistic-to-authoritative settlement establishes the refresh baseline
  without starting a second request.
- Metadata-only local diffs are cached for 10 minutes in an eight-revision LRU
  keyed by `(repo path, merge-base, head)`. Concurrent misses single-flight;
  failures are not cached. Per-file reads also reuse one registry/ref resolution
  within the request. Patch text is not cached.

The production server was restarted before the final run, so `initial auto` is
an empty in-process metadata-cache measurement with already-present git
objects, not a second cold-object fetch. The immutable PR target, browser,
machine, and three-sample method are otherwise unchanged.

| Path                              |                Baseline |       Remediated | Change / verdict                                   |
| --------------------------------- | ----------------------: | ---------------: | -------------------------------------------------- |
| Warm local metadata               |                  311 ms |            90 ms | 71.2% faster; pass                                 |
| Warm sequential first patch       |                  643 ms |           303 ms | 52.9% faster; pass                                 |
| Four concurrent local patches     |                1,952 ms |         1,055 ms | 46.0% faster                                       |
| Production tree visible           |                  869 ms |           622 ms | 28.4% faster; still 122 ms over target             |
| Production first patch visible    |                1,971 ms |         1,195 ms | 39.4% faster; still 195 ms over target             |
| Production threads visible        |                2,183 ms |         1,946 ms | 10.9% faster; GitHub thread request remains 917 ms |
| Review-thread requests per sample |                       2 |                1 | duplicate eliminated in all samples                |
| Aborted patch reads               | 2 in the complete trace | 0 in all samples | optimistic settlement no longer churns paths       |
| Last API response                 |                3,631 ms |         2,782 ms | 23.4% earlier                                      |

The duplicate full-transfer baseline sample used 762,488 bytes for threads and
1,122,324 bytes for all APIs. Every remediated sample used 381,244 thread bytes
and 742,850 total API bytes: 50% less thread transfer and 33.8% less total API
transfer than that reproduced duplicate case. The final direct DevTools trace
measured 551 ms LCP, 0.00 CLS, and the same 39 ms Pierre forced reflow with no
estimated savings. The result confirms the request/backend path, rather than
React or Pierre rendering, remains the next decision point.

## 2026-07-17 active-patch priority result

The selected patch now owns the initial patch-request slot. Neighbor,
draft-comment, and unresolved-thread patch queries are derived separately and
start only after the active query has data or has failed. Moving neighbor
warming into that same TanStack Query group also makes those reads cancellable
when selection changes.
Deferred draft anchors remain unknown until their background patches start;
comments on files that disappeared from the revision still become stale.

The production server and browser harness were restarted, while the same
immutable revision and already-present git objects were retained. Current
backend diagnostics were 63 ms for warm metadata, 153 ms for a sequential
patch, and 528 ms for four concurrent paths. Those machine-local values are
reported as run context rather than attributed to the frontend scheduling
change.

| Path                                      | Request-path remediation | Active priority | Change / verdict                                   |
| ----------------------------------------- | -----------------------: | --------------: | -------------------------------------------------- |
| Production tree visible                   |                   622 ms |          612 ms | 1.6% faster; still 112 ms over target              |
| Production first patch visible            |                 1,195 ms |          798 ms | 33.2% faster; passes all three samples             |
| Production threads visible                |                 1,946 ms |        1,724 ms | 11.4% faster; GitHub thread fetch remains dominant |
| Patch requests per browser sample         |                        6 |               4 | 33.3% fewer                                        |
| Patch requests started before first paint |             not recorded |        1 median | only the active read in the median sample          |
| Aborted patch reads                       |                        0 |               0 | stable in all samples                              |
| Last API response                         |                 2,782 ms |        2,021 ms | 27.4% earlier                                      |

The three first-patch samples were 771, 798, and 948 ms. The resource-order
probe counted only the active request before Pierre's first line in two runs;
in one run, the first background read launched after the active query settled
but before the custom element painted. A direct DevTools trace measured 498 ms
LCP, 0.00 CLS, and a 36 ms Pierre forced-reflow total with no estimated
user-visible savings.

## 2026-07-18 review-thread surface result

A production-only follow-up isolated the remaining thread delay. The previous
1,724 ms result is retained above, but the rerun found that its browser origin
included the Vite development client despite being described as production.
React Strict Mode could start and abort an initial request in that mode. The
benchmark now detects Vite development mode and refuses it unless
`--allow-development` is explicit. It also records failed and aborted API
requests plus thread request start, response end, duration, bytes, and
post-response render time.

The clean production baseline still missed: one 381 KB thread response took
about 810 ms directly and thread visibility measured 1,644 ms median. Three
instrumented reloads showed a roughly 362 ms request start, 1,011 ms request
duration, and only 11 ms of React work after the response. This confirmed the
GitHub GraphQL path, not TanStack Query, React, or Pierre rendering, as the
bottleneck.

The review surface now uses a dedicated GitHub query that omits diff hunks,
review/database ids, and pull-request backreferences that the UI does not read.
The full Flue action continues using the full-fidelity query. The HTTP response
also omits duplicate unresolved-thread and unresolved-comment collections; the
client derives unresolved threads from the canonical list. The lean uncached
run reduced thread transfer from 381,244 B to 58,240 B, but still measured
1,511 ms thread visibility because the GitHub request remained 906–1,119 ms.

Because the lean query could not reach the warm budget alone, it is backed by a
small in-process cache: 15-second TTL, 16 entries, token-scoped keys, and
explicit invalidation after review submission, thread reply, and
resolve/unresolve. Reads invalidated while in flight are not stored. In-flight
requests are not shared, so one browser cancellation cannot cancel another
caller's work. Browser cancellation is propagated through the GraphQL request
to GitHub.

| Path                           | Active priority | Lean, no cache | Lean + warm cache | Change / verdict                      |
| ------------------------------ | --------------: | -------------: | ----------------: | ------------------------------------- |
| Production tree visible        |          612 ms |         639 ms |            642 ms | Still misses; separate tree follow-up |
| Production first patch visible |          798 ms |         924 ms |            934 ms | Median passes                         |
| Production threads visible     |        1,724 ms |       1,511 ms |            459 ms | 73.4% faster; median passes           |
| Initial backend thread read    |          917 ms |         684 ms |            655 ms | Cold GitHub round trip remains        |
| Warm backend thread read       |    not recorded | not applicable |            6.8 ms | Short-lived in-process reuse          |
| Thread transfer per sample     |       381,244 B |       58,240 B |          58,240 B | 84.7% smaller                         |
| Total API transfer per sample  |       742,850 B |      400,821 B |         400,821 B | 46.0% smaller                         |
| Thread render after response   |    not recorded |        16.8 ms |            6.5 ms | Rendering remains negligible          |
| Aborted or failed API requests |               0 |              0 |                 0 | Stable production path                |

The final three thread samples were 608, 452, and 459 ms. The first sample's
604 ms FCP made a sub-500 ms thread paint impossible even though its cached
thread request took 23 ms; the median satisfies the warm harness target. A
separate final DevTools trace measured 530 ms LCP, 0.00 CLS, one successful
thread request, and zero estimated FCP/LCP savings from render-blocking
resources. The cold first read remains explicitly outside the warm-cache pass.

## Confirmed follow-up candidates and remediation status

1. **Completed — stabilize review-thread identity.** `reviewThreads(pr)`
   included `pr.updatedAt`. The popout's synthetic timestamp and later
   authoritative timestamp created two query identities for the same revision.
   The stable PR-scoped key plus explicit mutation/activity invalidation now
   produces one request per sample and no settlement-driven patch abandonment.
2. **Completed — reuse immutable local metadata.**
   `readLocalPullRequestFileDiff()` recomputed metadata for all 1,019 files,
   then ran the path-scoped diff. The bounded revision cache and concurrent
   single-flight reduced the sequential patch median from 643 to 303 ms and
   four-path wall time from 1,952 to 1,055 ms.
3. **Completed — prioritize the active patch.** The retained remediation result
   left first patch 195 ms over the browser target. Active patch work is now
   isolated from adjacent, draft, and unresolved background reads until it
   settles. The next run reached a 798 ms median and passed the target in all
   three samples without abandoned reads.
4. **Completed — slim and briefly reuse review-surface threads.** The web path
   now uses an 84.7% smaller query response plus a bounded 15-second cache with
   mutation invalidation and race protection. Production thread visibility is
   459 ms median, while the full-fidelity Flue action is unchanged.
5. **Deferred — revisit cold fetch.** The 4.98-second object fetch misses the target,
   but it is a one-time revision cost. Separate network fetch time from local
   metadata time before changing refspecs or the `<3s` budget.
6. **Deferred — revisit production tree visibility.** The final 642 ms median
   remains 142 ms over the `<500 ms` budget even though the warm backend
   diagnostic passes. Profile the production boot/query/render boundary before
   changing Pierre or the tree budget.
7. **Deferred — revisit uncached review-thread latency.** Bounded warm reuse
   brings the median to 459 ms, but the uncached lean surface remained 1,511 ms
   and the initial GitHub-backed read remained 655 ms. Preserve mutation
   invalidation and cancellation while evaluating any more durable reuse or
   GitHub query-path change.

Acceptance remains partial on the same real target: duplicate thread requests and
settlement-driven abandoned patch reads are eliminated, the first-patch browser
budget now passes, warm thread visibility passes on the median, backend targets
pass, and fallback code is unchanged. The tree and one-time cold-object budgets
still miss and are explicitly deferred; a cold GitHub thread read also remains
slower than the warm UI budget and is explicitly deferred. The workstream is
complete for now on that basis. Raw baseline, remediation, and
active-priority results are
gitignored at
`benchmarks/results/pr-12204-real-local.json` and
`benchmarks/results/pr-12204-remediation-local.json`, and
`benchmarks/results/pr-12204-active-priority-local.json`.

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
