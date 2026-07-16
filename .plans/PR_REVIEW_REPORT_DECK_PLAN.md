# Agent-Authored PR Review Report Deck

Status: proposed

## Goal

Turn Neondeck's generated PR review HTML artifacts into real, navigable slide
decks without losing the narrative summary that currently makes the report useful.
The review agent should influence the report's content, ordering, emphasis, and
Markdown, while Neondeck owns the trusted rendering shell, navigation,
accessibility, and visual system.

This plan is inspired by the useful mechanics in Kilo's local `report-deck`
skill: one active slide, terse supporting slides, progress and position chrome,
keyboard navigation, reusable presentation patterns, and a self-contained HTML
artifact. It deliberately adapts those mechanics to Neondeck instead of copying
the template's visual styling.

## Current State

`src/lib/report-html.ts` renders a centered, vertically scrolling document:

- one header containing the complete summary;
- one bordered section for every `ReportDocumentSection`; and
- one description list for every section's label/value items.

The in-dashboard review overlay independently recreates the same layout in
`web/src/features/pr-review/PrReviewArtifactsOverlay.tsx`. Neither surface has a
slide model, active-slide state, deck navigation, progress, or presentation-aware
content limits.

The generic `ReportDocument` contract in `shared/report-document.ts` also flattens
review semantics into `title`, `body`, `label`, and `value`. By the time rendering
starts, checks, risks, findings, file references, suggested fixes, and known links
are indistinguishable strings. This causes several visible problems:

- the report reads as stacked cards rather than a presentation;
- checks and risks become repetitive numbered rows;
- Markdown syntax such as backticks is displayed literally;
- known URLs and source locations are not consistently actionable; and
- the HTML and React renderers can drift because they implement the document
  separately.

The standalone report route also currently sends this CSP:

```text
default-src 'none'; style-src 'unsafe-inline';
```

A deck controller added to the current HTML would therefore be blocked unless the
route authorizes that exact static script.

## Product Experience

### Lead with the review brief

The first slide is a restrained **Review brief**, not a decorative presentation
cover. It preserves the valuable quality of the current first card:

- the PR title and repository reference;
- the agent's complete narrative summary, authored as Markdown;
- state, head SHA, generation time, and a small set of useful facts; and
- a clear `Open PR` action from the deterministic PR URL.

The authoring guidance should target roughly 150–250 words for this summary. The
renderer must not silently truncate longer valid summaries. If content exceeds the
available frame, the summary region may scroll within the slide while the deck
chrome remains fixed.

Typography should optimize reading rather than imitate a conventional title
slide: a 65–75ch prose column, ordinary paragraph rhythm, safe inline code, and
clickable links. The headline should remain compact enough for both the
2560×720 companion display and the existing 1180×860 popout.

### Supporting slides

Slide two onward should become more visual and scannable. The default PR review
presentation is:

1. **Review brief** — narrative Markdown summary and primary PR action.
2. **PR facts** — state, base/head, review SHA, and other deterministic facts.
3. **Change map** — files and concise change summaries, risk-coded when supplied.
4. **Checks and risks** — separate groups rather than one flattened list.
5. **Findings** — severity-ordered review findings with locations and fixes.
6. **Next actions** — blockers, verification steps, and where the reviewer should
   look first.

Slides with long collections paginate deterministically. Start with a maximum of
six change-map entries or four findings per slide, then tune using real reports at
both target viewport shapes. A collection continuation retains the same title with
a visible part indicator.

The current Overview and Issues records remain separate in this iteration. Both
become decks, and the overlay retains its Overview/Issues switcher. An Issues report
with no findings should render one purposeful empty-state slide rather than two
slides that each say nothing was found. Combining both records into one artifact is
a possible later simplification, not part of this presentation update.

## Agent Authoring Boundary

The agent authors the report; it does not author executable browser content.

Extend the validated PR review output with an optional presentation plan. The exact
Valibot representation may vary, but the contract should express this shape:

```ts
type ReviewPresentationPlan = {
  summaryMarkdown: string;
  overviewSlides: ReviewSlidePlan[];
  issuesSlides: ReviewSlidePlan[];
};

type ReviewSlidePlan =
  | {
      kind: 'source';
      source:
        | 'pr-facts'
        | 'change-map'
        | 'checks'
        | 'risks'
        | 'findings'
        | 'seeded-comments'
        | 'report-only-findings'
        | 'next-actions';
      title?: string;
      layout?: 'list' | 'columns' | 'facts' | 'findings';
    }
  | {
      kind: 'markdown';
      title: string;
      markdown: string;
      tone?: 'neutral' | 'correctness' | 'security' | 'positive';
    };
```

This split gives the agent meaningful influence:

- it writes the opening summary and optional explanatory slides in Markdown;
- it chooses slide order, titles, grouping, and supported layout hints;
- it can omit irrelevant optional sources and add context where a structured list
  is insufficient; and
- it can select semantic emphasis from an allowlisted vocabulary.

