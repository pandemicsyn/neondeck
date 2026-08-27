# Mockups

Interactive mockups for PR review guided tours. These files are the source; the
published design canvas is a render of them.

All boards are drawn in the shipped neondeck system — Chakra Petch / IBM Plex
Sans / IBM Plex Mono, square borders, `#00b7c7` primary on `#0a0b10`, text scale
pinned at 1.12. Each board carries a `theme` control for checking the light
palette and a `hue` control for comparing the proposed tour accent against
violet and against no hue at all.

The boards recreate the standalone review workbench
(`web/src/features/pr-review/PrReviewPopoutPage.tsx`), whose grid is
`minmax(240px,320px) minmax(0,1fr) minmax(300px,380px)`
(`web/src/styles.css:1350`). `Main` uses 280 / 1fr / 380 within those bounds;
`Card` and `ReviewTab` are drawn at 380px, the top of the inspector range,
because the step spine either fits there or the design is wrong.

## The boards

Page 1 — **The tour**. The core proposal:

- `Main.dc.html` (1440×920) — the whole workbench with a tour open. Previous /
  Next / Start over walk four steps; the diff, file tree, header chip and chat
  spine move together. Close tour empties the diff and collapses the card to a
  Reopen strip.
- `Coexist.dc.html` (980×920) — a tour step, an inactive tour marker, a Neon
  finding, a local draft and a review thread on one file, so the visual
  distinction is proved rather than asserted.
- `Card.dc.html` (380×920) — the chat card in four states: investigating,
  published, replaced by a second `/show-me`, and closed.

Page 2 — **Reach**. Variants and integration:

- `Reading.dc.html` (1040×920) — `walk | read` toggle in the nav bar. Read mode
  concatenates only the anchored ranges, in tour order, with the jumps between
  them named.
- `ShowWhy.dc.html` (1000×920) — a cross-file Neon finding gaining a
  `Show me why` verb that publishes its own evidence as a tour.
- `ReviewTab.dc.html` (380×920) — the tour as a
  `pr-review-inspector-section` in the Review tab, so the route stays visible
  when the reviewer is not on the Ask reviewer tab.

## Sample data

The tour traces a real code path: the `reviewId` + `headSha` binding through
`shared/pr-reviewer-session.ts`, `src/agents/pr-reviewer.ts` and
`src/modules/pr-reviewer/draft-tools.ts`. Line numbers are approximate and the
rendered source is lightly abridged. **The Neon findings, draft comments and
review threads on these boards are invented** — they are shaped like real ones
so the annotation types can be compared, and they describe no real defect.

## Rebuilding the canvas

`canvas.json` is the layout manifest — artboard positions, the two pages, and
the sticky notes carrying the design rationale. The boards are Design Component
files: an HTML template inside `<x-dc>` plus a `class Component extends
DCLogic` block supplying its values. They render inside Claude Design's canvas
editor, not in a browser on their own — opening a `.dc.html` directly shows
nothing, because the `<script src="./support.js">` line in each head is replaced
with an inline runtime at render time.

To rebuild, re-seed these files with the `design` skill's `seed-canvas.mjs`,
passing each board with `--artboard` and this manifest with `--canvas`:

```
node <skill>/seed-canvas.mjs \
  --template <skill>/payload.template.html \
  --out pr-review-guided-tours.html \
  --title "PR Review Guided Tours" \
  --artboard Main.dc.html --artboard Coexist.dc.html --artboard Card.dc.html \
  --artboard Reading.dc.html --artboard ShowWhy.dc.html --artboard ReviewTab.dc.html \
  --canvas canvas.json
```

Two traps if you edit these files, both silent:

- `data-*` attributes bound to a hole must be fed `true | undefined`, never
  `true | false`. React stringifies booleans on `data-`/`aria-` attributes
  rather than removing them, so `false` renders as `data-x="false"` and a
  presence selector like `.el[data-x]` still matches. Plain props such as
  `disabled` are exempt.
- `{{ handlebars }}` are dotted lookups only. An expression, or a key
  `renderVals()` does not return, renders empty with no error.

See `../../PR_REVIEW_GUIDED_TOURS_HANDOFF.md` for what these boards mean for the
implementation.
