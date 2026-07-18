# Diff Improvements Plan

Status: active; Phase A is complete in PR #143, Phase B is complete after the final audit, implementation is paused at the user-selected Phase B stopping milestone, Phases C–E remain planned, and the specialized PR review performance workstream is complete for now with measured misses explicitly deferred

Final Phase B audit note (2026-07-18): the shared source, surface, navigation, finding, promotion, and refresh contracts and the focused GitHub PR, prepared-diff, and prepared-backed Kilo/worktree surfaces were independently reconciled against every Phase B acceptance criterion and the changes in PRs #145, #146, #149, #150, #152, #153, and #154. Source/revision binding, targeted invalidation, availability versus application, dirty-state guards, explicit apply, orientation preservation/degradation, stale finding/draft trust, promotion authority boundaries, accessible navigation, and the absence of Phase C behavior are covered by focused unit, API, and component tests. The audit corrected one bounded gap: a failed background prepared-diff metadata refresh now leaves the applied review and its approval/recovery context mounted while reporting the refresh error. No Phase C, D, or E work was started.

Final Phase B performance note (2026-07-18): the lead's Node 26.4.0 rerun of `npm run bench:review-fixtures` recorded large committed-PR fixture medians of 41.9 ms for the tree, 163.7 ms for the first patch, and 0 ms for the in-process thread projection, all within the 500/1,000/500 ms fixture budgets; this harness exercises `pr-local-diffs` only. A separate 305-changed-file worktree approximation measured at the pre-final PR #154 measurement commit `aa8716783874fdf9c38bfa5fdd396b00df779788` (120 modified, 30 deleted, 25 renamed, 130 added) exercised the production Phase B step 5 paths. Across five warm Node 26.4.0 arm64 samples, repo/prepared unscoped metadata medians were 140.9/137.0 ms and repo/prepared scoped active-patch medians were 179.1/177.2 ms, all within the 500 ms tree and 1,000 ms first-patch budgets. It exercised `readRepoDiff`, `readPreparedDiffChangedFiles`, `readStableDiffMetadata`, `gitWorktreeRevision`, and expected-revision checks before and after scoped patch reads. The final PR #154 change after that measurement affected prepared-summary stable-read coverage, not those measured paths.

Progress note (2026-07-18): the specialized large-PR work now has real registered-PR measurements, stable review-thread identity, bounded local metadata reuse, active-patch priority, and passing first-patch and warm review-thread browser budgets. The workstream is complete for now. Production tree visibility, the one-time cold-object fetch, and uncached review-thread latency still miss their retained budgets and remain explicit future follow-ups in `.plans/PR_REVIEW_PERF_PLAN.md`; those misses have not been reclassified as passes.

Historical sequencing correction (2026-07-17): retain the completed Phase A foundation and PR #143, but do not advance into Phase B yet. Phase A was selected while the specialized performance plan still had partial acceptance; that ordering change was not an implicit deferral of the remaining measured misses. Resume the real registered-PR performance work first, beginning with review-thread latency, then reconcile tree visibility and the cold-fetch decision. This pause was lifted on 2026-07-18 after the remaining misses were explicitly deferred with recorded rationale; the original correction remains here for audit history.

Contract note (2026-07-18): `shared/review-source.ts` now defines the versioned source, revision, repository, capability, ordered-file, and explicit patch-state vocabulary used by every current web diff surface. GitHub PRs use head SHA identity; prepared and Kilo/repo worktree views receive content-addressed changed-path fingerprints from metadata reads; skill patches and historical repo-edit events use retained content hashes. Missing identities remain explicitly unavailable rather than falling back to timestamps. The current viewers expose source/revision metadata on their mounted roots, ready for the Phase A registration and navigation event layer. On a synthetic 305-file changed worktree, metadata plus revision identity measured 335.5 ms median versus 243.0 ms for metadata alone (92.5 ms added), within the 500 ms warm-tree budget.

Surface note (2026-07-18): `shared/review-surface.ts` and the local `/api/review-surfaces` surface now provide versioned, bounded, process-ephemeral registration and context snapshots, metadata-free 15-second browser heartbeats, 45-second expiry, explicit close cleanup, revision-aware targeted file navigation, and lightweight acknowledgements over the existing multiplexed app event stream. Each mounted viewer receives a distinct surface id even when multiple windows show the same source; no selection or viewport state is written to SQLite, and the SSE stream signals context changes without rebroadcasting full large-review snapshots.

Fixture note (2026-07-18): `npm run bench:review-fixtures` now builds deterministic small (8-file), medium (90-file), and large (305-file) registered-repo fixtures with mixed add/modify/delete/rename states and representative annotation/draft/finding counts. Five-sample warm medians on the recorded Node 26.4.0 arm64 run were 73.2/73.1/75.6 ms for file trees and 271.0/274.5/272.4 ms for first patches, respectively; all are inside the 500 ms/1,000 ms targets. The machine-local evidence is retained in `benchmarks/results/review-fixture-baseline.json`.