Neondeck resolves `source` slides from the typed facts and findings already
validated by the review workflow. The agent does not duplicate trusted URLs,
anchors, SHAs, or PR state into presentation strings. The application enforces
required material: Review brief is always first, and known findings/risks cannot be
silently omitted from both artifacts.

The presentation plan is optional for compatibility and operational resilience. If
the agent omits it or validation rejects it, Neondeck builds the default slide order
from the existing `overview` and `findings` output. A presentation mistake must not
fail an otherwise valid review.

## Shared Deck Contract

Add a versioned shared contract, preferably `shared/report-deck.ts`, used by both
the backend HTML renderer and the dashboard:

```ts
type ReportDeckDocument = {
  version: 2;
  eyebrow: string | null;
  title: string;
  summaryMarkdown: string;
  generatedAt: string;
  links: ReportDeckLink[];
  slides: ReportDeckSlide[];
};

type ReportDeckSlide =
  | ReportDeckNarrativeSlide
  | ReportDeckFactsSlide
  | ReportDeckColumnsSlide
  | ReportDeckChangeMapSlide
  | ReportDeckFindingsSlide
  | ReportDeckEmptySlide;
```

The stored deck contains resolved, bounded presentation data. It does not contain
arbitrary HTML, CSS, JavaScript, SVG, component names, Tailwind classes, or URL
schemes. Every union member receives size and item-count limits so the renderer can
remain predictable.

The initial primitive set should stay focused on review reports. Flowcharts,
comparisons, architecture diagrams, and other typed visual primitives can be added
later without relaxing the trust boundary.

## Markdown and Link Handling

Markdown is a first-class content format for narrative fields. Support a useful
GitHub-flavored subset:

- paragraphs and line breaks;
- emphasis and strong emphasis;
- headings within sensible slide limits;
- ordered and unordered lists;
- blockquotes;
- inline and fenced code;
- tables; and
- links and autolinks.

Raw HTML is disabled. Images, embedded media, Mermaid, arbitrary SVG, and executable
code are out of scope for the first iteration. Code blocks are displayed only; they
are never executed.

Parse Markdown into a portable syntax tree with one shared parser configuration.
The standalone renderer serializes that tree into escaped HTML, while the React
renderer maps nodes to React elements. Neither path uses model-provided HTML or
`dangerouslySetInnerHTML`.

Links are intentionally clickable:

- deterministic report actions such as PR URLs, commit SHAs, file paths, and finding
  locations come from typed Neondeck data;
- Markdown links and autolinks accept only validated `http:` and `https:` targets;
- unsafe, malformed, relative, `javascript:`, `data:`, and `file:` targets render as
  inert text; and
- external anchors use `target="_blank"` and `rel="noreferrer"`.

This lets the agent write useful linked Markdown without granting it raw DOM or
script authority.

## Deck Renderer

Replace the current document renderer in `src/lib/report-html.ts` with a
self-contained deck renderer for `ReportDeckDocument`:

- fixed compact top bar with title and `current / total`;
- a two-pixel progress line;
- one active slide in the remaining viewport;
- fixed compact footer with previous/next controls and labeled position dots;
- Arrow Left/Right, Space, PageUp/PageDown, Home, and End navigation;
- touch-sized controls suitable for the companion display;
- slide-local overflow as a bounded fallback;
- URL hash synchronization for reload/deep-link stability if it stays simple;
- `prefers-reduced-motion` behavior; and
- print styles that render every slide sequentially.

Keep the static controller dependency-free. Export its exact source alongside the
renderer so the report route can authorize it with a SHA-256 CSP hash. Do not add
general `script-src 'unsafe-inline'` permission.

### Neondeck visual language

Borrow the Kilo deck's mechanics, not its skin. The report deck should remain a
Neondeck surface:

- flat square panels and hairline rules;
- no card shadows or decorative glass;
- no gradient text;
- Signal Cyan for structural state;
- pink and violet reserved for rare emphasis and workflow signal;
- semantic red/amber/green for review severity and positive state;
- IBM Plex Mono at structural seams, IBM Plex Sans for prose, and Chakra Petch only
  where the existing design system calls for display identity; and
- dark/light system themes using the existing report and dashboard tokens.

Do not copy the Kilo template's fixed 1040px maximum. Use a responsive stage that
can take advantage of the 2560×720 deck while remaining coherent in the narrower,
taller popout. Wide viewports may use two content columns; narrower viewports collapse
to one without changing typography fluidly.

## Dashboard Integration

Extract a React `ReportDeck` component and use it from
`PrReviewArtifactsOverlay.tsx`. It consumes the same `ReportDeckDocument` and
implements the same interaction semantics as the standalone artifact:

- matching slide order and content;
- local active-slide state reset when switching Overview/Issues;
- keyboard navigation scoped so it does not steal keys from other controls;
- visible focus states and labeled navigation buttons;
- an accessible current-slide announcement; and
- loading, stalled, failure, retry, popout, and close behavior preserved from the
  current overlay.

