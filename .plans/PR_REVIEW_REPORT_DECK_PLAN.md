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

- it writes the opening summary through the existing `overview.summary` field and
  optional explanatory slides in Markdown;
- it chooses slide order, titles, grouping, and supported layout hints;
- it can omit irrelevant optional sources and add context where a structured list
  is insufficient; and
- it can select semantic emphasis from an allowlisted vocabulary.

Neondeck resolves `source` slides from the typed facts and findings already
validated by the review workflow. The agent does not duplicate trusted URLs,
anchors, SHAs, or PR state into presentation strings. The application enforces
required material: Review brief is always first, and known findings/risks cannot be
silently omitted from both artifacts.

There is one summary source of truth. The agent-authored `overview.summary` remains
the authoring contract and is interpreted as Markdown. The review deck builder
copies it into the Overview `ReportDeckDocument.summaryMarkdown`; the presentation
plan does not contain another summary field. The Issues deck summary is derived
deterministically from finding and seeded/report-only counts. A fallback layout
therefore cannot choose between competing summary values.

The presentation plan is optional for compatibility and operational resilience. If
the agent omits it or validation rejects it, Neondeck builds the default slide order
from the existing `overview` and `findings` output. A presentation mistake must not
fail an otherwise valid review.

Omission handling is deterministic:

- Review brief is injected first and cannot be removed or reordered.
- Non-empty change-map, risk, finding, seeded-comment, and report-only-finding
  sources are required in the artifact that owns them.
- A valid presentation plan that omits required material is augmented by appending
  the missing source slides in canonical order; the omission is recorded in the
  workflow/report summary as a presentation warning.
- Duplicate source references are collapsed to the first occurrence.
- Unknown sources, invalid layout/source combinations, or any exceeded authoring
  bound reject only the optional presentation plan and select the complete fallback
  layout. They do not reject the review output.
- Optional Markdown and next-action slides may be omitted without augmentation.

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

Lock the initial bounds in the shared Valibot contract:

- 12 agent-authored slide-plan entries per artifact, of which at most four may be
  freeform Markdown slides;
- 48 resolved slides per artifact after deterministic collection pagination;
- 4,000 Markdown characters in Review brief, 6,000 per freeform Markdown slide,
  and 24,000 agent-authored Markdown characters per artifact;
- six change-map entries or four findings per normal collection slide;
- tables limited to 12 body rows, six columns, and 1,000 characters per cell;
- fenced code blocks limited to 4,000 characters;
- Markdown nesting limited to four levels and headings limited to levels 2–4;
- 32 links per slide, 128 links per artifact, and 2,048 characters per URL; and
- labels/titles limited to 200 characters and item prose limited to the existing
  review-output field bounds.

Bounds are validated before rendering. Oversized optional Markdown rejects the
presentation plan and selects fallback. Deterministic review data is never dropped:
if normal pagination would exceed 48 resolved slides, the final slide becomes a
scrollable, accessible appendix containing the remaining entries and links back to
the review workbench. The report summary records that overflow mode was used.

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

Use the dependencies Neondeck already ships: `react-markdown@10.1.0` with
`remark-gfm@4.0.1`. Do not add a second Markdown parser or `rehype-raw`. Extract a
shared `ReportMarkdown` component and policy module with:

- `skipHtml={true}` so raw HTML nodes are omitted while surrounding Markdown text
  remains;
- one explicit `allowedElements` list for the supported subset;
- `remark-gfm` as the only initial plugin;
- no caller-supplied remark/rehype plugins;
- component overrides that construct only the expected React elements and do not
  forward unknown model-controlled properties; and
- one custom URL validator used by both `urlTransform` and the anchor override.

The sanitizer strategy is allowlist-before-render, not cleanup of an HTML string:
raw nodes are skipped, the element vocabulary is fixed, URLs are normalized through
one validator, and React constructs the final DOM/static markup. Do not add a DOM
sanitizer or `rehype-sanitize` in the initial implementation because model-authored
HTML never enters the rendered tree. If hostile-fixture tests expose a gap, stop and
amend this dependency decision rather than layering an unplanned sanitizer onto one
surface only.

The React overlay renders `ReportMarkdown` directly. The Node renderer uses
`react-dom/server`'s `renderToStaticMarkup` on the same shared deck/Markdown
components, then wraps that static markup in the self-contained artifact chrome.
This makes the React tree and sanitization policy the shared representation instead
of introducing a second portable AST implementation. Neither path uses
model-provided HTML or `dangerouslySetInnerHTML`.

Because `react-markdown` and `remark-gfm` are existing production dependencies, the
initial implementation adds no Markdown dependency. The React-overlay PR records
the before/after Vite chunk and gzip sizes; any proposal to add another parser,
sanitizer, or raw-HTML plugin requires an explicit plan amendment and bundle review.