Navigation note (2026-07-18): the focused PR workbench now uses the shared canonical/guided cursor model for visible file, hunk, unresolved-thread, local-draft, Neon-finding, and combined-attention traversal. Previous/next controls, the `[`/`]` shortcuts, and `?` help remain scoped away from editors, forms, dialogs, modified browser keys, and composition; navigation publishes the same active path, selected range/annotation, filter, and guided order to the tree, diff, inspector, and mounted review-surface snapshot. Cross-file hunk traversal fetches one patch at a time and pauses after eight reads per activation rather than constructing its cursor from every patch body. A focused 305-file test constructs the file cursor from metadata while parsing only the one loaded patch. The retained fixture harness was rerun on Node 26.4.0 arm64 with large-case medians of 81.1 ms for the tree, 308.7 ms for the first patch, and 0 ms for the in-process thread projection; those new medians are retained here while `benchmarks/results/review-fixture-baseline.json` continues to preserve the prior raw samples and 75.6/272.4 ms large-case medians recorded above. All retained fixture targets pass. Finding-summary tree filtering is not claimed by this step: the focused tree currently projects current and previous-path matches, while typed finding-summary rendering/filtering remains retained for Phase B step 3. The production misses deferred in `.plans/PR_REVIEW_PERF_PLAN.md` remain deferred rather than reclassified.

Finding note (2026-07-18): Phase B step 3 is complete. The focused PR workbench consumes the shared process-ephemeral typed finding contract and targeted surface event stream, projects only current-revision active findings into Pierre inline annotations, the canonical finding cursor, and semantic tree counts/severity, and keeps stale, resolved, dismissed, promoted, and currently unanchorable findings truthful in the inspector with full retained provenance. Local dismissal uses the existing source/revision-bound endpoint and does not create GitHub comments or prepared-diff mutations. File filtering now matches current path, previous path, and active finding title/explanation without replacing Pierre virtualization or canonical navigation order. A bounded 305-file/200-finding unit fixture emits annotations only for loaded, validated anchors. The retained Node 26.4.0 arm64 fixture harness was rerun with large-case medians of 74.9 ms for the tree, 282.5 ms for the first patch, and 0 ms for the in-process thread projection; all targets pass. Those run results are recorded here while `benchmarks/results/review-fixture-baseline.json` remains unchanged to preserve its prior historical samples. Explicit GitHub draft/prepared-revision promotion remains Phase B step 4, and broader refresh/orientation behavior remains Phase B step 5.

Promotion note (2026-07-18): Phase B step 4 is complete. The versioned source and finding contracts now declare bounded destination metadata, and one source/revision/surface/finding-bound API validates lifecycle, capability, exact line or resolved-hunk anchor, confirmation, and durable target before marking a finding promoted. GitHub findings seed the existing local review draft/comment store with preserved single- or multi-line anchors and Neon provenance; submission remains a separate existing action. Prepared and prepared-backed Kilo findings reuse the existing typed prepared-diff revision request transition, retain its authority/approval/recovery path, and cannot start a revision run. Exact retries reuse the recorded destination, target failures remain retryable, delayed completions cannot regress a newer lifecycle, and only the targeted surface receives the bounded lifecycle event. The focused PR workbench and prepared/prepared-backed Kilo viewers expose descriptive, pending-safe controls and retain promoted findings as history while active counts drop; unsupported Kilo results explain that findings remain local-only. Each promotion loads at most one requested patch. Prepared promotion also recomputes the current worktree revision from changed-file identity metadata immediately before transition, without eagerly loading the changeset's patches.

Refresh note (2026-07-18): Phase B step 5 is complete and the final Phase B audit confirmed its acceptance criteria. GitHub file lists and patches remain head/base-SHA bound, while prepared and Kilo/worktree metadata and per-file patch reads now carry and enforce the authoritative worktree fingerprint. Late revision responses are rejected; patch caches remain immutable under revision-keyed entries. The shared review-surface snapshot publishes bounded availability, pause reasons, application state, and preserved/degraded/failed orientation outcomes, and the multiplexed app event stream targets source revisions by source/repository/worktree/PR identity. Mounted prepared and Kilo metadata also performs a bounded 30-second fingerprint check so external worktree edits become visible without loading patch bodies. Clean surfaces may apply automatically; dirty editors, re-anchor/revision flows, mutations, stale drafts, and active selections pause automatic application, with deliberate application available only where the mounted state can be preserved. GitHub local draft-head validation remains authoritative, stale findings stay historical, exact rename metadata preserves moved files, and removed targets use a deterministic nearest review-order neighbor. Static retained sources explicitly remain static. A focused 305-file fixture loads only the active Kilo patch during refresh, and exact metadata invalidation leaves all 305 cached old-revision patch entries reusable and unrelabeled. The retained Node 26.4.0 arm64 fixture harness was rerun with large-case medians of 75.6 ms for the tree, 284.7 ms for the first patch, and 0 ms for thread projection; all targets pass. These measurements are recorded here while `benchmarks/results/review-fixture-baseline.json` remains unchanged to preserve its historical samples.

