# PR Review Actions Plan (full deck review: comments, threads, verdicts)

Status: **active** — full specification for reviewing PRs _from_ the deck: inline comments, thread
replies, thread resolution, and submitted reviews with a verdict (Comment / Approve / Request
changes). Written 2026-07-04 against the implemented viewing stack from `.plans/archived/DIFF_UI_PLAN.md`
(its PR 1 and PR 2 are on main); this doc supersedes that plan's "review actions are v2" note.

## Purpose

The deck can now _see_ PRs — file tree, syntax-highlighted patches, review threads rendered
inline. The remaining gap is acting on what you see: today a review still ends with a tab switch
to github.com. This plan completes the loop so a PR from the queue can be reviewed end-to-end on
the deck: select lines → draft comments → reply/resolve threads → submit one review with a
verdict — with drafts that survive a deck reload, and with review verdicts kept strictly
human-only.

## Ground Rules (verified against main, 2026-07-04)

The viewing implementation this builds on, by name:

- **Frontend**: `web/src/features/pr-review/` (`GitHubPrReview.tsx`, `queries.ts` — query keys
  already include `headSha` and `updatedAt`) composing `web/src/features/diff-viewer/`
  (`UnifiedPatchView`, `DiffWorkerProvider`, `FileTreePane`, `MultiFileView`). The viewer already
  defines `DiffReviewAnnotation` (`side: 'additions' | 'deletions'`, `lineNumber`, metadata with
  `isResolved`/`isOutdated`) and renders existing review threads read-only via `@pierre/diffs`
  annotations.
- **Backend**: `src/modules/github/` is the github domain (`pull-requests.ts`, `comments.ts`,
  `schemas.ts`); routes in `src/server/routes/github.ts` include
  `GET /prs/:owner/:repo/:number/files` (`github_pr_files_get`) and
  `POST /prs/review-threads`, whose payload already carries **`threadId` — the GraphQL node id**
  needed for reply/resolve mutations. `POST /prs/comment` (issue-level comment) exists and stays
  Neon's only PR-writing action.
- **Persistence**: Drizzle is live — `src/runtime-home/app-db/schema.ts` + generated migrations
  with baseline/parity tests. New tables go through `db:generate`, per
  `.plans/DB_MIGRATIONS_PLAN.md`.
- **`@pierre/diffs` capabilities for authoring** (verified in 1.2.12): line selection
  (`SelectedLineRange`, selection events) and annotation render slots accept arbitrary React —
  the composer renders as an annotation; no fork or patch of the library is needed.
- **Trust precedent**: outward mutations are recorded (workflow summaries/audit rows), and
  "resolution is user-owned, not model-callable" is the house pattern.

## Non-Goals

- **Neon never reviews.** No Flue action or tool is created for review submission, verdicts,
  thread replies, or thread resolution. The routes are user-surface-only, enforced by simply not
  exposing them to the agent and recorded as such in `safety.ts`. Neon's PR-writing capability
  remains exactly `neondeck_pr_comment`.
- **No GitHub "pending review" server-side state.** Drafts live in Neondeck's app DB and submit
  as one atomic review-create call. (GitHub's create-pending-then-submit flow adds cross-system
  draft state for no user-visible gain here; revisit only if multi-device draft sync is wanted.)
- **No merge, close, label, or assignee actions.** Review only. Merge-from-deck is a separate
  decision with its own blast radius.