Links are intentionally clickable:

- deterministic report actions such as PR URLs, commit SHAs, file paths, and finding
  locations come from typed Neondeck data;
- Markdown links and autolinks accept only validated `http:` and `https:` targets;
- the validator parses the complete URL, rejects credentials and protocol-relative
  forms, applies the URL-length bound, and returns a normalized target;
- unsafe, malformed, relative, encoded/obfuscated `javascript:`, `data:`, and `file:`
  targets cause the anchor override to render only inert link text; and
- external anchors use `target="_blank"` and `rel="noreferrer"`.

This lets the agent write useful linked Markdown without granting it raw DOM or
script authority.

## Deck Renderer

Add a self-contained `renderReportDeckHtml(ReportDeckDocument)` alongside the
current v1 document renderer in `src/lib/report-html.ts` (or a focused sibling
module), and migrate only PR review callers to it:

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

Keep the static controller dependency-free and byte-stable. Define
`REPORT_DECK_CONTROLLER_SOURCE` in a dedicated module; the HTML renderer inserts
that exact string without interpolation. At module initialization, the report route
computes
`createHash('sha256').update(source).digest('base64')` and adds
`'sha256-${controllerHash}'` to `script-src`. The hash is never handwritten or
duplicated in a constant. Do not add general `script-src 'unsafe-inline'`
permission.

A route regression test independently hashes the exported controller, asserts the
served CSP contains that hash, extracts the rendered `<script>` text, and asserts it
is byte-for-byte identical to the hashed source. A served-report browser test must
exercise navigation so a controller edit cannot land with a stale or mismatched
header.

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
- keyboard navigation scoped so it does not steal keys from other controls: ignore
  handled/default-prevented events, modifier chords, and events originating from
  inputs, textareas, selects, buttons, links, or editable content;
- visible focus states and labeled navigation buttons;
- navigation controls and dots named with position and title, such as
  `Go to slide 3: Change map`, with `aria-current` on the active position;
- inactive slides removed from both the accessibility tree and tab order;
- a single `aria-live="polite"`/`aria-atomic="true"` status that announces only the
  settled slide position and title, coalescing rapid navigation so it does not spam;
- predictable focus: keyboard/button/dot navigation retains focus on the initiating
  control while the live region announces the change; switching Overview/Issues
  moves focus to the new deck heading; and
- loading, stalled, failure, retry, popout, and close behavior preserved from the
  current overlay.

Keep the renderers aligned through shared deck fixtures. Tests should pass the same
fixture to HTML and React rendering and assert that titles, Markdown semantics,
links, slide counts, and pagination agree.

## Compatibility

- The resolved `ReportDeckDocument.version = 2` stored under report summary metadata
  is the canonical structured presentation. The self-contained HTML file is an
  immutable materialized artifact generated from that same object during
  `writeReport`; both are written through the existing cleanup-on-failure flow.
- The dashboard reads the canonical metadata document. The standalone route serves
  the materialized HTML body. Shared fixtures and parity tests prove both projections
  came from equivalent deck data.
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

## Phased Delivery

Deliver this work as four independently reviewable PRs. Each phase lands with its
own focused tests and leaves the review workflow operational; later phases build on
the persisted v2 contract instead of requiring one large implementation PR.

### Phase 1 — deck contract, fallback builder, and fixtures

- Add the bounded `ReportDeckDocument` v2 types and parsers.
- Add the shared `ReportMarkdown` policy using existing dependencies and safe URL
  validation.
- Build complete default Overview/Issues decks from the current validated review
  output, with no agent-authored presentation plan yet.
- Resolve source slides, required-content rules, deterministic pagination, overflow
  appendix behavior, and empty findings.
- Persist the canonical v2 deck in report metadata while leaving visible rendering
  on the existing document surface.
- Add representative and hostile shared deck/Markdown fixtures.

### Phase 2 — standalone HTML deck and CSP

- Render the shared React deck tree to static markup for new PR review HTML files.
- Add Neondeck deck tokens, semantic slide components, fixed chrome, controller,
  print behavior, and reduced-motion handling.
- Compute and serve the static controller CSP hash from its exact exported source.
- Add route/hash regression tests and served-report browser navigation coverage.

At this point newly generated standalone review artifacts are real decks, while the
dashboard continues to use its existing inline document presentation.

### Phase 3 — React overlay parity and v1 adapter

- Replace `InlineReport` with the shared-model `ReportDeck` component.
- Add the complete keyboard, focus, live-region, named-control, touch, and viewport
  behavior.
