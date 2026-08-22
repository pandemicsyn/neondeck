# New PR Review Briefing

Status: proposed

Supersedes `archived/PR_REVIEW_REPORT_DECK_PLAN.md`, which proposed turning the
review artifacts into a slide deck. That direction is abandoned; see
[Decisions](#decisions). Nothing in this plan is carried over from it — every
statement under [Current State](#current-state) was read from the code at the
time of writing and is cited by path.

## Goal

Replace the two-report PR review artifact surface with a single **briefing**: a
narrative brief, an agent recommendation, and a triage queue the reviewer works
and submits from. Move the recommendation onto the Reviews panel row so a safe
PR can be approved without opening the briefing at all.

The briefing stops being a document you read and becomes the surface a review
decision is made on.

## Design Source

Interactive mockups live in `mockups/` as Design Component files plus
`canvas.json`. They are the source; the published canvas is a render of them and
can be re-seeded from these files. `mockups/README.md` explains how.

Three boards are specifications for this work:

| Board               | Specifies                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `PanelRow.dc.html`  | Reviews panel rows carrying the recommendation, the one-click approve, and the receipt state            |
| `ApproveB.dc.html`  | Briefing recommending approve: the manifest, the payload-stating button, the approval note, the receipt |
| `EscalateB.dc.html` | Briefing recommending a human: queue defaults, card actions, guidance sidebar, the override band        |

`Main`, `Refinement` and `Rethink` are the exploration that led here — kept for
rationale, not as specifications.

Every board is clickable. Where this plan and a board disagree, the plan wins;
the boards are drawn at one moment and the decisions below are the record.

## Current State

Verified against the code, not against the superseded plan.

### The review record already has a verdict — and it is not this one

`src/modules/pr-reviews/types.ts:6` defines:

```ts
export type PrReviewVerdict = 'comment' | 'approve' | 'request-changes';
```

`PrReviewRecord.verdict` and `.previousVerdict` hold **the human's GitHub review
verdict**, written by `submitPrReview` (`src/modules/pr-reviews/service.ts:488`)
when the review is submitted.

**The agent's recommendation is a different concept and must not reuse this
name.** This plan calls it `recommendation` throughout. Overloading `verdict`
would conflate "what Neon suggests" with "what the human actually submitted",
which are exactly the two things the UI has to keep distinct.

### The review body already exists — the approval note is not new

`PrReviewSubmitBar` already renders a review summary textarea
(`pr-review-summary-body`) next to the verdict buttons, and gates submission on
`verdict === 'approve' || cleanCommentCount > 0 || hasBody`. The payload in
`web/src/api/github.ts:133` carries `body?: string | null` alongside `verdict`,
so the body reaches GitHub as the review body today.

`submitPrReview` (`src/modules/pr-reviews/service.ts:488`) takes only
`{ reviewId, verdict, githubReviewUrl }` — but that function is the **local
record update**, not the submission. It does not persist the body; it does not
need to for the body to be sent.

So the briefing's approval note is an existing field surfaced somewhere new, not
new capability. The record does not retain the body after submission, which is
why the receipt links out instead of rendering it (decision 16).

### Findings are persisted, and dismissal already exists for the ones that matter

`PrReviewRecord` (`src/modules/pr-reviews/types.ts:18`) carries `findingCount`,
`seededCount`, `reportOnlyCount`, and `reportOnlyFindings[]` — each with
`severity`, `path`, `line`, `summary`, `suggestedFix`, `reason`. Seeded comments
live as draft comments; report-only findings live on the record.

**`dismiss` on a draft comment is deleting the draft, which already works end to
end.** `DELETE /prs/:owner/:repo/:number/review-draft`
(`src/server/routes/github.ts:230`), `deleteDraftComment` in the workbench
(`web/src/features/pr-review/GitHubPrReview.tsx:1742`), `onDeleteComment` on the
composer, an agent-facing `delete-local-review-draft-comment` tool
(`src/modules/pr-reviewer/draft-tools.ts:219`), and the draft-events layer
underneath. The briefing reuses this path; it is not a new concept and needs no
new state.

**The review-surfaces promotion service cannot be reused for this**, for two
independent reasons:

- PR reviews do not register a review surface. `ReviewSurfaceRegistry` is
  referenced only from inside `src/modules/review-surfaces/`.
- `NeonReviewFinding` (`shared/review-finding.ts:65`) requires `surfaceId`,
  `revisionKey`, and an `anchor` — either a line range with a side, or a hunk
  id. `PrReviewReportOnlyFinding` carries `path` and a nullable `line` and
  nothing else. There is no anchor to build.

Creating a draft from a note goes through `postGitHubPrReviewDraftComment`
(`src/modules/pr-events/review-drafts.ts:207`) instead. Its input schema
(`src/modules/pr-events/schemas.ts:230`) requires `draftId`,
`expectedRevision`, `path`, `side: 'RIGHT' | 'LEFT'`, and — importantly —
`line` as an **integer ≥ 1, not nullable**. It also accepts an optional
`sourceFindingId`, so a promoted note stays traceable.

**A report-only note with `line: null` therefore cannot become a draft comment
at all.** That is a hard constraint, not a preference — see decision 15.

### The recommendation distribution cannot be backfilled or simulated cheaply

Two verified facts close off the two obvious shortcuts:

- **No recommendation backfill.** `PrReviewReportOnlyFinding.severity` is stored,
  and the existing Neon seed ledger also retains severity for seeded comments.
  However, the agent's independent danger/complexity judgment was never stored,
  so the two-input recommendation cannot be reconstructed for past reviews.
- **No cheap simulation.** The live eval harness (`src/evals/pr-review/`) is a
  contract and behavior check, not a distribution tool: its scenarios are
  explicitly metadata (`scenarios.ts:24` — "intentionally metadata, not pretend
  fixture coverage"), every case needs an externally supplied immutable
  repository revision, fixtures run one at a time with live credentials, and
  the suite is excluded from `check`. Building fixture repos to synthesize a
  distribution would cost more than it tells.

The consequence: the only way to learn how often Neon says `approve` on real
PRs is to ship and count. See "After it ships" under Phases.

The harness still matters: `assertPrReviewEvalContracts`
(`src/evals/pr-review/harness.ts:301`) parses the full
`reviewAssistStructuredOutputSchema`, so adding `recommendation` to the schema
is shape-checked for free in any eval run, and existing fixtures exercise the
prompt changes.

### Where the record gets written, and how submission actually fires

Two flow facts the phases depend on, traced end to end:

- **The join point for the recommendation.** When a review finishes,
  `completePrReviewIdempotently` (`src/modules/pr-review-assist/actions.ts:342`)
  calls `completePrReview` with `reportIds`, `findingCount`, `seededCount`,
  `reportOnlyCount`, `reportOnlyFindings`, `headSha`, `reviewUrl`. This is
  where the recommendation, its reason, and the overview JSON get persisted —
  and where `reportIds` stops being populated. The clamp must run here (or
  upstream of here), because this is the last point where every finding's
  severity is still in hand: seeded findings lose severity once they become
  drafts.
- **Submission is API-first, not workbench-bound.** `postGitHubPrReview`
  (`web/src/api/github.ts:280`) takes `draftId`, `expectedDraftRevision`,
  `headSha`, `body`, `verdict`, `commentIds`. The server route refuses unless
  the durable review exists, is `ready`, matches the submitted head SHA, and
  the verdict matches the exact submission draft
  (`src/server/routes/github.ts:303`). So the panel's one-click approve is the
  same choreography the workbench runs at `GitHubPrReview.tsx:2051` — set the
  verdict on the submission draft, then submit with the expected revision —
  and inherits every safety guard for free. It is reused, not reimplemented.

### Two reports per review

`PrReviewRecord.reportIds: string[]`, persisted as `report_ids_json`. The UI
labels index 0 `overview`, index 1 `issues`, and anything further
`report N` (`web/src/plugins/ReviewsPanel.tsx`, and again in
`web/src/features/pr-review/PrReviewArtifactsOverlay.tsx`). Both render as decks
and both begin with the same Review brief slide.

### Three document generations are live at once

- **v1** `ReportDocument` — `shared/report-document.ts`. `eyebrow`, `title`,
  `summary`, `generatedAt`, `sections[{title, body, items[{label, value}]}]`.
  Review semantics — checks, risks, findings, file references, suggested fixes —
  are all flattened into `label`/`value` strings by the time rendering starts.
  This is the core reason a review-specific document type is worth having.
- **v2** `ReportDeckDocument` — `shared/report-deck.ts`. `version: 2`, a
  `slides[]` variant over `summary | facts | columns | markdown | change-map |
findings | appendix`, with invariants (slide 0 is `summary`, `appendix` last)
  and link budgets.
- **Legacy HTML** — parsed back into v1 by
  `web/src/features/pr-review/legacy-report-document.ts`.

The overlay tries all three in order. Any new document type joins this chain
rather than replacing it.

### PR review is the only thing that produces a deck

The only deck builders in the tree are `src/modules/pr-review-assist/service.ts`
and `src/modules/pr-review-assist/report-deck.ts`. `src/lib/report-deck-html.ts`
and `src/lib/report-deck-controller.ts` are the render side, not producers. No
other report kind — docs-drift, hygiene, autopilot CI fix, issue triage — emits
one.

**So the deck is not general infrastructure that the review happens to use; it
is the review's renderer.** Since old reviews are explicitly out of scope
(decision 11), the whole stack is deleted rather than frozen:
`shared/report-deck.ts`, `report-deck-view.tsx`, `report-deck-styles.ts`,
`report-deck-fixtures.ts`, `report-document-to-deck.ts`,
`src/lib/report-deck-html.ts`, `src/lib/report-deck-controller.ts`,
`src/modules/pr-review-assist/report-deck.ts`, and the deck controller's CSP
hash — roughly 3,400 lines.

`web/src/features/pr-review/legacy-report-document.ts` and the overlay's v2 → v1
→ legacy-HTML fallback chain go with it. `shared/report-document.ts` and
`src/lib/report-html.ts` stay: the other report kinds use them.

### The review pop-out is already an SPA route

`PrReviewPopoutPage` is lazy-loaded inside the dashboard app (`web/src/App.tsx:178`)
and rendered client-side. The review workbench pop-out does not go through
`/reports/:id`.

With the briefing on the review record (decision 14), the briefing pops out the
same way — so none of the server-rendered report machinery below applies to it.
That section is retained because it governs the _other_ report kinds, which are
unaffected by this work.

### The standalone report route already runs script

`src/server/routes/reports.ts:20` builds:

```
default-src 'none'; style-src 'unsafe-inline';
script-src 'sha256-<theme bootstrap>' 'sha256-<deck controller>'
```

Two exact script hashes are already authorized, so interactivity on
`/reports/:id` is precedented — it is allowlisted per-source, not forbidden. Any
briefing controller served there needs its own hash added the same way.

### The agent's structured output

`src/modules/pr-review-assist/schemas.ts:198`:

```ts
overview: { summary, changeMap[], risks[], checks[], nextActions? }
findings: ReviewAssistFinding[]   // max 100
presentation?: unknown            // optional presentation plan
```

There is no recommendation field. `risks[]` is the closest existing signal to
"something I could not settle".

## Decisions

Settled during design. Recorded so they are not re-litigated.

1. **One briefing, not two reports.** The overview/issues switcher and the
   duplicated brief slide both go.
2. **Not a slide deck.** The briefing is a scrolling brief plus a triage queue.
   Note that PR review is the deck's only producer, so this does not leave the
   deck serving other callers — see open question 3.
3. **Two recommendations only: `approve` and `needs-human`.** The real question
   is binary — can this merge without a human reading the diff.
4. **No agent-authored caveat field.** An agent asked whether anything is worth
   flagging will find something every time, and that noise would be published
   under the reviewer's name.
5. **The approval note is human-authored** and posts as the GitHub review body.
6. **Card actions are `open in diff`, `edit comment`, `dismiss`.** Edit changes
   the text; dismiss drops it from the submission. Only dismiss changes state.
7. **No chat in the briefing.** Questions route to the workbench, where the diff
   and the review chat already are.
8. **Reviewer guidance survives as risks only** — no checklist, no
   "what I checked" roll-up.
9. **The recommendation appears on the Reviews panel row.** Rows recommending
   `needs-human` carry no approve button; the override lives inside the
   briefing, next to the reasoning.
10. **Neondeck computes a ceiling; the agent may only be more conservative.**
    Any `critical` or `major` finding forces `needs-human` regardless of what
    the agent says. The agent can escalate beyond the ceiling but never below
    it — see decision 17 for the second input.
11. **No support for reviews generated before this change.** This is a whole
    rewrite of the review artifact surface. Existing rows keep their
    `reportIds`, but nothing renders them — the panel hides the briefing action
    when a review has no briefing content. No migration, no frozen read path,
    no compatibility shims.
12. **One briefing per review**, produced instead of the two reports, not
    alongside them.
13. **The optional `presentation` field is removed** from the structured output.
    It existed to let the agent shape a deck.
14. **The briefing lives on the review record, not in the reports store.** PR
    review stops producing report artifacts entirely. `reportIds` becomes
    vestigial for reviews.
15. **Report-only notes are not dismissible.** `dismiss` keeps exactly one
    meaning everywhere: delete a real draft. Notes offer `open in diff`, plus
    `draft a comment from this` **only when the note has a line** — the draft
    comment schema requires an integer line, so a note with `line: null` cannot
    become a comment and offers `open in diff` alone. Mockup: `EscalateB`.
16. **The receipt links out rather than storing the body.** `githubReviewUrl` is
    already on the record and GitHub owns what was actually published.
17. **The agent assesses danger and complexity independently of findings.** A
    change with no findings at all can still be `needs-human` because it is
    large, risky, or hard to reason about. See the ceiling rule below.

## Contract Changes

### Agent output — the response format is a tool schema

The agent does not return free text: it submits by calling
`neondeck_submit_pr_review` (`src/modules/pr-review-assist/actions.ts:145`),
whose `input` is `reviewAssistStructuredOutputSchema`. The schema **is** the
expected response format, enforced by tool-input validation. So the format
change is exactly the schema change:

In `src/modules/pr-review-assist/schemas.ts`, on `overview`:

```ts
recommendation: v.picklist(['approve', 'needs-human']),
recommendationReason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
```

Both **required**, not optional. Prompt templates are user-overridable
(`effectivePrReviewPromptTemplates` reads `config.prReview.prompts` before the
defaults), so the tool schema is the only layer guaranteed to reach every
review — a custom prompt that never mentions the recommendation still has to
produce one to submit.

And **remove `presentation`** from the schema (decision 13), along with
`reviewPresentationPlanSchema` and its limits.

### Prompt changes, paragraph by paragraph

All in the `initial-review` template in
`src/runtime-home/pr-review-prompts.ts`:

- **Delete** the entire "You may optionally include a presentation object …"
  paragraph. It specifies deck slides, sources, layouts, and Markdown budgets
  for a surface that no longer exists.
- **Rewrite** the output paragraph ("Include an overview summary, a per-file
  change map, concrete risks and check notes, and findings. … Lead with a
  concise, plain-language summary that works as the first slide."): drop the
  slide vocabulary; the summary is written to the recommendation — an approve
  brief answers "why is this safe", a needs-human brief answers "what makes
  this hard".
- **Add** a recommendation paragraph: `approve` means this can merge without a
  human reading the diff; `needs-human` when the change is dangerous, complex,
  large, or touches something load-bearing — independently of findings — and
  explicitly: an empty findings array is not, on its own, grounds for
  `approve`. `recommendationReason` is one sentence, written for the panel row.
  (The severity clamp is not the agent's job; Neondeck enforces it in the
  service regardless of what the prompt produces.)
- **Unchanged**: the trust-boundary closer ("Draft comments are local
  suggestions only. The human reviewer edits, deletes, chooses the verdict,
  and submits.") — the recommendation is advice, and this sentence stays true.

The `follow-up-reviewer` template needs no change — it contains no deck
vocabulary and no output-format instructions. `src/skills/neon-pr-review/SKILL.md`
updates in the same spirit as the initial-review edits.

The recommendation has two independent inputs, and either can escalate:

- **Neondeck's ceiling.** Clamp in the service before persisting: force
  `needs-human` when any finding is `critical` or `major`, regardless of what
  the agent said. This is Neondeck's rule, not the agent's, and should be
  unit-tested directly.
- **The agent's own judgment about the change.** Independently of its findings,
  the agent assesses whether the change is dangerous or complex enough to want a
  human. A review that turned up nothing can still be `needs-human` because the
  diff is large, touches something load-bearing, or is hard to reason about.

So `needs-human` when `(any critical or major finding) OR (agent judges the
change dangerous or complex)`, and `approve` otherwise. **No findings does not
imply approve** — that is the whole point of the second input, and the prompt
has to say so explicitly or the agent will treat an empty findings list as a
clean bill of health.

### Review record

The briefing's fixed content lives here, not in the reports store:

- `recommendation: 'approve' | 'needs-human' | null` — null for reviews from
  before this lands, which render no briefing.
- `recommendationReason: string | null` — the one-line reason shown on the panel
  row and in the briefing's verdict bar.
- The persisted overview (summary, change map, risks) as versioned JSON,
  alongside `reportOnlyFindingsJson` — see "Briefing content" below.

One migration under `src/runtime-home/app-db/migrations/` adds the
recommendation fields and the overview JSON together.

PR review stops writing to the reports store. `reportIds` stays on the record
but is no longer populated for new reviews; whether to drop the column is
cleanup, not part of this work.

### Submission

No change. The body already reaches GitHub, and the receipt links out via
`githubReviewUrl` rather than keeping a second copy of what was published.

### Briefing content

There is no new artifact-style document type — that is deck-world thinking. The
briefing renders from two sources:

- **Persisted on the record**: the validated overview output — `summary`,
  `changeMap`, `risks`, `recommendation`, `recommendationReason` — stored as
  versioned JSON (a `schemaVersion` field, so the shape can evolve). This is
  the part that is fixed at review time.
- **Live state**: draft comments (which the reviewer edits and dismisses),
  `reportOnlyFindings`, and submission status, all read from where they already
  live. A frozen findings snapshot would go stale the moment the reviewer
  dismisses a draft — the queue must render live state or its counts lie.

No fallback chain. A review either has briefing content or has no briefing.

Entry points: the panel opens the briefing as an overlay fed directly by the
review record it already holds — no report fetch. Pop-out follows the
workbench's mechanism (a client-side route like `PrReviewPopoutPage`,
`web/src/App.tsx:178`), not `/reports/:id`.

## Phases

Development happens in phases; **the whole thing ships as one PR**. The phases
are build-and-review order on the branch, not releases — and mid-branch states
carry no release obligations. No feature flags, no dual-path rendering, no
keeping the deck alive while the briefing comes up, no half-wired UI kept
"compatible" with the old surface. A phase may leave the app broken on the
branch; the only state that has to hold together is the final one.

1. **Phase 1 — the recommendation.** `recommendation` and `recommendationReason` in the
   structured output (`src/modules/pr-review-assist/schemas.ts`); the prompt
   changes that produce it — the danger/complexity assessment and the explicit
   "an empty findings list is not grounds for approve"; the clamp in the
   service, unit-tested directly; the migration adding the recommendation
   fields and the overview JSON to `pr_reviews`.
2. **Phase 2 — the briefing render.** The briefing component, rendering the persisted
   overview plus live draft state. The deck stack, the legacy fallback chain,
   and the deck controller's CSP hash are deleted in the same change — this is
   a replacement, not an addition.
3. **Phase 3 — the summary prompt.** The brief is written **to** the recommendation: an
   approve brief answers "why is this safe", a needs-human brief answers "what
   makes this hard". The current guidance
   (`src/runtime-home/pr-review-prompts.ts:37` — "a concise, plain-language
   summary that works as the first slide") does neither, and its deck
   vocabulary goes with the deck. `src/skills/neon-pr-review/SKILL.md` updates
   alongside.
4. **Phase 4 — the actions.** Edit a draft comment in place, dismiss, the approval note,
   approve-and-submit. Every one is an existing mutation surfaced in a new
   place — the composer's update path, `deleteDraftComment`, the submit bar's
   review body, the verdict submission — so this is wiring, and the shared
   behaviour (optimistic state, draft revision conflicts, the `submitting` →
   `submitted` transition and its recovery) comes along for free. The one new
   piece: promoting a report-only note to a draft goes through
   `postGitHubPrReviewDraftComment`, and only for notes that carry a line.
   Treat any other pressure to add a new mutation as the briefing drifting from
   the workbench's model.
5. **Phase 5 — the Reviews panel row.** Recommendation chip and reason on the row;
   `approve & submit N` on rows recommending approve and nothing on
   `needs-human` rows; the `overview`/`issues` buttons collapse into one
   `briefing`; submitted rows become receipts. The approve action reuses the
   workbench's submit choreography (draft verdict, then `postGitHubPrReview`
   with the expected draft revision) so the ready/head/draft-match guards
   apply identically — extract it rather than duplicating it.

Mockups: `PanelRow` for Phase 5; `ApproveB` for the approve-mode briefing, the
note composer, and the receipt; `EscalateB` for the needs-human queue, card
actions, and the override band.

### After it ships: watch the recommendation

The design bets that Neon calls a meaningful number of PRs safe. Shipping in
one PR means that bet is checked in production rather than beforehand — which
is fine, because the needs-human briefing is the fully-featured path: if the
recommendation skews conservative, the surface still works, the approve button
just appears rarely.

So after shipping, count real reviews: how many came out `approve`, how many
`needs-human`, and whether any large-but-clean change was wrongly called
`approve`. If nearly everything is `needs-human`, tune the danger/complexity
prompt — the UI needs no change either way. A wrong `approve` on a risky change
is the failure that matters; the clamp bounds it for severity, the prompt owns
the rest.

## Non-Goals

- Rewriting how any other report kind renders. They do not use the deck;
  `report-html.ts` and the v1 `ReportDocument` stay exactly as they are.
- Any compatibility with reviews generated before this change.
- A third recommendation tier. Considered and rejected — a tier whose available
  action is identical to another tier is content, not a tier.
- Embedding the review chat in the briefing.
- Any change to the trust boundary: drafts stay local, and nothing reaches
  GitHub until the human submits.

## Deviations and Deferrals

### 2026-08-22 — Expose existing Neon seed metadata on live draft reads

- Phase: 2 — Briefing render
- Decision: Enriched live draft-comment reads with optional `neonSeverity` and
  `neonSummary` fields by joining the existing Neon seed ledger.
- Reason: The implementation review found that seeded severity and summary were
  already persisted for audit, contrary to the plan's original premise. Reusing
  that ledger lets the live briefing classify Neon drafts without freezing a
  duplicate findings snapshot. Human-authored comments remain unclassified.
- Follow-up: None. This changes the local draft read contract only; no new
  persistence or backfill was added, and legacy reviews still receive no
  briefing because their agent recommendation is unrecoverable.

### 2026-08-22 — Exclude local Claude worktrees from Vitest discovery

- Phase: Cross-cutting validation support
- Decision: Added `**/.claude/worktrees/**` to the shared Vitest exclusion list.
- Reason: This checkout contains gitignored nested worktrees whose stale test
  files were being discovered as duplicate suites, making the repository's
  standard validation commands fail outside the implementation under review.
- Follow-up: None.

### 2026-08-22 — Preserve diff side for promotable note-only findings

- Phase: 4 — Actions
- Decision: Added the original optional `RIGHT`/`LEFT` diff side to the
  existing report-only findings JSON and require both side and line before the
  briefing can promote a note into a local draft comment.
- Reason: GitHub's draft-comment mutation requires an exact side as well as a
  line. The plan retained only the line, which is insufficient and could place
  a deletion-side finding on the wrong side. This reuses existing JSON
  persistence and the existing mutation; it adds no table migration or new
  mutation surface.
- Follow-up: None. Newly generated inline-but-unanchored findings retain their
  original side. Findings without a complete anchor stay note-only.

### 2026-08-22 — Omit an unprovable submitted-comment count from panel receipts

- Phase: 5 — Reviews panel row
- Decision: Submitted rows show the durable verdict, time, and GitHub receipt
  link without claiming how many inline comments were sent.
- Reason: Workbench submissions may intentionally exclude stale or failed
  draft anchors. The submitted draft retains those skipped comments, while the
  durable review record does not persist the selected comment-id manifest, so
  its total cannot safely be labeled as “comments sent.”
- Follow-up: Persist the exact submitted comment-id manifest on the durable
  review if product validation shows that the receipt count is important.

### 2026-08-22 — Exclude immutable and generated artifacts from formatting

- Phase: Cross-cutting validation support
- Decision: Excluded nested local worktrees, the read-only review mockups, and
  generated Drizzle snapshot JSON from Prettier discovery.
- Reason: The standard format check traversed unrelated local worktrees and
  requested rewrites of source-of-truth mockups that this plan explicitly
  forbids modifying. Drizzle snapshots are generator-owned artifacts and
  should remain byte-for-byte output from the migration generator.
- Follow-up: None. Authored migration SQL and application source remain covered
  by formatting validation.