Refresh limitation qualification (2026-07-18): “bounded 30-second fingerprint check” above refers only to cadence, changed-path query scope, and the absence of patch-body loading. `gitWorktreeRevision` hashes the full content of every changed regular file, so the fingerprint poll remains byte- and time-unbounded for pathological huge changed files. Phase B does not claim byte-bounded fingerprint work. Adding caching or a hard byte/time limit is explicitly deferred until the lead and product owner discuss the identity/truthfulness tradeoff.

Current sequencing note (2026-07-18): Phase B is the stopping milestone. Complete step 5, then perform a Phase B completion audit and pause implementation. That sequence is now complete and implementation is paused. Preserve Phases C–E below as planned future work; do not treat the pause as completion or deletion of those items.

Related plans:

- `.plans/PR_REVIEW_PERF_PLAN.md` — complete-for-now large-PR data-path and performance workstream with explicit deferred misses
- `.plans/OTHER_PEOPLE_PR_REVIEW.md` — current human PR review workflow
- `.plans/archived/DIFF_UI_PLAN.md` — landed Pierre diff/tree adoption
- `.plans/archived/DIFF_REVIEW.md` — earlier diff review research and interaction planning
- `.plans/ROADMAP.md` — product direction and future TUI reuse requirements

Research source: `/Users/syn/projects/research-only/hunk` at `hunkdiff` 0.17.0.

## Purpose

Neondeck already renders and acts on diffs across several operator workflows. The next step is not
to replace the current Pierre viewer or imitate a terminal diff tool. It is to turn the existing
viewer into a coherent, addressable review surface that works across the dashboard, focused
popouts, prepared fixes, Kilo results, learning patches, repo-edit history, and a future TUI.

This document is the single prioritized product plan for those improvements. Large-review
performance is in scope as a cross-cutting delivery gate. The specialized implementation details
for the local Git provider, patch-on-demand APIs, popout boot path, and timing harness remain in
`.plans/PR_REVIEW_PERF_PLAN.md` so the active performance agent can proceed without duplicative
ownership.

## Executive Summary

The Hunk research confirms that both products use `@pierre/diffs`, but they use it at different
layers:

- Neondeck uses `@pierre/diffs/react` and `@pierre/trees` inside a web dashboard and focused review
  workbench. It is already stronger in durable workflow integration: GitHub review drafts and
  submission, thread actions, prepared-diff approvals and revisions, Kilo review, learning review,
  reports, notifications, and recovery.
- Hunk uses Pierre as the parsing/rendering foundation for a custom OpenTUI review application. Its
  strongest transferable ideas are interaction mechanics: one continuous changeset stream,
  cross-file hunk/comment navigation, inline agent rationale, live agent control of the review
  window, bounded unchanged-context expansion, stable refresh, persistent view choices, and strict
  large-review performance discipline.

The highest-value Neondeck improvement is therefore an **agent-addressable review surface**. Neon
should be able to read structured review focus without loading an entire patch, move a specific
review surface to a file/hunk/finding, and place provenance-rich temporary annotations beside the
code. Users should then be able to promote those annotations into existing GitHub draft comments or
prepared-diff revision requests explicitly.

The second major improvement is an optional **continuous changeset mode** for focused review
surfaces. It should complement, not replace, the current file-focused viewer. It must not ship until
the large-review data path, virtualization strategy, and performance gates can support it.

## Current Neondeck Baseline

### Already supported

- `@pierre/diffs@1.2.12` and `@pierre/trees@1.0.0-beta.5`, isolated behind
  `web/src/features/diff-viewer/`.
- Worker-backed syntax highlighting, unified word diffs, sticky file headers, line selection, range
  comments, light/dark theme integration, file-tree search, and compact file selection.
- A focused `/review` popout sized for a normal desktop window, with responsive three-pane,
  two-pane, and single-column workbench arrangements.
- GitHub review threads, replies, resolution, local draft comments, range anchors, stale-comment
  detection and re-anchoring, summary verdicts, and durable submission recovery.
- Durable Neon PR reviews, report-only findings, report artifact overlays, and manual promotion of a
  report finding into an inline draft.
- Shared diff rendering for prepared autopilot diffs, pending approvals, Kilo results, skill-patch
  candidates, and retained repo-edit events.
- Prepared-diff verification, approval, revision, worktree inspection, resync, retry, and cleanup
  workflows surrounding the visible diff.
- Responsive dashboard profiles for ultrawide, wide, portrait, and compact windows, independent of
  a single physical display resolution.

### Material gaps

- `MultiFileView` replaces the active file rather than supporting a top-to-bottom changeset stream.
- Diff presentation is hard-coded to unified + wrapped lines; there are no focused-review controls
  for split/unified, wrap/horizontal scroll, line numbers, or annotation visibility.
