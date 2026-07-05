# Diff & PR Viewing UI Plan (@pierre/diffs + @pierre/trees)

Status: **active** — planning doc for adopting Pierre's open-source rendering libraries
([diffs.com](https://diffs.com) → `@pierre/diffs`, [trees.software](https://trees.software) →
`@pierre/trees`) as the dashboard's diff and file-tree surface: reviewing prepared autopilot
diffs, viewing PRs, and inspecting agent edits. Written 2026-07-04 for implementation agents;
follows the `.plans/` conventions.

## Purpose

Neon constantly _produces and reasons about diffs_ — prepared autopilot fixes, Kilo task results,
repo-edit changes, skill patches, PR review feedback — but the dashboard renders none of them as
diffs. The AutopilotPanel shows prepared-diff _summary rows_ only; PR review happens by leaving the
deck for github.com; skill-patch candidates are approved from text. The human approval loop is the
product's trust backbone, and it currently runs blind.

`@pierre/diffs` + `@pierre/trees` close that gap with first-class, syntax-highlighted, virtualized
diff rendering and a path-first file tree — as libraries that plug into the existing Vite/React
dashboard, consistent with the "no framework re-housing" decision.

## Ground Rules (verified against npm + the installed packages + the codebase, 2026-07-04)

- **`@pierre/diffs@1.2.12`** — Apache-2.0, from The Pierre Computer Company. Built on Shiki.
  React entry (`@pierre/diffs/react`) exports the components we need:
  - `PatchDiff` — renders a **unified patch string** directly (exactly the shape Neondeck's
    diff endpoints already return);
  - `FileDiff` / `MultiFileDiff` — old/new file-contents rendering, single or multi-file;
  - `File` / `CodeView` — plain highlighted file views;
  - `UnresolvedFile` — merge-conflict rendering with pluggable resolution actions (future);
  - `Virtualizer` + a **worker pool** (`WorkerPoolContextProvider`, `@pierre/diffs/worker`) for
    off-main-thread highlighting;
  - an **annotation framework** (`DiffLineAnnotation`, render slots) and
    **accept/reject hunk UI** (`DiffAcceptRejectHunkConfig`) — the hooks for review actions;
  - split/stacked layouts, light/dark via Shiki themes (`@pierre/theme` ships as a dependency),
    line selection, hunk expansion, custom headers.
  - Peer deps `react ^18.3.1 || ^19` — Neondeck is on React 19.2 ✓.
- **`@pierre/trees@1.0.0-beta.5`** — Apache-2.0, path-first file tree on `@headless-tree/core`;
  React entry `<FileTree model={...} />`; built-in search; renders in a shadow root; public state
  keyed by canonical path strings (matches "changed files" lists 1:1). **Beta — pin exact**, same
  posture as the other pinned betas in this codebase.
- **Data is mostly already served.** Verified routes: prepared diffs —
  `GET /api/autopilot/prepared-diffs/:id/files` + `/:id/files/diff` (per-file unified diff);
  Kilo — `GET /api/kilo/tasks/:id/diff`, `/sessions/:id/diff`; repo-edit —
  `POST /api/repo-edit/repos/:repoId/diff`. **Missing**: a GitHub PR files/patches endpoint —
  `src/server/routes/github.ts` serves queue/event-state/review-threads/comment but nothing that
  returns a PR's file diffs. That is the one backend addition.
- **UI conventions to follow**: feature folders exist (`web/src/features/flue-chat`,
  `runtime-overview`) per REFACTOR_PLAN Phase 14; `deck-profile.ts` drives
  ultrawide/wide/portrait/compact arrangements — diff surfaces must degrade to the portrait
  sidebar and compact profiles; panels refresh via `/api/events/config` and React Query.
- **Trust posture**: viewing is read-only; the only mutations reachable from these surfaces are
  the _existing_ approval endpoints (prepared-diff approvals, learning candidate
  approve/reject) — no new mutation paths.

## Non-Goals

- **Not a text editor.** `@pierre/diffs` renders and annotates; it does not edit. "Edits" here
  means _reviewing agent-made edits_ (prepared diffs, skill patches, repo-edit results) with real
  diff UI — the editing loop stays chat + typed actions. If a hand-editing surface is ever
  wanted, that is a separate decision (and probably a separate tool).
- **PR review actions moved to their own spec.** Viewing shipped first as planned; the full
  review capability (inline comments, thread reply/resolve, human-only verdicts) is specified in
  `.plans/PR_REVIEW_ACTIONS_PLAN.md`.
- **No replacement of existing summary rows.** Compact rows stay (they're right for the deck's
  glanceable posture); diff views open from them.
- **No self-hosted Shiki grammar zoo.** Start with the bundled languages; trim via Vite config
  only if bundle size measurably hurts.

## Design

### Shared infrastructure (`web/src/features/diff-viewer/`)

One feature folder owns the Pierre integration; every surface composes it:

```text
web/src/features/diff-viewer/
  DiffViewer.tsx        # <UnifiedPatchView patch=... /> wrapper over PatchDiff: theme, layout,
                        # wrap/line-number defaults, empty/error states
  MultiFileView.tsx     # changed-files list + per-file PatchDiff, with FileTree sidebar when
                        # the deck profile has room (ultrawide/wide) and a compact file
                        # dropdown on portrait/compact
  FileTreePane.tsx      # @pierre/trees wrapper fed by path arrays; search on; selection →
                        # scroll/swap the active file diff
  worker.ts             # worker-pool setup (@pierre/diffs/worker via Vite `?worker`)
  theme.ts              # Shiki theme selection wired to the deck's light/dark; start from
                        # @pierre/theme, restyle toward Xeneon/Miami via CSS variables only
  queries.ts            # React Query hooks for the diff endpoints listed above
```

Decisions baked in:

- **`PatchDiff` is the workhorse** — every existing endpoint returns unified diffs, so no
  old/new-contents plumbing is needed server-side. `FileDiff`/`MultiFileDiff` stay available for
  future contents-based views.
- **Worker pool from day one.** Highlighting is the main-thread killer, and this dashboard runs
  on a companion display where jank is very visible. Mount `WorkerPoolContextProvider` inside the
  diff feature (not app-wide), so non-diff panels pay nothing.
- **Lazy-load the whole feature.** `React.lazy` the diff views so Shiki + workers stay out of the
  initial dashboard bundle; the deck boots as fast as today.
- **Deck-profile awareness is required, not polish.** Tree-beside-diff on `ultrawide`/`wide`;
  file dropdown + stacked diff on `portrait`/`compact`; stacked (not split) diff layout below
  `wide`.

### Surface 1 — Prepared-diff review (the approval loop, highest value)

AutopilotPanel's `PreparedDiffRow` gains an expand/inspect affordance opening a review view:
changed files (existing `/files` endpoint) in `FileTreePane`, per-file `PatchDiff` (existing
`/files/diff` endpoint), and the _existing_ prepared-diff approval/recovery actions placed next to
the diff they gate. Badges for verification status ride the file header slots. This turns
"approve a summary sentence" into "approve what you can see" — the single biggest trust upgrade
available in the UI.

### Surface 2 — PR viewing

- **Backend addition** (the one new endpoint): `GET /api/github/prs/:owner/:repo/:number/files`
  in the github domain/route — file list + per-file patch via the existing GitHub client
  (REST `pulls/:number/files` returns `filename`, `status`, `patch`; respect pagination and the
  API's per-file patch-size omissions — files with no `patch` render as "binary/too large, view
  on GitHub"). Sanitized like the rest of the GitHub surface; token stays server-side.
- **Frontend**: GitHubPrList rows open a PR view: title/branch/checks header (data already in the
  queue payload), `FileTreePane` + `PatchDiff` per file via `MultiFileView`. Review threads
  (existing `/prs/review-threads` route) render as read-only `DiffLineAnnotation`s on the
  matching lines where anchors resolve; unresolved-thread count in the header.
- Where it lives: `web/src/features/pr-review/` composing `diff-viewer`; the plugin registry
  entry stays thin per house style.

### Surface 3 — Agent-edit review (skill patches, Kilo, repo-edit)

- **Skill patches** (LearningOperatorPanel): candidates store full unified diffs in
  `patch_json` — render with `UnifiedPatchView` beside the existing approve/reject buttons.
  Smallest lift, immediate payoff for the learning loop.
- **Kilo tasks/sessions**: task rows link to a diff view over the existing kilo diff endpoints.
- **Repo-edit**: recent repo-edit events gain a "view diff" affordance using the repo-edit diff
  route.
- **Future (recorded, not v1)**: `DiffAcceptRejectHunkConfig` maps naturally onto per-hunk
  approval if prepared-diff or skill-patch review ever wants finer-than-whole-diff decisions;
  `UnresolvedFile` maps onto worktree sync conflicts. Both are wired-for, not built.

## Delivery: two PRs

### PR 1 — diff-viewer feature + surfaces with existing data

1. Add `@pierre/diffs` (+`@pierre/trees`, exact pins); licenses noted (Apache-2.0).
2. `web/src/features/diff-viewer/` (wrapper, tree pane, worker pool, theme, queries, lazy
   loading) with component tests for patch parsing edge cases (empty diff, huge file, no
   trailing newline).
3. Prepared-diff review surface in AutopilotPanel.
4. Skill-patch diff rendering in LearningOperatorPanel.
5. Kilo + repo-edit diff affordances.
6. Deck-profile behavior verified at portrait/compact; bundle-size check
   (lazy chunk; note the size in the PR).

### PR 2 — PR viewing

1. `GET /api/github/prs/:owner/:repo/:number/files` (github domain + route + safety entry +
   fixture-based tests, pagination + missing-patch handling).
2. `web/src/features/pr-review/` view from GitHubPrList, with review-thread annotations
   (read-only) and checks header.
3. Docs: dashboard page section ("Reviewing diffs and PRs on the deck"); agent instruction is
   _not_ changed (these are human surfaces; Neon's PR facts still come from its actions).

Verification per PR: `npm run check`, `npm run build:web` with the lazy-chunk check, manual deck
pass on wide + portrait profiles, and for PR 2 the github fixture tests.

## Risks

- **`@pierre/trees` is beta** and renders in a shadow root — theme variables must pierce via its
  documented theming hooks, not global CSS. Pin exact; the tree is cosmetic enough that a
  regression falls back to a plain list without blocking diffs.
- **Bundle weight** (Shiki grammars + workers): mitigated by feature-level lazy loading; measure
  in PR 1 and trim the language set if the chunk is egregious.
- **Annotation anchoring drift**: GitHub review threads anchor to positions that may not resolve
  against the current patch — render unresolvable threads in a "file-level" list rather than
  guessing lines.
- **Xeneon/compact ergonomics**: diffs on a 5" strip are inherently cramped; the compact profile
  should prefer opening the diff view in a normal window (`neondeck open` exists now) — a "pop
  out" affordance covers the kiosk case.
- **Library churn**: Pierre iterates fast (84 versions of diffs). The `diff-viewer` folder is the
  isolation layer — no other feature imports `@pierre/*` directly.

## Definition of Done

- A prepared autopilot diff can be reviewed file-by-file with syntax-highlighted diffs and a file
  tree, and approved/rejected from the same view, on both wide and portrait deck profiles.
- A PR from the queue opens to its full file diffs with review threads visible inline where
  anchorable — without leaving the deck.
- Skill-patch candidates, Kilo results, and repo-edit events all expose real diff views from
  their existing rows.
- Initial dashboard bundle size is unchanged (diff feature is a lazy chunk); no `@pierre/*`
  import exists outside `web/src/features/diff-viewer/` (and `pr-review` composing it).
- `npm run verify` passes.
