# PR Review Guided Tours — Implementation Handoff

Status: implemented in PR #352. Reviewer slash-command extraction remains a separate follow-up PR.

Companion to `PR_REVIEW_GUIDED_TOURS_PLAN.md`. The plan says _what_ and _why_.
This says _where in this codebase_, _with which values_, and _what will bite
you_. Every file:line reference below was read at the time of writing; treat
line numbers as approximate anchors and the file paths as exact.

---

## 1. Start with the mockups

`guided-tours/mockups/` holds six interactive boards. **Open them before
reading further** — they are clickable and will answer most layout questions
faster than this document can.

Published canvas: <https://claude.ai/code/artifact/848848b8-0518-4e6c-ad01-cf553cede02f>

Two pages, switchable from the toolbar's pages menu:

| Page     | Board               | What it settles                                 |
| -------- | ------------------- | ----------------------------------------------- |
| The tour | `Main.dc.html`      | The whole workbench with a tour open. Walk it.  |
| The tour | `Coexist.dc.html`   | Tour vs finding vs draft vs thread on one file. |
| The tour | `Card.dc.html`      | The chat card's four states.                    |
| Reach    | `Reading.dc.html`   | `walk \| read` toggle.                          |
| Reach    | `ShowWhy.dc.html`   | A finding publishing its own evidence.          |
| Reach    | `ReviewTab.dc.html` | The tour panel in the Review tab.               |

Each board has two controls above it: `theme` (dark/light) and `hue`
(green/violet/none). Use `hue` to make the accent decision yourself rather than
taking it on faith — see §4.

The sticky notes on the canvas carry the rationale for each board. They are the
short version of §3 below.

### What a `.dc.html` file is

These are **Design Component** files, not pages. They will render blank if you
open one in a browser: the `<script src="./support.js">` line in each head is a
placeholder that the canvas runtime replaces with an inline runtime at render
time. The format is an HTML template inside `<x-dc>`, plus a
`class Component extends DCLogic` block that supplies its values through
`renderVals()`.

You do not need to learn the format to implement this. Read them as
**specifications of markup and CSS** — the class names, the resolved
`calc(Npx * var(--ts))` sizes and the `color-mix()` recipes are all real and are
meant to be transcribed. `--ts` in the mockups is `--deck-text-scale` in the
app; `--ds` is `--deck-density-space`.

If you _do_ want to edit a board, rebuild instructions and the two silent traps
are in `guided-tours/mockups/README.md`.

---

## 2. The codebase map

Everything you will touch, grouped by the phase that touches it.

### The agent and its tools

| What                                             | Where                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `pr-reviewer` agent component                    | `src/agents/pr-reviewer.ts:194`                                                         |
| Tool mounting — **copy this pattern**            | `src/agents/pr-reviewer.ts:246-286`                                                     |
| Revision-guard route middleware                  | `src/agents/pr-reviewer.ts:51`, mounted at `src/server/create-app.ts:191`               |
| Reviewer instructions                            | `src/agents/pr-reviewer.ts:339`, template at `src/runtime-home/pr-review-prompts.ts:48` |
| Runtime context snapshot                         | `src/agents/pr-reviewer.ts:369`                                                         |
| **Closest analogue to the tool you are writing** | `src/modules/pr-reviewer/draft-tools.ts:84`                                             |
| Its server-side binding guard                    | `src/modules/pr-reviewer/draft-tools.ts:277`                                            |
| Simpler single-tool example                      | `src/modules/pr-reviewer/review-tools.ts:30`                                            |
| Shared tool-name contract                        | `shared/pr-reviewer-session.ts`                                                         |

`createPrReviewerDraftTools({reviewId, headSha}, paths)` is the template for
`neondeck_publish_pr_tour`. Read it end to end before writing anything. In
particular `boundReview` at `:277` re-reads the review on **every call** and
rejects if the row is missing, the head SHA moved, or the status is not `ready`
— your publish transaction must do the same, not cache the binding at mount.

### Annotations and the diff