- There is no shared hunk cursor across files and no general next/previous navigation for hunks,
  GitHub threads, draft comments, or Neon findings.
- The file tree communicates Git status and line counts but not review density, unresolved threads,
  drafts, findings, severity, or progress.
- Neon can run a durable review, but it cannot address a specific live web review surface, inspect
  its current focus, steer it, or batch-place temporary annotations.
- Neon findings that cannot be submitted automatically live in a separate inspector/report flow
  until the user manually chooses an anchor.
- Prepared, Kilo, and local diff queries can become stale while background work changes their source
  worktree; the viewer has no common revision fingerprint or refresh-preservation contract.
- Collapsed unchanged context cannot be expanded from source, even when Neondeck owns the local
  worktree.
- Local review surfaces do not offer a safe, typed “open this file at this line in my editor” action.
- Large-review performance is being improved, but the product plan needs explicit performance gates
  so future changeset and annotation work cannot regress it.

## Product Principles

1. **One review model, many sources.** GitHub PRs, prepared diffs, Kilo results, skill patches, and
   repo-edit events should normalize into one review-surface contract without erasing source-specific
   capabilities.
2. **The embedded view and focused workbench have different jobs.** Embedded dashboard views stay
   compact and file-focused. Focused popouts can earn richer navigation, changeset streams, and
   persistent view controls.
3. **Agent context belongs beside the code.** High-signal Neon findings and rationale should be
   spatially anchored to the relevant code, not hidden in a separate report when an anchor exists.
4. **Agent steering is explicit and typed.** Neon may navigate or focus a review surface only through
   application-controlled actions. Focus changes should be opt-in, auditable, and scoped to the
   intended surface.
5. **Temporary findings are not external comments.** Neon annotations remain local review context
   until the user explicitly promotes them into a GitHub draft, revision request, or another durable
   mutation.
6. **Refresh must preserve orientation.** A new revision should retain the active file, nearest hunk,
   selected annotation, view mode, and scroll anchor when those targets still exist.
7. **Performance is a feature gate.** Large-review responsiveness must be measured before and after
   each phase. Continuous changeset mode cannot rely on mounting every file or shipping every patch
   up front.
8. **Mouse, touch, and keyboard remain peers.** Keyboard navigation accelerates the workbench but
   never replaces visible controls, focus states, or accessible labels.
9. **Reuse the backend command/event surface.** The web app and future TUI should share review
   context, navigation, annotation, source-expansion, and refresh contracts.

## Prioritized Roadmap

| Priority | Improvement                                          | Primary outcome                                                                                | Dependency                                    |
| -------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| P0       | Shared review-surface model and performance contract | Every diff source exposes stable revision, focus, navigation, and annotation semantics         | Coordinate with PR review performance work    |
| P1       | Review map and cross-file navigation                 | Users can move through hunks, threads, drafts, and findings without losing orientation         | P0 review model                               |
| P1       | Neon-guided review and inline findings               | Neon can inspect, steer, and annotate the exact live review surface the user is viewing        | P0 model + app event hub                      |
| P1       | Revision-aware live refresh                          | Background revisions update safely without silently showing stale code or resetting the review | P0 revision identity                          |
| P2       | Continuous changeset mode in focused surfaces        | Full changesets can be reviewed as one virtualized stream with tree jump navigation            | Performance gates + patch-on-demand data path |
| P2       | Unchanged-context expansion and local editor handoff | Reviewers can inspect surrounding source and move into the managed checkout when needed        | Source-read and desktop-open actions          |
| P3       | Focused-review view controls and copy affordances    | Review presentation adapts to the task without weakening Neondeck’s visual identity            | P0 preference schema                          |
| P3       | Future TUI review client                             | TUI reuses the same review actions/events instead of creating a second review runtime          | Backend contracts from P0–P2                  |

## P0 — Shared Review-Surface Foundation

### Goal

Create a stable product model for “a user is reviewing this revision in this surface” before adding
more viewer-specific state to individual components.

### Review source contract

Normalize the following sources:

- `github-pr`
- `prepared-diff`
- `kilo-result`
- `skill-patch`
- `repo-edit-event`

Every source provides:

- stable source id and display title
- repo id/path information when local source access is permitted
- immutable revision identity: PR head SHA, prepared-diff commit SHA, worktree diff fingerprint, or
  retained patch hash
- ordered changed-file metadata without requiring every patch body
- per-file patch lookup with explicit loading, unavailable, truncated, binary, and stale states
- available capabilities such as comments, revision requests, context expansion, open-in-editor,
  refresh, and external link

### Review surface state

Each mounted focused viewer receives a `surfaceId` and publishes a bounded snapshot:

- source descriptor and revision identity
- active file path
- selected hunk or line range when present
- selected annotation/finding when present
- active file filter and review order
- view mode: file or changeset
- presentation mode: unified, split, or auto
- annotation visibility filters