Keep the renderers aligned through shared deck fixtures. Tests should pass the same
fixture to HTML and React rendering and assert that titles, Markdown semantics,
links, slide counts, and pagination agree.

## Compatibility

- Persist `ReportDeckDocument.version = 2` in the report summary metadata and use it
  to select the new renderer.
- Retain `ReportDocument` parsing for v1 records.
- Convert a v1 document into a generic deck for the in-dashboard overlay: header to
  Review brief, each section to one or more list slides.
- Newly generated PR review files use the self-contained v2 HTML deck.
- Existing stored v1 HTML files remain immutable and readable in their current
  document format; no database or artifact rewrite is required.
- Keep the current two-report return shape and report ids so review records, links,
  retention, and workbench behavior do not need a data migration.

The generic non-review report callers (`hygiene`, `ci-fix`, and `docs-drift`) remain
on the v1 document renderer in this iteration. The shared deck primitives can be
adopted by those report kinds later, but PR review presentation should not force a
simultaneous redesign of every report.

## Implementation Order

1. **Shared contract and Markdown pipeline**
   - Add the v2 deck types and bounded parsers.
   - Add one shared raw-HTML-disabled Markdown parser configuration.
   - Add safe URL validation and Markdown fixtures.
2. **Review authoring schema**
   - Extend the PR review agent output with the optional presentation plan.
   - Update the `neon-pr-review` skill to explain supported slides, Markdown, the
     mandatory Review brief, and the trust boundary.
   - Add deterministic fallback presentation generation.
3. **Review deck builder**
   - Resolve source slides from facts, change map, checks, risks, findings, and seeded
     comment results.
   - Enforce required content and deterministic collection pagination.
   - Persist the v2 document in report summary metadata.
4. **Standalone HTML deck**
   - Add the shared visual tokens, semantic slide renderers, fixed chrome, controller,
     print behavior, and reduced-motion handling.
   - Update the report route CSP with the exact controller hash.
5. **Dashboard deck**
   - Replace `InlineReport` with the shared-model `ReportDeck` component.
   - Keep existing artifact switching and operational loading/error states.
6. **Compatibility and documentation**
   - Keep the v1 parser and generic in-dashboard conversion.
   - Update user documentation describing generated review decks and Markdown/link
     behavior.

## Verification

### Contract and security

- Valid agent-authored presentation plans parse; invalid or absent plans fall back to
  the deterministic layout without failing the review.
- Raw HTML renders as text and cannot introduce elements, event handlers, styles, or
  scripts.
- Markdown `http:`/`https:` links are clickable; unsafe schemes are inert.
- Deterministic PR, SHA, file, and finding links use typed source data rather than
  agent-repeated URLs.
- Code blocks and inline code render without execution.
- The served report CSP authorizes only the known static controller and blocks an
  injected script fixture.

### Presentation

- The first active slide is always Review brief and includes the complete narrative
  Markdown summary.
- Arrow, Space, PageUp/PageDown, Home, End, buttons, and position controls navigate
  predictably and update progress/count state.
- Change maps and findings paginate without dropping or duplicating entries.
- No-findings Issues reports produce one useful empty-state slide.
- Printing includes every slide in order, not only the active slide.
- Reduced-motion mode removes slide movement without hiding content.

### Surface parity

- HTML and React renderers agree on slide order, count, headings, Markdown, links, and
  semantic severity for shared fixtures.
- The layout remains usable at 2560×720, the 1180×860 popout, and a narrow fallback
  viewport without document-level scrolling.
- Switching Overview/Issues resets to each artifact's first slide and does not break
  Close, Pop out, or Workbench actions.
- A retained v1 report still renders in the overlay through the compatibility
  adapter.

### Project checks

- Focused report, PR review, route/CSP, and overlay tests.
- `npm run check`.
- `npm run format:check`.

## Acceptance Criteria

- Generated PR Overview and Review Issues HTML artifacts are visibly slide decks,
  not vertically stacked report documents.
- The report leads with the agent-authored narrative summary instead of replacing it
  with a decorative cover.
- The agent can author Markdown, choose supported slide order/layouts, and add bounded
  explanatory slides.
- Links are clickable while raw agent HTML, CSS, JavaScript, and unsafe URLs are never
  interpreted.
- Standalone and in-dashboard reports use one versioned deck model and remain
  behaviorally consistent.
- Navigation is keyboard, pointer, touch, reduced-motion, and print accessible.
- Existing report ids, Overview/Issues workflow contracts, retention, and v1 data
  remain compatible without a database migration.

## Non-Goals

- Giving the review agent arbitrary HTML, CSS, JavaScript, SVG, or component access.
- Executing code blocks or rendering Mermaid in the initial deck implementation.
- Copying the Kilo report deck's rounded/glass/gradient visual design.
- Merging Overview and Issues into one stored report.
- Rewriting historical HTML artifacts on disk.
- Converting hygiene, CI-fix, docs-drift, or other non-review reports in the same PR.
- Adding a general-purpose dashboard/report designer.