- Convert retained v1 `ReportDocument` metadata into generic in-dashboard decks.
- Keep Overview/Issues switching and existing loading, retry, popout, workbench, and
  close states.
- Record before/after Vite chunk and gzip sizes and prove HTML/React fixture parity.

### Phase 4 — optional agent-authored presentation

- Extend the PR review output with the optional bounded presentation plan.
- Update `neon-pr-review` skill guidance for supported slide sources, Markdown,
  Review brief, omission augmentation, and the execution boundary.
- Add plan rejection/fallback, required-slide augmentation, duplicate collapse, and
  presentation-warning tests.
- Update user documentation for generated review decks and Markdown/link behavior.

This phase changes authorship flexibility, not the deck's baseline availability:
phases 1–3 already ship a complete deterministic presentation when the optional
plan is absent or invalid.

## Verification

### Contract and security

- Valid agent-authored presentation plans parse; invalid or absent plans fall back to
  the deterministic layout without failing the review.
- Required sources omitted by an otherwise valid plan are appended in canonical
  order and produce a presentation warning; an invalid or over-bound plan rejects
  only presentation intent and uses the complete fallback.
- Raw HTML is omitted and cannot introduce elements, event handlers, styles, or
  scripts; surrounding Markdown text remains readable.
- Markdown `http:`/`https:` links are clickable; unsafe schemes are inert.
- Deterministic PR, SHA, file, and finding links use typed source data rather than
  agent-repeated URLs.
- Code blocks and inline code render without execution.
- Hostile Markdown fixtures cover raw HTML, nested links, encoded/whitespace-obscured
  `javascript:`, protocol-relative URLs, credentials, giant tables, overlong URLs,
  oversized code blocks, excessive nesting, and malformed autolinks.
- Inputs that exceed concrete Markdown/slide/link/table bounds fail validation or
  select the documented fallback/appendix behavior without partial rendering.
- The served report CSP independently recomputes and authorizes only the exact known
  static controller, blocks an injected script fixture, and is exercised through a
  served navigation test.

### Presentation

- The first active slide is always Review brief and includes the complete narrative
  Markdown summary.
- Arrow, Space, PageUp/PageDown, Home, End, buttons, and position controls navigate
  predictably and update progress/count state.
- Keyboard navigation ignores interactive/editable targets, handled events, and
  modifier chords.
- Controls expose position plus slide title, inactive slides are not reachable, and
  focus follows the documented control/artifact-switch rules.
- The polite live region coalesces rapid changes and announces only settled position
  and title.
- Change maps and findings paginate without dropping or duplicating entries.
- No-findings Issues reports produce one useful empty-state slide.
- Printing includes every slide in order, not only the active slide.
- Reduced-motion mode removes slide movement without hiding content.
- In screen mode the document/body does not scroll; only the explicitly labeled
  slide content or overflow appendix region may scroll. Print mode intentionally
  lays out the full document.

### Surface parity

- HTML and React renderers agree on slide order, count, headings, Markdown, links, and
  semantic severity for shared fixtures.
- Report metadata contains the canonical v2 deck and the stored HTML is generated
  from an equivalent object in the same write flow.
- The layout remains usable at 2560×720, the 1180×860 popout, and a narrow fallback
  viewport with no screen-mode document-level scrolling.
- Switching Overview/Issues resets to each artifact's first slide and does not break
  Close, Pop out, or Workbench actions.
- A retained v1 report still renders in the overlay through the compatibility
  adapter.
- Phase 3 records the dashboard chunk/gzip delta and introduces no second Markdown
  implementation or newly duplicated parser bundle.

### Project checks

- Focused contract/builder tests in phase 1, renderer/route/CSP tests in phase 2,
  overlay/accessibility/parity tests in phase 3, and agent-plan/fallback tests in
  phase 4.
- `npm run check`.
- `npm run format:check`.

## Acceptance Criteria

- Generated PR Overview and Review Issues HTML artifacts are visibly slide decks,
  not vertically stacked report documents.
- The report leads with the agent-authored narrative summary instead of replacing it
  with a decorative cover.
- Existing `overview.summary` is the single authored summary source; resolved deck
  metadata and HTML cannot select conflicting summary values.
- The agent can author Markdown, choose supported slide order/layouts, and add bounded
  explanatory slides after phase 4; phases 1–3 provide a complete deterministic
  deck without that optional plan.
- Links are clickable while raw agent HTML, CSS, JavaScript, and unsafe URLs are never
  interpreted.
- Standalone and in-dashboard reports use one versioned deck model and remain
  behaviorally consistent.
- Navigation is keyboard, pointer, touch, reduced-motion, and print accessible.
- Screen-mode body scrolling is disabled while bounded slide/appendix regions may
  scroll when content genuinely exceeds the frame.
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