Selection and viewport state are ephemeral. Durable drafts, findings, and decisions continue to live
in their existing app/GitHub stores. Do not write scroll positions to SQLite.

### Multi-surface coordination

Use Neondeck’s existing local API plus multiplexed app event hub rather than introducing a Hunk-style
loopback daemon:

- a focused browser/TUI surface registers and heartbeats a bounded snapshot
- typed lookups list active review surfaces and read one surface context
- typed navigation commands publish a targeted event to one `surfaceId`
- the surface acknowledges whether the target resolved against its current revision
- annotations carry source revision and anchor metadata so stale annotations cannot silently attach
  to new code
- inactive/closed surfaces expire automatically; multiple popouts for the same PR remain distinct

Suggested application-controlled operations:

- `review_surface_list`
- `review_surface_context`
- `review_surface_navigate`
- `review_surface_annotations_apply`
- `review_surface_annotations_clear`

Names may follow existing Neondeck action conventions during implementation. The contract matters
more than the exact spelling.

### P0 acceptance criteria

- All current diff sources can be represented without loading patch text for every file.
- Two review popouts for the same PR register as distinct surfaces and can be targeted independently.
- A source revision change makes old anchors explicitly stale.
- Closing or losing a browser removes the ephemeral surface without deleting durable review data.
- The future TUI can implement the contract without importing web-specific React state.
- The performance harness can identify a review by source/revision and measure it consistently.

## P1 — Review Map and Navigation

### Goal

Make review progress and the next meaningful target obvious, particularly on large or heavily
annotated changesets.

### File-tree review map

Extend the file tree or its row decoration layer with compact, semantic indicators for:

- unresolved GitHub thread count
- local draft count
- stale draft count
- Neon finding count and highest severity
- prepared-diff risk/approval class where relevant
- optional local “reviewed” state for human progress tracking

Filtering should match current/previous path and finding summary. Provide a secondary “review order”
projection for guided reviews without mutating the canonical changed-file order. Neon may recommend
a narrative order, but the user can always return to path order.

### Navigation model

Build pure cross-file cursors for:

- previous/next file
- previous/next hunk
- previous/next unresolved thread
- previous/next local draft
- previous/next Neon finding
- previous/next attention item across all annotation kinds

The focused workbench should expose visible previous/next controls plus keyboard shortcuts and a
small help overlay. Hunk’s bracket/comma/brace model is a useful reference, but shortcuts must be
validated against Neondeck’s existing form and browser behavior.

Global shortcuts must not fire while a textarea, input, select, dialog, or annotation editor owns
focus. Navigation updates the file tree, diff viewport, inspector, and review-surface context from
one source of truth.

### P1 acceptance criteria

- A reviewer can traverse every hunk or every annotation without touching the file tree.
- File-tree counts update when drafts/threads/findings are added, removed, resolved, or made stale.
- Navigation never steals keystrokes from comment/revision editors.
- Every keyboard action has a visible control and visible focus state.
- Filtering preserves the current target when still visible and picks a deterministic nearest target
  otherwise.
- Screen reader output announces the new file, hunk/finding position, and relevant status.

## P1 — Neon-Guided Review and Inline Findings

### Goal

Let Neon guide the user through a review in the same surface where the code is visible.

### Agent workflow

1. The user asks Neon to explain, review, or walk through an open diff.
2. Neon lists or resolves the intended active review surface.
3. Neon reads structured file/hunk/annotation metadata first and requests raw patches only for the
   files it needs.
4. Neon optionally publishes a review order and a bounded set of anchored findings.
5. When the user asks to proceed, Neon navigates the surface to the next target.
6. The user can dismiss the local finding, convert it into a GitHub draft, or use it as the starting
   text for a prepared-diff revision request.

### Finding model

Local Neon findings include:

- id, source revision, file, side, start/end line or hunk anchor
- concise title and explanation
- severity and confidence
- author role, model, workflow/run id, and creation time
- optional suggested action
- stale/resolved/dismissed/promoted state

Use ordinary structured React/TUI components. Do not import Hunk’s experimental STML markup language.
Rich content should remain schema-backed, bounded, and renderable across web and TUI.

### Trust boundaries

- Applying local annotations is not a GitHub mutation and does not require push/comment authority.
- Promoting a finding into a GitHub draft uses the existing human review draft workflow.
- Promoting a finding into a prepared-diff revision uses the existing typed revision action and its
  reason/confirmation rules.
- Agent navigation defaults to no focus steal. `focus=true` is used only when the user asked Neon to
  show or walk through a target.
- Findings from an old revision never auto-promote or silently re-anchor.

### P1 acceptance criteria

- Neon can inspect review structure without receiving every patch body.
- A batch of findings is validated completely before any annotation is applied.
- Each finding renders beside its anchored code with clear Neon/run provenance.
- Next/previous finding navigation works across files.
- Promotion to a GitHub draft preserves range anchors and requires an explicit user action.
- Promotion to a prepared-diff revision cannot bypass existing approval or task-authority checks.
- A revision change marks unresolved findings stale and offers re-run/re-anchor/dismiss choices.