| What                                                    | Where                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| Annotation metadata type — **add a `kind` here**        | `web/src/features/diff-viewer/types.ts:23`                  |
| `renderAnnotation` dispatch — **add a case here**       | `web/src/features/pr-review/GitHubPrReview.tsx:1850`        |
| Annotation fan-out per file                             | `web/src/features/pr-review/GitHubPrReview.tsx:534`         |
| Shadow-DOM annotation CSS — **half your CSS goes here** | `web/src/features/diff-viewer/theme.ts:49-210`              |
| Light-DOM duplicate of the same CSS                     | `web/src/styles.css:1876-2124`                              |
| Finding annotation component                            | `web/src/features/pr-review/PrReviewNeonFinding.tsx:6`      |
| Draft / thread / composer annotations                   | `web/src/features/pr-review/PrReviewCommentComposer.tsx:97` |
| Diff renderer options                                   | `web/src/features/diff-viewer/theme.ts:9-30`                |

### Navigation

| What                                     | Where                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `traversalKinds` — **add `tour` here**   | `web/src/features/pr-review/PrReviewNavigationBar.tsx:9`           |
| Nav bar component and status text        | `web/src/features/pr-review/PrReviewNavigationBar.tsx:117`, `:274` |
| Review cursor model                      | `shared/review-navigation.ts:122`, `:223`, `:258`                  |
| Navigation target type — **extend this** | `shared/review-surface.ts:78`                                      |
| Surface registry                         | `src/modules/review-surfaces/registry.ts:87`                       |
| Client surface hook                      | `web/src/features/diff-viewer/use-review-surface.ts:41`            |
| Navigation resolution + revision check   | `web/src/features/diff-viewer/use-review-surface.ts:262`           |

### Persistence

| What                                   | Where                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Drizzle schema (all app tables)        | `src/runtime-home/app-db/schema.ts` — see `prReviewDraftComments:642`                      |
| Migrations                             | `src/runtime-home/app-db/migrations/<timestamp>_name/migration.sql`                        |
| Module layout to copy                  | `src/modules/pr-reviews/` — `types` / `schemas` / `store` / `service` / `events` / `index` |
| Smaller example of the same layout     | `src/modules/prepared-diffs/`                                                              |
| Event publish/subscribe/SSE convention | `src/modules/app-state/notification-events.ts:17`                                          |
| Event stream registration              | `src/server/events/event-stream.ts:41-59`                                                  |

Note: schema is Drizzle, **runtime access is raw `node:sqlite`** via
`openDb(paths.neondeckDatabase)` (`src/lib/sqlite.ts`). See
`src/modules/pr-reviews/store.ts:22-196` for the prepare/run/close-in-finally
idiom and the row mappers.

### Sidebar and chat

| What                                                     | Where                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Inspector tabs — **add the tour panel under Review**     | `web/src/features/pr-review/PrReviewFindingsSidebar.tsx:88`      |
| Panel stack order                                        | `web/src/features/pr-review/PrReviewFindingsSidebar.tsx:159`     |
| Reviewer chat (a bare textarea today)                    | `web/src/features/pr-review/PrReviewReviewerChat.tsx:172`        |
| Main-chat slash typeahead to extract from                | `web/src/features/flue-chat/components/session-view.tsx:459-517` |
| Its filtering helpers                                    | `web/src/features/flue-chat/lib/commands.ts`                     |
| Global command registry — **do not add `/show-me` here** | `src/modules/commands/registry.ts:3`                             |

---

## 3. The four decisions, and why not to undo them

### 3.1 Tour is a seventh traversal kind

`PrReviewNavigationBar.tsx:9` already declares:

```ts
const traversalKinds = [
  'file',
  'hunk',
  'review-thread',
  'local-draft',
  'finding',
  'attention',
];
```

driven by `[` / `]`, with a `tabular-nums` status line that already renders
`Finding · 2 of 7 · end boundary`. Adding `'tour'` to that array gives you
Previous, Next, the keyboard bindings, focus management, boundary handling and
the "N of M" readout for free.

