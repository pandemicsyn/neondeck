# Mockups

Interactive mockups for the new PR review briefing. These files are the source;
the published design canvas is a render of them.

All boards are drawn at 1440×920 in the shipped neondeck system — Chakra Petch /
IBM Plex Sans / IBM Plex Mono, square borders, `#00b7c7` primary on `#0a0b10`.
`PanelRow` is 560×920, the shape of a dashboard panel. Each board carries a
`theme` control for checking the light palette.

The overlay's actual maximum is `min(96vw, 1440px)` × `min(92vh, 980px)`
(`web/src/features/pr-review/PrReviewArtifactsOverlay.tsx:155`), so the boards
are full width but 60px short of maximum height. Layouts should not depend on
that last 60px either way — the overlay is shorter than this on most displays.

## The boards

Specifications for the work in `../PLAN.md`:

- `ApproveB.dc.html` — briefing recommending approve. The findings become a
  manifest of what is about to be sent rather than a worklist; the footer states
  the full payload; approving turns the briefing into a receipt.
- `EscalateB.dc.html` — briefing recommending a human pass. Same layout,
  different defaults. The approve path is a de-emphasized override behind an
  acknowledgement band.
- `PanelRow.dc.html` — the Reviews panel with recommendations on the rows.

Exploration, kept for rationale and not specifications:

- `Main.dc.html` — the deck as it shipped, recreated from
  `shared/report-deck-view.tsx` and `shared/report-deck-styles.ts` so the
  comparison is honest.
- `Refinement.dc.html` — direction A, the deck kept and given a section rail.
- `Rethink.dc.html` — direction B, the deck replaced by a triage queue. This is
  the direction that was chosen; the two boards above are its verdict states.

## Sample data

A composite. Real files, paths and churn from `#313`, `#314` and `#315`, with
plausible findings in the same subsystem. Nothing here is a real review.

## Rebuilding the canvas

`canvas.json` is the layout manifest — artboard positions, the two pages, and
the sticky notes carrying the design rationale. The boards are Design Component
files: an HTML template inside `<x-dc>` plus a `class Component extends DCLogic`
block supplying its values. They render inside Claude Design's canvas editor,
not in a browser on their own.

To rebuild the canvas, re-seed these files with the `design` skill's
`seed-canvas.mjs`, passing each board with `--artboard` and this manifest with
`--canvas`.