## P1 — Revision-Aware Live Refresh

### Goal

Keep reviews truthful while PR heads, prepared fixes, and Kilo worktrees change in the background.

### Behavior

- Diff sources publish a stable revision/fingerprint in every file-list and file-patch response.
- App events invalidate only the affected source/revision queries.
- Cached patches for unchanged revisions remain reusable.
- A visible “new revision available” notice distinguishes background availability from an applied
  refresh.
- Safe automatic refresh is allowed when the user has no active selection/editor and no stale draft
  risk. Otherwise the user explicitly applies the refresh.
- Applying a refresh attempts to preserve active path, nearest matching hunk, selected finding, scroll
  anchor, review order, and view preferences.
- If the active file disappears, select the nearest remaining review-order neighbor and explain the
  change.
- Existing draft-anchor validation remains authoritative for GitHub comments.

### P1 acceptance criteria

- A prepared-diff revision updates the viewer without closing the approval/recovery context.
- The UI never presents a patch from one revision alongside metadata or actions for another.
- Dirty user input is never discarded by an automatic refresh.
- Refreshing a 300-file review does not refetch unchanged patch bodies.
- The surface reports whether focus preservation succeeded, degraded to a nearby target, or failed.

## P2 — Continuous Changeset Mode

### Goal

Offer a focused, systematic way to read a complete changeset without selecting files one at a time.

### Surface policy

- Embedded dashboard diffs remain file-focused.
- Focused PR review and future generic diff popouts gain a `file | changeset` mode switch.
- File mode remains the initial default until the large-review performance gates pass. After that,
  focused surfaces may remember the user’s last choice.
- Compact/narrow surfaces may support changeset mode, but never auto-switch into it merely because it
  exists.

### Interaction

- The main pane becomes one top-to-bottom stream in canonical or guided review order.
- Selecting a file in the tree scrolls to that file; it does not collapse the stream.
- The current file header remains pinned while its body is active.
- Scrolling updates the active file/hunk and the shared review-surface context without feedback loops.
- Cross-file hunk/finding navigation uses the same cursors as file mode.
- Annotations, selection, comment drafting, re-anchoring, and inspector content remain source-aware.
- Switching file/changeset or unified/split modes preserves the nearest visible anchor.

### Rendering and data constraints

- Do not concatenate and mount every patch as one unbounded `PatchDiff`.
- File sections and expensive rows must be virtualized or otherwise bounded to a small visible window.
- Patch bodies load on demand with adjacent prefetching; metadata drives the initial stream geometry.
- Binary, unavailable, generated-like, and truncated files remain visible as explicit placeholder
  sections.
- Syntax highlighting remains worker-backed and must not starve input or scroll updates.

### P2 acceptance criteria

- A 300-file fixture opens to a usable tree and first patch inside the performance budget below.
- Scrolling or keyboard navigation does not mount all file patches.
- Sticky headers, tree selection, inspector focus, and review-surface state agree on the active file.
- Switching modes preserves the visible file/hunk whenever that target still exists.
- Existing GitHub draft, thread, and submission tests pass unchanged or with intentional additions.

## P2 — Source Context and Local Editor Handoff

### Unchanged-context expansion

Implement source expansion in capability order:

1. Prepared diffs and Kilo results backed by Neondeck-managed worktrees.
2. Registered local repo/PR revisions once the local PR diff provider is available.
3. GitHub blob fallback for remote-only PRs when exact base/head source can be proven.
4. Static retained patches remain non-expandable unless matching source is available.

Expansion must show loading, unavailable, source-too-large, stale-revision, and retry states on the
collapsed row. Source reads are path-confined, revision-bound, byte/line capped, and syntax
highlighted through the same worker path as the surrounding diff.

### Open in editor

Add a typed, user-invoked action for local-capable sources:

- target the registered repo or managed worktree, canonical file path, and optional line/column
- validate that the resolved path remains inside the allowed checkout
- use configured editor integration rather than evaluating a shell string
- hide or disable the action for remote-only/static sources
- treat opening the editor as an explicit UI action; Neon may recommend it but not launch it silently

### P2 acceptance criteria

- Expanding context never reads outside the registered repo/worktree or from the wrong revision.
- Large sources fail safely without freezing the UI.
- Expansion state survives ordinary navigation and resets when the source revision changes.
- Open-in-editor targets the expected file/line and cannot accept arbitrary command arguments.

## P3 — Focused Review Controls

### Controls

Expose a restrained set of review-specific preferences:

- file vs changeset mode
- unified, split, or responsive auto layout
- wrap lines vs horizontal code scrolling
- line numbers on/off
- hunk metadata on/off where Pierre supports it cleanly
- GitHub threads, local drafts, and Neon findings visibility
- optional copy mode: code only vs include diff/file metadata

Preferences should be typed, have safe defaults, and be scoped to review surfaces rather than
expanding the global dashboard theme system. Use Neondeck’s current theme and density tokens; do not
copy Hunk’s theme catalog.