This is not a convenience — it is what makes invariant 6 ("navigation is
deterministic, not a model tool call") true by construction rather than by
discipline. It also means there is exactly **one cursor**: the annotation
buttons, the chat spine, the inspector panel and the keyboard are four
affordances for the same state, so they cannot desynchronise.

Consequence: the plan's original `/next`, `/previous`, `/restart-tour` and
`/close-tour` commands are gone. Do not reintroduce them.

Also relevant: `neondeck_review_surface_navigate` exists as an agent tool at
`src/modules/review-surfaces/actions.ts:78` but is **not mounted on
`pr-reviewer`**. Keep it that way. The invariant holds today for free.

### 3.2 The tour is the only untinted annotation

Every annotation that ships carries a tinted fill:

| Type            | Fill                  | Border               |
| --------------- | --------------------- | -------------------- |
| Base annotation | `primary 10% + field` | `--line`             |
| Neon finding    | `primary 5% + field`  | `--line`             |
| Review thread   | `primary 7% + field`  | `primary 55% + line` |
| Local draft     | `violet 6% + field`   | `violet 48% + line`  |
| Stale draft     | `accent 10% + field`  | `accent 46% + line`  |

All five read as **state**: something is true about this line. The tour uses
flat `--field` with a 2px left rule, so it reads as **chrome**: something is
being shown to you. That distinction lands before any text is read, and it is
load-bearing — it is why the accent choice in §4 is low-stakes.

If you find yourself adding a tint to make the tour "stand out more", you have
undone the design. Increase the left-rule weight or the marker contrast
instead.

### 3.3 Findings can publish tours

See the plan's _Findings As Tour Sources_ and the `ShowWhy` board. The short
version: a cross-file finding currently degrades into a paragraph of
`file:line` references anchored to a line that is only one of them. `Show me
why` lets the finding keep the claim and delegate the evidence.

Sequenced as Phase 4c because it needs the whole pipeline, but it is the
justification for the feature. If the phases get cut, cut something else.

### 3.4 Walk and read

See the plan's _Walk and read_ and the `Reading` board. The argument in one
line: **a diff can only ever be in repository order**, so a four-step trace
across three files reads as four unrelated hunks; read mode is the only view
that can put them in the order that makes the point.

It needs no data the artifact does not already carry. Cheap, and it is the mode
most reviewers will actually use for a short tour.

---

## 4. Visual specification

### 4.1 The new token

Add to `web/src/styles.css` in both theme blocks (`:root` / `[data-theme=light]`
around `:26-61`, `[data-theme=dark]` around `:63-96`), and expose it through the
Tailwind `@theme` bridge at `:3-24` alongside `--color-violet`:

```css
/* light */
--tour: #0d7a42;
/* dark  */
--tour: #5cf28f;
```

Then add it to the diff viewer's shadow CSS in
`web/src/features/diff-viewer/theme.ts` — the shadow root does **not** inherit
custom properties it has not been given. The existing `:host` block at `:50-55`
is where the other tokens cross that boundary.

Why green: cyan `#00b7c7` is `--primary` (base annotation, findings, threads),
violet `#b59cff` is **local draft comments**, pink `#ff4fb8` is stale/error,
amber `#f0b95b` is warning, and red is reserved. The largest unclaimed gap is
amber 82° → cyan 208°; ~150° sits in the middle of it.

Known risk: green reads as "approved" in a review tool. It is blunted by there
being **no success token in `styles.css` today** (pass states use `--primary` —
see `GitHubPrList.tsx:596`) and by the hue never appearing as a fill. If a
`--good` token is ever wanted at that hue, move `--tour` to `--violet` and
nothing else changes. The `hue` tweak on each board exists to let you make that
call before writing code.

### 4.2 The annotation

Both stylesheets. `theme.ts` for what the shadow root needs to inherit;
`styles.css` for the slotted light-DOM content. This duplication is existing
practice, not an accident — see how `.pr-review-draft` is declared in both.

```css
.pr-review-tour {
  display: grid;
  gap: 6px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--tour);
  background: var(--field); /* NO tint — this is the whole design */
  padding: 8px;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: calc(10.5px * var(--deck-text-scale));
  line-height: 1.45;
}
.pr-review-tour-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: calc(10px * var(--deck-text-scale));
}
.pr-review-tour-location {
  color: var(--tour);
  font-weight: 600;
}
.pr-review-tour-symbol {
  color: var(--muted);
}
.pr-review-tour-progress {
  flex: none;
  color: var(--muted);
  font-size: calc(9px * var(--deck-text-scale));
  font-variant-numeric: tabular-nums;
}
.pr-review-tour-copy {
  margin: 0;
  max-width: 76ch;
}
```

### 4.3 The marker

Square. The app has exactly two `rounded-full` elements in the entire codebase
(6px status dots at `GitHubPrList.tsx:101` and `HostMetrics.tsx:138`);
everything else sets `border-radius: 0` explicitly. A pill marker would be the
single most out-of-place element on the screen.

```css
.pr-review-tour-mark {
  display: inline-flex;
  flex: none;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--tour);
  background: var(--tour);
  color: var(--primary-ink);
  font-family: var(--font-mono);
  font-size: calc(9px * var(--deck-text-scale));
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
/* inactive / upcoming */
.pr-review-tour-mark[data-ghost] {
  background: transparent;
  color: var(--tour);
  border-color: color-mix(in srgb, var(--tour) 45%, var(--line));
}
```

### 4.4 The inactive step marker line

An inactive step in the file you are currently on renders as one line, not a
card:

```css
.pr-review-tour-marker {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  border: 1px dashed color-mix(in srgb, var(--tour) 30%, var(--line));
  background: transparent;
  padding: 4px 8px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: calc(9.5px * var(--deck-text-scale));
  text-align: left;
  transition:
    border-color 160ms ease,
    color 160ms ease;
}
.pr-review-tour-marker:hover {
  border-color: var(--tour);
  color: var(--ink);
}
```

### 4.5 The spine

Used in the chat card and the Review-tab panel. A 1px vertical rule from each
marker to the next, via `::before` on the list item:

```css
.pr-review-tour-spine li {
  position: relative;
  display: flex;
  gap: 8px;
  padding-bottom: 10px;
}
.pr-review-tour-spine li::before {
  content: '';
  position: absolute;
  left: 8px; /* centre of a 16px marker */
  top: 17px;
  bottom: 1px;
  width: 1px;
  background: color-mix(in srgb, var(--tour) 35%, var(--line));
}
.pr-review-tour-spine li:last-child::before {
  display: none;
}
```

Step states are `done | now | todo`. **`done` and `todo` render the same**
(`--muted`); only `now` takes `--tour` and `600`. If you add a distinct `done`
treatment, make sure it is not _brighter_ than `todo` — that bug was caught in
the mockups and reads as "completed steps are the important ones".

### 4.6 Buttons

Do not invent a button. Reuse the inline-action spec that every annotation
already uses (`theme.ts:170-209`, `styles.css:1757-1835`):

```
min-height: calc(24px * var(--deck-density-space));
border: 1px solid var(--line);
background: var(--field);
padding: 4px 6px;
font-family: var(--font-mono);
font-size: calc(9.5px * var(--deck-text-scale));   /* shadow DOM */
line-height: 1;
transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
```

Previous and Next take a `--tour` border and text; the rest stay default. Both
must **disable at the ends of the range** — clamping without disabling gives you
a live-looking control that silently does nothing.

Labels, exactly: `‹ Previous`, `Next ›`, `Start over`, `Ask about this step`,
`Close tour`, `Reopen`, and on a finding, `Show me why ›` / `Back to the
finding`.

### 4.7 Icons

There are none. `grep -rl "<svg" web/src` returns zero hits and there is no icon
library in `package.json`. Every glyph in the app layer is a literal character:
`←` `→` `‹` `›` `·` `↕` `●` `◆` `◇` `△`, plus `<kbd>` keycaps. Follow that.
The only real SVGs live inside the `@pierre/diffs` and `@pierre/trees` shadow
DOMs and are not yours.

---

## 5. Traps

**The diff is a web component with a shadow root.** `@pierre/diffs` renders
`<diffs-container>`. Annotations are injected as a full-width row between diff
lines, and your React node is slotted in from **light DOM** under the slot name
`annotation-{side}-{lineNumber}`. Practical consequence: your annotation is
styled by _both_ the shadow `unsafeCSS` in `theme.ts` (for inherited properties
— font, colour, custom properties) _and_ the app stylesheet (for everything
else). Miss either and it looks subtly wrong in one place. This is why the same
rules appear twice in the existing code.

**Nothing is the pixel size it says it is.** `--deck-text-scale` defaults to
`1.12` and `styles.css:622-715` rewrites Tailwind utilities inside
`.dashboard-grid`. A `text-[10px]` renders at 11.2px; `px-3` becomes 16px;
`h-8` becomes 36px. Author with `calc(Npx * var(--deck-text-scale))` like the
rest of the review UI, and check compact (`1.0`) and large (`1.24`) before
declaring done.

**`DESIGN.md` is stale.** It lists `violet: #8b4dff`, light `primary: #0093a8`,
light `accent: #d8248d`. The shipped values are `#b59cff`, `#006f7f`, `#b31170`.
Trust `web/src/styles.css`.

**The conversation id already contains the binding.**
`prReviewerConversationId(reviewId, headSha)` is `` `${reviewId}@${headSha}` ``
(`shared/pr-reviewer-session.ts:19`). The plan's `PrReviewTour` carries
`conversationId`, `reviewId`, `headSha` **and** `revisionKey`, and states the
uniqueness constraint as "per conversation and revision" — but the conversation
id determines both. Pick one as the key and derive the rest, or you are storing
four fields that can drift out of agreement. This is unresolved; decide it in
Phase 1.

**`shared/review-navigation.ts:103` already has a `'guided'` cursor order.**
Unrelated to tours, and a naming collision waiting to confuse someone. Either
rename it or pick names for tour code that cannot be mistaken for it.

**Responsive.** The workbench drops to two columns under 1180px and to a flex
column under 820px, with `.pr-review-compact-panels` taking over
(`styles.css:1384`, `:2183`). The mockups do not cover those breakpoints —
that is unfinished design work, flagged in the plan's Phase 5.

**Report-only findings already exist.** There is a
"Report-only — couldn't anchor to a line" panel
(`PrReviewFindingsSidebar.tsx:451`) for findings whose anchors failed to
resolve. The plan says a tour with one bad anchor is rejected wholesale. Those
two policies disagree; the tour policy is deliberate (a partial route is worse
than no route) but the UI should say so rather than failing silently.

---

## 6. Suggested order

The plan's phases in dependency order, with the shortest path to something
demonstrable:

1. **Phase 1** (domain + service) and **Phase 3's `tour` traversal kind** can go
   in parallel; neither blocks the other and the traversal kind is a one-line
   change plus its cursor wiring.
2. **Phase 2** (the tool) is a near-transcription of `draft-tools.ts`. Do not
   start it before Phase 1's validation exists — a publish that cannot reject
   is the failure mode that matters.
3. **Phase 4** (UI) is the biggest chunk. Build the annotation before the chat
   card; the card is the easier of the two and the annotation determines the
   vocabulary.
4. **Phase 4b** (read mode) is small and high value. Do it before 4c.
5. **Phase 0** (the reviewer slash-command extraction) is the largest and
   riskiest single item — it refactors working main-chat code
   (`session-view.tsx:459-517`) with regression risk on a surface tours do not
   touch. **Land it as its own PR.** Tours work without it; `/show-me` can be
   typed as plain text into the existing textarea until the typeahead exists.

The order above deliberately puts Phase 0 last despite the plan numbering it
first. The plan's sequence is a dependency order for the _complete_ feature;
this is the order that gets a working tour in front of someone soonest.