- **No suggested-changes blocks in v1** (```suggestion fences). Plain comment bodies; suggestions
  are a natural v1.1 since they're just body syntax.

## Data model

One new table via the Drizzle flow (`src/runtime-home/app-db/schema.ts` + `db:generate`):

```text
pr_review_drafts
  id            TEXT PK
  repo          TEXT NOT NULL            -- owner/name
  pr_number     INTEGER NOT NULL
  head_sha      TEXT NOT NULL            -- anchor snapshot at draft time
  verdict       TEXT                     -- 'comment' | 'approve' | 'request-changes' | NULL (unset)
  body          TEXT                     -- review summary body
  status        TEXT NOT NULL            -- 'draft' | 'submitted' | 'discarded'
  created_at / updated_at / submitted_at TEXT
  UNIQUE(repo, pr_number) WHERE status = 'draft'   -- one live draft per PR

pr_review_draft_comments
  id            TEXT PK
  draft_id      TEXT NOT NULL REFERENCES pr_review_drafts(id)
  path          TEXT NOT NULL
  side          TEXT NOT NULL            -- 'RIGHT' | 'LEFT' (maps from additions/deletions)
  line          INTEGER NOT NULL         -- end line (new-file numbering for RIGHT, old for LEFT)
  start_line    INTEGER                  -- multi-line ranges
  start_side    TEXT
  body          TEXT NOT NULL
  created_at / updated_at TEXT
```

Submitted/discarded drafts are retained (they are the local audit of what was reviewed from the
deck) and pruned by the same retention posture as other audit rows.

## Backend API (`src/modules/github/reviews.ts` + `src/server/routes/github.ts`)

Draft CRUD (app-DB only, no GitHub traffic):

```text
GET    /api/github/prs/:owner/:repo/:number/review-draft        # live draft or null
PUT    /api/github/prs/:owner/:repo/:number/review-draft        # upsert body/verdict/head_sha
POST   /api/github/prs/:owner/:repo/:number/review-draft/comments
PATCH  /api/github/review-draft-comments/:id
DELETE /api/github/review-draft-comments/:id
DELETE /api/github/prs/:owner/:repo/:number/review-draft        # discard
```

GitHub mutations (each returns the refreshed thread/review state so the UI re-renders without a
second round trip):

```text
POST /api/github/prs/:owner/:repo/:number/reviews
     # body: { draftId } — server loads the draft, validates head SHA (see staleness),
     # maps to REST create-review: { commit_id: head_sha, event: APPROVE | REQUEST_CHANGES |
     # COMMENT, body, comments: [{ path, side, line, start_line?, start_side?, body }] },
     # marks the draft submitted, writes the audit row.
POST /api/github/pr-threads/:threadId/reply     # body: { text } — GraphQL addPullRequestReviewThreadReply
POST /api/github/pr-threads/:threadId/resolve   # GraphQL resolveReviewThread
POST /api/github/pr-threads/:threadId/unresolve # GraphQL unresolveReviewThread
```

Implementation notes:

- `reviews.ts` follows the module conventions (Valibot schemas in `schemas.ts`, client mechanics
  reused from the existing REST/GraphQL client). Verify at implementation time which GraphQL
  mutations the token's scopes permit; surface a typed `insufficient-scope` error naming the
  scope rather than a raw 403.
- Line addressing uses the modern REST `side`/`line`/`start_line` fields (never the deprecated
  `position`). The frontend already computes side/line from `DiffReviewAnnotation` semantics —
  `additions → RIGHT` (new-file numbering), `deletions → LEFT` (old-file numbering). A fixture
  test must cover: single line each side, multi-line range, comment on a renamed file's path, and
  a file with multiple hunks.
- Submission is all-or-nothing: if GitHub rejects any comment (usually a bad anchor), nothing is
  posted, the failing comment ids come back in a typed error, and the UI marks them stale (below).
- Safety table: entries for every new route, classified as outward mutations,
  **user-surface-only** — mirrors how execution-approval resolution is annotated. No action/tool
  registration anywhere.

## UX specification (`web/src/features/pr-review/`)

**Composing.** Clicking/dragging line numbers in `UnifiedPatchView` (Pierre line selection)
opens a composer rendered as a pending annotation at the anchor: textarea, save/cancel, delete on
saved comments. Saved comments persist immediately via draft CRUD (autosave, no explicit "save
draft" button) and render visually distinct from existing GitHub threads (pending tone from
`DiffViewTone`).

**Review bar.** A sticky bar in the PR view whenever a draft exists: pending-comment count
(clicking cycles through anchors via the viewer's scroll targets), review body field (collapsed
until focused), verdict segmented control (Comment / Approve / Request changes), Submit, and
Discard (confirm). Submitting with zero comments and empty body is allowed only for
Approve (GitHub's own rule — match it client-side with a hint).

**Threads.** Existing thread annotations gain Reply (inline composer → immediate GraphQL post)
and Resolve/Unresolve. Replies are posted immediately, not drafted — they're conversational;
batching them with the review would surprise. The thread's `isResolved` state updates in place
from the mutation response.

**Staleness.** The draft stores `head_sha`. When the PR's live `headSha` (already in the queue
payload and query keys) differs from the draft's:

- a banner appears ("PR updated since your draft — N comments may be stale");
- the files view refetches; comments whose `path` no longer appears, or whose anchor line no
  longer exists in the new patch, are flagged stale and excluded from submission by default
  (individually re-anchorable by clicking the comment then a new line);
- submission sends `commit_id: <current headSha>` and only clean comments.

No silent re-anchoring — a comment never moves without the user seeing it move.

**Deck profiles.** Composer and review bar must work on `portrait`; on `compact` the review bar
collapses to count + submit and composing is allowed but cramped — the existing "pop out" via
`neondeck open` remains the recommended compact-profile path and the docs say so.

**Errors.** Scope errors, stale-anchor rejections, and rate limits render in the review bar with
the typed message; the draft is never lost by a failed submit.

## Audit

Submitting a review writes an audit row (repo, PR, verdict, comment count, review URL) through
the existing workflow-summary/audit mechanism so deck history shows what was reviewed from it.
Thread replies/resolutions are deliberately not audited individually (they're visible on GitHub
and low-stakes); the review submission is the recorded event.

## Delivery: one PR (sanctioned split: backend first)

1. **Backend commit(s)**: `pr_review_drafts`/`pr_review_draft_comments` migration via
   `db:generate`; `src/modules/github/reviews.ts` (draft store + submit mapping + thread
   mutations); routes; safety entries; audit row. Fixture tests: comment addressing matrix,
   all-or-nothing submit failure, scope-error surfacing, draft uniqueness, staleness validation
   (submit with mismatched head SHA → typed error).
2. **Frontend commit(s)**: composer annotations + autosaving draft state, review bar, thread
   reply/resolve, staleness banner + re-anchor flow, deck-profile behavior, api module additions
   with parsed responses.
3. **Docs**: dashboard docs page — "Reviewing PRs from the deck" gains the actions half,
   including the human-only boundary sentence; agent instructions unchanged.

Verification: `npm run check`; github fixture tests; `npm run build:web` (review UI stays inside
the lazy pr-review/diff-viewer chunks); manual end-to-end against a real test PR (draft two
comments on both sides → reload deck → draft intact → push a new commit to the PR → staleness
flow → submit Request changes) recorded in the PR description.

## Follow-ups: PR-files performance (recorded 2026-07-04, not part of this PR)

The implemented viewing path (`GET /prs/:owner/:repo/:number/files` →
`getGitHubPrFiles({ repo, prNumber }, paths)` in `src/modules/github/pull-requests.ts`) fetches
`pulls/:number/files` from the GitHub API per view, with client-side (React Query) caching only,
and honestly flags the API's gaps: the sanitized per-file shape is
`{ path, previousPath, status, additions, deletions, binary, patch, truncated, message }`, where
`truncated: true` + a message renders a placeholder instead of a diff. Two sized follow-ups, in
priority order. **Both must preserve that response shape exactly — the frontend never learns
which provider answered.**

### Follow-up 1 — server-side PR-files cache (small; ship on its own)

- **Table** (add to `src/runtime-home/app-db/schema.ts`, migration via `db:generate`):

  ```text
  github_pr_file_cache
    repo        TEXT NOT NULL           -- owner/name
    pr_number   INTEGER NOT NULL
    head_sha    TEXT NOT NULL
    payload     TEXT NOT NULL           -- JSON: the exact sanitized files array served today
    byte_size   INTEGER NOT NULL
    fetched_at  TEXT NOT NULL
    PRIMARY KEY (repo, pr_number, head_sha)
  ```

- **Key source**: the frontend already holds `headSha` (it's in `prReviewQueryKeys`). Thread it
  as an optional `?head=<sha>` query param on the existing route. Cache logic lives in a small
  `src/modules/github/pr-file-cache.ts` read-through wrapped around `getGitHubPrFiles`:
  - `head` present + row exists → serve `payload` (no GitHub traffic);
  - `head` present + miss → fetch from GitHub, store under the **client-supplied** sha, serve;
  - `head` absent → bypass the cache entirely (current behavior).
    Entries are immutable by construction (sha-keyed); a wrong/stale client sha merely creates an
    extra row that nothing reads again — harmless, pruned later.
- **Pruning** on write: keep the newest 3 rows per `(repo, pr_number)` and delete rows older
  than 30 days; both bounds constant, no config.
- **Skip caching** error responses and empty-files results — only cache `ok: true` payloads.
- **Tests**: hit path does zero GitHub calls (assert via injected fetch); miss stores + serves;
  prune keeps 3/PR; `head`-absent bypass; payload round-trips byte-identical.

### Follow-up 2 — local-checkout diff provider (larger; adopt when `truncated`

placeholders or missing hunk expansion actually bite)

- **Module**: `src/modules/github/local-pr-diff.ts`. Resolve the repo through
  `readRepoRegistrySnapshot` (`src/modules/repos/registry.ts`) by matching
  `repo.github.owner/name`; require `repo.path` to exist. Subprocess calls go through
  `src/lib/exec.ts` with explicit `timeoutMs` and `maxBuffer`, following the read-only git fact
  precedent of `readGitRepoStatus`/`readGitDiffSummary` (no execution-approval flow — nothing
  mutates the working tree).
- **Git sequence** (all against `repo.path`, never the working tree):

  ```sh
  git fetch --no-tags origin "+refs/pull/<n>/head:refs/neondeck/pr/<n>" "+<baseRef>:refs/neondeck/base/<n>"
  git merge-base refs/neondeck/base/<n> refs/neondeck/pr/<n>          # → MB
  git diff --name-status -M -z MB refs/neondeck/pr/<n>                # file list (+ renames)
  git diff -M --numstat -z MB refs/neondeck/pr/<n>                    # additions/deletions
  git diff -M MB refs/neondeck/pr/<n> -- <path>                       # per-file patch, on demand
  git update-ref -d refs/neondeck/pr/<n>; git update-ref -d refs/neondeck/base/<n>
  ```

  Diffing from the **merge-base** (three-dot semantics) is mandatory — diffing from the base tip
  shows upstream drift as PR changes. `baseRef` comes from the PR detail the queue already
  fetches. `refs/pull/<n>/head` exists on GitHub remotes for fork PRs too.

- **Mapping to the response shape**: `--name-status` → `status`/`previousPath` (R→`renamed` with
  both paths), `--numstat` → `additions`/`deletions` (`-` values mean binary → `binary: true`,
  `patch: null`, same message as today), per-file diff text → `patch`; `truncated` is always
  `false` from this provider. Enforce a per-file patch byte cap (reuse the API path's cap if one
  exists; otherwise 1 MiB) so a generated-file diff can't balloon the response — over-cap files
  degrade to `truncated: true` with a "diff too large to render" message, keeping the shape's
  meaning.
- **Provider selection** inside `getGitHubPrFiles`: config knob `github.prDiffSource:
'auto' | 'api' | 'local'` (default `auto` = local when the repo is registered and its path
  exists, else API). Any local failure (fetch error, merge-base failure, timeout) logs the reason
  and falls back to the API within the same request — the route never 500s because a checkout
  was cold. Record the provider used in the server log line only, not the response.
- **Concurrency + hygiene**: single-flight per `(repo, prNumber)` (concurrent views share one
  fetch); refs live only under `refs/neondeck/`, deleted in `finally`; a startup sweep deletes
  any leftover `refs/neondeck/pr/*` from crashed runs.
- **Seam caution**: when `.plans/EXEDEV_WORKSPACE_MODE_PLAN.md` lands its `WorkspaceApi`, this
  module's exec/path access must ride it so "local checkout" transparently means the VM checkout
  in exe.dev workspace mode. Until then, host-only is correct (there is no `WorkspaceApi` in the
  tree today — verified 2026-07-04).
- **Tests**: fixture repo built in a temp dir (real `git init` + commits) covering: clean PR
  diff equals GitHub-style three-dot output; **stale-base PR** (base advanced after branch) shows
  only PR changes; rename with edits; binary file; over-cap file degrades to `truncated`;
  fallback path when the ref fetch fails; ref cleanup after success, failure, and simulated
  crash (startup sweep).
- **Interaction with Follow-up 1**: the cache sits in front of both providers unchanged — it
  keys on the sha, not the source. Land the cache first; the local provider then only ever runs
  on cold shas.

Trigger discipline: ship Follow-up 1 on its own; hold Follow-up 2 until truncated-patch
placeholders or the lack of context expansion is a felt problem in real use — it's real machinery
(ref hygiene, fallback paths) that should be pulled by need, not pushed.

## Risks

- **Anchor mapping is the correctness core.** Side/line translation bugs post comments on wrong
  lines of real PRs. The fixture matrix is non-negotiable and must be built from a captured real
  patch, not synthetic hunks.
- **Token scope variance** (fine-grained PATs, org restrictions): typed `insufficient-scope`
  errors with the missing scope named; docs list required scopes next to the existing token
  setup.
- **Race with autopilot/watchers**: a watcher-triggered head change mid-compose is exactly the
  staleness flow; test it deliberately (it will happen constantly on active repos).
- **Prompt-injection surface unchanged**: thread bodies were already rendered read-only;
  composing adds no new model-visible content (Neon never sees drafts — they're app-DB rows with
  no action/tool exposure).
- **GitHub API drift**: reviews REST + threads GraphQL are stable, but verify the exact mutation
  names/fields against the live schema during implementation rather than from this doc.

## Definition of Done

- From the deck: select lines in a PR diff, write comments on both sides (including a multi-line
  range), reply to and resolve an existing thread, and submit one review with each verdict — all
  reflected on github.com exactly as authored.
- Drafts survive deck reloads and server restarts; a head-SHA change flags stale comments and
  nothing is ever posted to a moved anchor without explicit re-anchoring.
- Neon has no path to any of it: no action, no tool, safety entries say user-surface-only, and
  `neondeck_pr_comment` remains its only PR write.
- Submitted reviews appear in deck audit history; failed submissions never lose the draft.
- `npm run verify` passes; the addressing fixture matrix and staleness tests run in CI.