### Copy affordances

- Copy file path
- Copy selected changed lines
- Copy file patch
- Copy permalink/GitHub link when available
- Copy a finding with source location and provenance

Clipboard operations provide concise success/failure feedback and never include hidden annotation
text or unrelated diff decorations unless the user chose that mode.

### P3 acceptance criteria

- Preferences persist through typed Neondeck config or app-owned local preferences and are shared by
  dashboard popouts; future TUI may map only supported options.
- Every mode remains legible in light/dark themes and comfortable/compact densities.
- View-mode changes preserve review position.
- Copy output has deterministic tests for unified/split, ranges, renames, and no-newline markers.

## Large-Review Performance Workstream

Large-review performance is part of this plan’s definition of done, not a later optimization phase.
Implementation ownership is coordinated with `.plans/PR_REVIEW_PERF_PLAN.md`.

### Ownership boundary

The active performance workstream owns:

- local Git PR diff provider and fallback behavior
- metadata-only file lists and per-file patch endpoints
- popout boot-waterfall reduction
- threads-only data fetches where appropriate
- React Query cache keys, lazy patch loading, and neighbor prefetch
- large-fixture timing harness and initial measurements

The diff-improvements workstream owns:

- shared review-surface state and revision semantics
- cross-file cursors, review map, keyboard/accessibility behavior
- agent context/navigation/annotation actions and events
- continuous changeset rendering and virtualization above the patch query interface
- refresh-preservation behavior, context expansion UX, editor handoff, and view controls

Files such as `GitHubPrReview.tsx`, `MultiFileView.tsx`, `queries.ts`, and the GitHub PR routes are
shared seams. Land or explicitly hand off the performance changes before building changeset mode in
those files. Do not independently rework the same query/data path.

### Required datasets

- small: 5–10 files with one annotation and one draft
- medium: 75–100 files with mixed add/modify/delete/rename states
- large: 300+ files with threads, drafts, and Neon findings across multiple directories
- pathological file: very large text patch near/over configured limits
- mixed unavailable set: binary, generated-like, truncated, missing patch, and renamed files
- refresh fixture: same source id across two revisions with added, removed, renamed, and shifted hunks

### Performance gates

Retain the current targets from `.plans/PR_REVIEW_PERF_PLAN.md`:

- warm registered-repo file tree visible in under 500 ms
- warm first patch visible in under 1 second
- cold path requiring fetch visible in under 3 seconds
- GitHub fallback no worse than the pre-improvement baseline

Add interaction gates before enabling continuous changeset mode by default:

- file/hunk/finding navigation acknowledges input in the next animation frame and paints cached
  targets without perceptible delay
- a 300-file changeset keeps mounted file/row work bounded to the visible window plus deliberate
  overscan
- repeated navigation, layout switching, and refresh cycles do not show unbounded heap growth
- syntax highlighting and scroll tracking do not create sustained main-thread long tasks
- dashboard initial load does not eagerly include the diff/highlighting bundle

Record tree-visible, first-patch, navigation, layout-switch, scroll, refresh, and memory measurements
in implementation PR summaries. If exact numeric interaction thresholds need adjustment after the
first harness run, record the baseline and rationale in this document or `.plans/DEVIATIONS.md`
before relaxing a gate.

## Surface Coverage

| Capability                   | Embedded PR        | Focused PR popout       | Prepared diff              | Kilo result    | Skill/repo-edit patch | Future TUI          |
| ---------------------------- | ------------------ | ----------------------- | -------------------------- | -------------- | --------------------- | ------------------- |
| File-focused diff            | Yes                | Yes                     | Yes                        | Yes            | Yes                   | Contract            |
| Review map/navigation        | Compact subset     | Full                    | Full                       | Full           | Basic                 | Full                |
| Neon annotations             | Read/navigate      | Full + promote to draft | Full + promote to revision | Full           | Read-only/local       | Full                |
| Continuous changeset         | No                 | Yes                     | Generic popout             | Generic popout | Optional popout       | Yes                 |
| Live refresh                 | PR revision notice | Full                    | Full                       | Full           | Static                | Full                |
| Context expansion            | When source exists | When source exists      | Local                      | Local          | Usually no            | Capability-based    |
| Open in editor               | Local only         | Local only              | Yes                        | Yes            | Local only            | Capability-based    |
| GitHub submit/thread actions | Existing subset    | Full                    | No                         | No             | No                    | Full via shared API |

## Delivery Sequence

### Phase A — Contracts and performance integration

1. **Completed —** reconcile with the active PR review performance work and settle shared query/source interfaces.
2. **Completed —** add the normalized review source and revision model.
3. **Completed —** add ephemeral review-surface registration/context/navigation events.
4. **Completed —** establish small/medium/large fixtures and record the baseline measurements.

### Phase B — Guided review

1. **Completed —** Add review-map decorations and pure cross-file cursors.
2. **Completed —** Add visible navigation controls, scoped shortcuts, and help.
3. **Completed —** Add typed Neon finding application and inline rendering with provenance, local dismissal, finding-summary filtering, and cross-file synchronization.
4. **Completed —** Add explicit promote-to-draft and promote-to-revision flows.
5. **Completed —** Add revision-aware invalidation and refresh preservation.

### Phase C — Focused changeset workbench

1. Add file/changeset mode in the focused PR popout.
2. Add bounded file-section rendering, sticky headers, active viewport tracking, and lazy patch
   prefetch.
3. Preserve anchors across stream/file and unified/split mode changes.
4. Pass the large-review performance gates before remembering or defaulting to changeset mode.
5. Extract a generic focused diff popout for prepared/Kilo sources if the PR workbench proves the
   interaction model.

### Phase D — Source-aware depth

1. Add bounded unchanged-context expansion for managed worktrees.
2. Add registered local PR source and remote GitHub blob fallbacks where exact revisions are proven.
3. Add the typed open-in-editor action.
4. Add review-specific view and copy preferences.

### Phase E — TUI reuse

1. Implement the review-surface client over the shared APIs/events.
2. Map supported view preferences to terminal capabilities.
3. Reuse source, navigation, finding, refresh, context-expansion, and mutation actions.
4. Do not port web rendering internals or create a TUI-only review state store.

## Verification Strategy

### Unit

- normalized review sources and revision fingerprints
- cross-file file/hunk/annotation cursor behavior
- filter and review-order stability
- stale anchor and refresh target resolution
- annotation batch validation and provenance
- copy output and preference parsing
- path confinement and source-read limits

### Component

- keyboard shortcuts suppressed in inputs, dialogs, and composers
- file tree, diff, inspector, and active surface stay synchronized
- file/changeset and unified/split switches preserve position
- annotations render, dismiss, navigate, and promote correctly
- loading, empty, binary, truncated, unavailable, stale, and refresh states
- responsive focused workbench at wide, 1180 px, 820 px, portrait, and compact widths
- light/dark theme, density scaling, visible focus, and reduced-motion behavior

### Integration

- PR review draft/range/re-anchor/submit workflow remains intact
- Neon context → navigate → batch annotate → promote flow
- prepared-diff revision → event → refresh → stale finding handling
- multiple simultaneous review surfaces targeted independently
- local context expansion and editor handoff stay inside registered/managed paths
- future TUI contract exercised through fixture clients before UI implementation

### Performance

- run the shared small/medium/large fixture harness for each phase that changes data loading,
  rendering, navigation, annotations, or refresh
- include before/after measurements in the PR
- treat regression beyond an agreed tolerance as a blocking failure or record an explicit accepted
  deviation with rationale

## Non-Goals

- Replacing `@pierre/diffs/react` with Hunk’s custom terminal renderer.
- Introducing a second loopback daemon or another agent runtime for review surfaces.
- Copying Hunk’s theme catalog, pager, Git difftool, Jujutsu, or Sapling integrations into the web
  dashboard.
- Adding an STML/HTML-like agent annotation language.
- Turning Neondeck into a general-purpose text editor.
- Structural/AST diffing in this plan.
- Per-hunk accept/reject or partial patch application; those require a separate mutation/trust design.
- Loading or mounting every patch to simplify continuous changeset mode.
- Removing current compact summary rows or forcing continuous mode into the dashboard.

## Documentation and Plan Maintenance

- Update `PRODUCT.md` so Neondeck’s product framing explicitly includes normal windows, focused
  popouts/workbenches, companion displays, and future TUI surfaces; the current Xeneon-primary wording
  is narrower than the implementation.
- Update dashboard/user docs when review navigation, Neon-guided review, changeset mode, context
  expansion, or editor handoff ships.
- Add a changeset for each user-facing implementation phase.
- Record deviations or deferrals in `.plans/DEVIATIONS.md` when implementation changes this priority
  order, trust boundary, performance gate, or surface coverage.
- Retain `.plans/PR_REVIEW_PERF_PLAN.md` as the specialized performance implementation record while
  its measured tree, cold-fetch, and uncached-thread misses remain deferred; archive it only after
  those follow-ups are reconciled, and preserve this document as the broader diff product roadmap.

## Definition of Done

This plan is complete when:

- every active diff source uses the normalized source/revision contract
- focused review surfaces expose structured context and can be safely targeted by Neon
- users can navigate files, hunks, threads, drafts, and findings with visible controls and keyboard
  parity
- Neon findings render inline with provenance and can be explicitly promoted into existing review or
  revision workflows
- background revisions refresh truthfully without discarding user work or losing orientation
- focused popouts offer a performant continuous changeset mode while embedded views remain compact
- local-capable sources support bounded context expansion and safe editor handoff
- review preferences are typed and position-preserving
- the large-review performance gates pass on the shared fixtures
- the backend contracts are reusable by the future TUI without a second review runtime
