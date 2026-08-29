# PR Review Guided Tours Plan

Status: implemented in PR #352; Phase 0 is implemented in a separate follow-up.

## Summary

Add revision-bound guided code tours to the PR review workbench. A reviewer can ask Neon to explain a flow in natural language or use `/show-me`, such as `/show-me how this bearer token is authenticated`, and Neon can publish an ordered sequence of line-anchored explanations into the diff viewer. `/tour` is an alias for `/show-me`.

Tours are not review findings. They have a distinct visual identity, interaction model, storage contract, and lifecycle. A tour explains how code fits together; it does not allege a defect, carry severity or confidence, or promote into a GitHub review comment.

There is exactly one current tour for a PR reviewer conversation and exact PR revision. Publishing a new tour atomically replaces the previous tour.

## Design

The interaction and visual design is settled. Sources and rationale:

- `guided-tours/mockups/` — six interactive boards and the canvas manifest. Start there; they are clickable and answer most layout questions faster than prose can.
- `PR_REVIEW_GUIDED_TOURS_HANDOFF.md` — the implementation handoff: resolved token values, exact CSS, the file-by-file map, and the traps.

Three decisions from that pass changed this plan and are reflected below:

1. **Tour is a seventh traversal kind**, not a new navigation model. `PrReviewNavigationBar.tsx` already has `file | hunk | review-thread | local-draft | finding | attention` on `[` / `]`. Adding `tour` gives Previous, Next, keyboard, focus and the "N of M" readout for free, and satisfies invariant 6 by construction. The `/next` and `/previous` commands this plan originally proposed are redundant and have been dropped.
2. **Tours are distinguished by form before colour.** Every shipped annotation carries a tinted fill; the tour is the only untinted one. See Visual Identity.
3. **A finding can publish a tour.** This was not in the original plan and is the strongest argument for the feature. See Findings As Tour Sources.

## Product Experience

The reviewer sidebar should continue to accept ordinary natural-language questions. When the user asks to be shown or walked through a code path, the reviewer investigates the exact reviewed revision and publishes a tour.

The primary explicit command is intent-oriented rather than implementation-oriented:

```text
/show-me where the migration is applied
/show-me how bearer tokens are authenticated
/show-me the error handling path
/show-me what changed in session persistence
/tour the new caching flow
```

`/show-me` and `/tour` normalize to the same guided-explanation intent. `/show-me` is the command shown in typeahead; `/tour` remains a discoverable alias without creating a duplicate menu entry.

Example:

```text
Tour: Bearer token authentication

1. middleware.go:123–126 · wrapAuth
   This middleware is the entry point. It extracts the Authorization header
   and delegates authentication.

2. auth.go:40–57 · decodeToken
   The signature, expiry, and claims are validated here.

3. auth.go:80–84 · writeForbidden
   Authentication failures converge here and produce the 403 response.
```

The active annotation should offer deterministic controls:

- Previous
- Next
- Start over
- Ask about this step
- Close tour

Selecting Next or Previous must not invoke the model. It should navigate the existing review surface to the target file and exact line range, select the tour annotation, and update progress locally.

Previous and Next are the existing review cursor, not new machinery: publishing a tour switches the Traverse control to `tour`, and from then on `[` and `]` walk the steps. The buttons on the annotation and in the chat card are additional affordances for the same cursor, so all three stay in sync without any extra state.

“Ask about this step” should send or prefill an unambiguous follow-up containing the tour title, step number, symbol, file, and line range.

### Walk and read

Stepping is not the only useful way to consume a tour, and for short tours it is the worse one — the reviewer presses Next three times to read four paragraphs.

The diff column should offer a `walk | read` toggle:

- **walk** shows the tour's file with the active step expanded and any other step in the same file collapsed to a marker line. This is the mode the rest of this plan describes.
- **read** concatenates only the anchored ranges, **in tour order**, each with its explanation and a link back into the diff, and names the jump between them ("back to `src/agents/pr-reviewer.ts`, 196 lines above the mount in step 2").

Read mode is the one view a diff cannot otherwise produce: a diff is always in repository order, so a four-step trace across three files reads as four unrelated hunks. It needs no data the tour artifact does not already carry — the step list is enough.

Default to read below a small step count (start at six) and keep the toggle. The mode is presentation state for one surface, like activation and closure; it is not part of the durable artifact.

## Visual Identity

Tours must be visually distinct from Neon findings, GitHub threads, and local draft comments.

Distinguish by **form first**. Every annotation type that ships today carries a tinted fill — Neon finding `primary 5%`, review thread `primary 7%`, local draft `violet 6%`, stale draft `accent 10%` — and all four read as _state_: something is true about this line. The tour takes the one slot nobody has claimed and uses **no tint at all**: flat `--field`, a 2px left rule, a numbered square marker. It reads as _chrome_ — something is being shown to you — before a word of it has been read. That is a stronger separation than a fifth hue, and it avoids adding a fifth entry to a semantic ramp already at four.

The settled visual language:

- an untinted `--field` card with `border-left: 2px solid var(--tour)`, against the tinted fills every other annotation uses
- square numbered markers (16×16, 1px border, mono, tabular-nums), filled for the active step and outlined for inactive ones — square because the app has exactly two rounded elements and both are 6px status dots
- inactive steps collapse to a single dashed marker line, not a card
- a vertical spine connecting the numbered markers in the chat card and the Review-tab panel, which is where `1 → 2 → 3 → 4` is actually legible
- "step 2 of 4" progress in tabular-nums, never confidence or lifecycle metadata
- Previous, Next, Start over, Ask about this step, Close tour
- no severity, confidence, suggested fix, promote, or finding-dismiss controls

### The tour accent

Every hue in the diff gutter is already spoken for: cyan `#00b7c7` is `--primary` and owns the base annotation fill, findings and threads; violet `#b59cff` is local draft comments, the exact thing a tour must not be mistaken for; pink `#ff4fb8` is stale and error; amber `#f0b95b` is warning. Red is reserved for future use.

Add one token, `--tour`, at a spring green — `#5cf28f` dark, `#0d7a42` light. The largest unclaimed gap on the wheel is amber 82° to cyan 208°, and ~150° sits in the middle of it, clear of red.

The risk worth naming: green reads as "approved" in a review tool. Two things blunt it — there is no success token in `styles.css` today, so pass states already use `--primary`, and the hue never appears as a card fill, only on markers, the spine and the left rule. If green is later wanted for a `--good` token, `--tour` can move to violet without redrawing anything: the form-level distinction carries the identity on its own, which is why it was built that way. Each mockup board carries a `hue` tweak for exactly this comparison.

Tours should be addressable through the diff viewer’s annotation system, but they should use a separate annotation type such as `ReviewGuideAnnotation` rather than overloading `NeonReviewFinding`.

## Core Invariants

1. A tour is bound to one durable PR review, reviewer conversation, and exact head revision.
2. At most one current tour exists for that conversation and revision.
3. Publishing is replacement-only. The agent cannot append or partially edit a tour.
4. Replacement is atomic: the UI never displays steps from two tours together.
5. Every step must resolve to a visible file and line anchor in the mounted review source.
6. Tour navigation is deterministic application behavior, not a model tool call. It is the existing review cursor under a new traversal kind, so there is one cursor and every affordance drives it.
7. Tours never create or mutate GitHub comments or local review drafts.
8. A tour from an older PR revision is stale and must not silently reanchor.
9. Repository content and diff text remain untrusted data, never agent instructions.
10. `/show-me` is the primary user-facing command and `/tour` is its alias; both have identical replacement semantics.

## Reviewer Slash Commands Precursor

Before guided tours, bring the main chat’s slash-command discovery and completion experience to the PR reviewer sidebar. Reuse the shared interaction primitives, but do not expose the main chat’s global command catalog wholesale. Commands such as `/memory`, `/watch-pr`, and `/dev-doctor` are outside the revision-bound reviewer context.

Extract or generalize the reusable composer behavior so both chat surfaces share:

- slash discovery and filtering by name, alias, label, and description
- Up and Down selection
- Tab completion
- Enter selection or submission
- Escape dismissal
- accessible combobox and listbox semantics
- explicit unknown-command errors with reviewer-scoped suggestions

Each command definition should declare its scope and dispatch behavior:

```ts
type ChatSlashCommand = {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  scope: 'main' | 'pr-reviewer';
  dispatch:
    | { kind: 'app-command' }
    | { kind: 'agent-message'; intent: string }
    | { kind: 'surface-action'; action: string };
};
```

The initial reviewer catalog should stay small:

- `/help` lists reviewer-scoped commands locally.
- `/re-review` exposes the existing exact-revision re-review capability.
- `/show-me <flow, behavior, or area>` requests a guided explanation; `/tour` is its alias.

Do not add `/next`, `/previous`, `/restart-tour`, or `/close-tour`. Navigation is the review cursor: `[` and `]` already move it, the Traverse control already selects what it walks, and the visible controls on the annotation and the chat card already drive it. Slash commands for the same thing would be a fourth spelling of one action, and typing into a composer is a worse affordance than a keystroke for something done repeatedly.

`/show-me` requires repository investigation and therefore dispatches through the existing revision-bound `pr-reviewer` conversation. It must not be added to the global `/api/commands/run` registry. The reviewer agent receives the command as conversational intent and performs the product mutation only through `neondeck_publish_pr_tour`.

Navigation commands are deterministic application actions and must not invoke the model. Ordinary natural-language questions continue through the reviewer conversation as they do today.

If input begins with `/` but does not match the reviewer catalog, do not silently send it as an ordinary model message. Show a contextual error and invite the user to type `/` to see available reviewer commands.

`/show-me` without arguments should use the active diff selection when one is available. Without an argument or usable selection, it should return usage guidance rather than submitting an ambiguous agent request.

## Model-Facing Tool

Mount one replacement-oriented tool on the revision-bound `pr-reviewer` agent:

```ts
neondeck_publish_pr_tour({
  title: string,
  summary: string,
  steps: Array<{
    key: string;
    file: string;
    side: 'additions' | 'deletions';
    startLine: number;
    endLine: number;
    symbol: string | null;
    explanation: string;
  }>,
});
```

The tool factory must derive and bind the following server-side rather than accepting them from the model:

- reviewer conversation id
- review id
- repository identity
- exact head SHA and revision key
- Flue submission/model provenance

The tool should return a structured result suitable for a custom chat renderer:

```ts
{
  ok: true,
  action: "replace_pr_tour",
  changed: true,
  tourId: string,
  generation: number,
  reviewId: string,
  revisionKey: string,
  stepCount: number,
  firstStepId: string
}
```

The agent does not need model-facing tools for append, edit-step, next, previous, start-over, or close. If the user asks for a different scope or more detail, including through another `/show-me` or `/tour` invocation, the agent publishes one complete coherent replacement.

An optional read-only `neondeck_read_pr_tour` tool may be added if later follow-ups need to recover tour context after conversation compaction. It should read only the tour bound to the current reviewer conversation and revision.

## Findings As Tour Sources

A cross-file Neon finding today has one anchor and prose for everything else. The explanation degenerates into a list of `file:line` references attached to a line that is only one of them — correct, nearly unreadable, and it leaves the reviewer to hand-navigate to the other sites to check it.

Give the finding annotation one more verb: **Show me why**. It asks the reviewer agent to publish a tour whose steps are the finding's own evidence, in the order that makes the claim. The finding's copy then shrinks to the claim itself.

Constraints, all of which fall out of the invariants already stated:

- The published tour is an ordinary tour. It carries no severity or confidence, cannot be promoted, and replaces whatever tour was current — a second finding's Show me why takes the same single slot, so nothing accumulates.
- The finding's own lifecycle is untouched. Publishing a tour is not applying, dismissing, or promoting it.
- Show me why takes the leading position in the action row but stays a plain chrome button. It is navigation, not a verdict, and must not outrank `Add to local draft`.
- The tour card carries a **Back to the finding** control, so the reviewer is never stranded inside the explanation.

This is deliberately listed after the core work — it depends on the whole tour pipeline — but it is the reason to build tours rather than a decoration on top of them. It makes tours load-bearing for review quality, which is an argument for pulling the phases in, not for deferring them.

## Agent Behavior

Add focused reviewer guidance along these lines:

> Treat `/show-me` and its `/tour` alias as an explicit guided-explanation request. When the user asks to be shown, walked through, or given a tour of a code path, investigate the complete flow and publish one ordered tour with the smallest useful set of exact-revision anchors. Use ordinary prose when the answer does not benefit from diff navigation. Verify every final anchor before publishing. Publishing a tour replaces the previous tour. If a valid replacement cannot be produced, explain why and leave the current tour unchanged.

The reviewer may use the existing Explore subagent to trace a flow across middleware, helpers, error branches, and tests. The parent reviewer remains responsible for evaluating the evidence, verifying final anchors, and publishing the single authoritative tour.

## Domain Model

Tours should be app-owned product state in Neondeck SQLite, separate from Flue conversation persistence.

```ts
type PrReviewTour = {
  schemaVersion: 1;
  id: string;
  generation: number;
  conversationId: string;
  reviewId: string;
  repoFullName: string;
  headSha: string;
  revisionKey: string;
  title: string;
  summary: string;
  steps: PrReviewTourStep[];
  provenance: {
    authorRole: string;
    model: string | null;
    submissionId: string | null;
    createdAt: string;
  };
};

type PrReviewTourStep = {
  id: string;
  key: string;
  ordinal: number;
  file: string;
  anchor: {
    kind: 'line-range';
    side: 'additions' | 'deletions';
    startLine: number;
    endLine: number;
  };
  symbol: string | null;
  explanation: string;
};
```

The database should enforce one current row per reviewer conversation and head revision, or the service should provide the equivalent transactional upsert. `generation` must increase on replacement so clients can reject delayed events from an older tour.

For v1, replacing a tour may overwrite the current stored artifact without retaining a separate tour history. The Flue conversation and submission events already retain the model interaction that produced it. If product-level tour history becomes useful later, it can be added without changing the one-current-tour invariant.

## Replacement Semantics

Publishing a tour should run as one application-owned transaction:

1. Resolve the review and exact revision from the bound reviewer conversation.
2. Validate the complete proposed tour without mutating current state.
3. Assign server-generated tour and step ids.
4. Increment the current generation.
5. Replace the stored tour and its steps atomically.
6. Publish one `tour-replaced` event containing the new generation.
7. Let the initiating client activate the first step on its own review surface.

If validation fails, the prior tour remains unchanged.

Clients must ignore a `tour-replaced` or activation event whose generation is older than the generation already mounted. Replacement must clear the old tour annotations, selection, and progress before installing the new set.

## Review Surface Integration

Extend the shared review-surface navigation target to support an optional exact anchor and annotation selection:

```ts
type ReviewSurfaceNavigationTarget = {
  path: string;
  focus: boolean;
  anchor?: {
    side: 'additions' | 'deletions';
    startLine: number;
    endLine: number;
  };
  annotationId?: string;
};
```

The existing review-surface event stream should remain the common navigation surface for the dashboard and future clients. A tour-step activation should:

1. Confirm that the target surface is showing the tour’s source and revision.
2. Open the target file.
3. Load the relevant patch if necessary.
4. Scroll to and select the exact range.
5. Expand the matching tour annotation.
6. Acknowledge resolved, stale-revision, or target-unavailable status.

The tour artifact should not require a process-ephemeral `surfaceId`. This allows it to survive closing and reopening the workbench. Activation is surface-specific: the chat card in the initiating window uses its current `surfaceId` when the user selects a step.

## Chat Integration

The reviewer chat already observes completed dynamic tool calls to refresh draft state. Extend that mechanism to recognize a successful `neondeck_publish_pr_tour` result.

On success, the chat should:

- render a custom tour card instead of a generic tool payload
- load the replacement tour
- install its annotations in the diff viewer
- activate step one on the current surface
- keep the card’s progress synchronized with selected tour steps

On reload, the PR workbench should load the current tour for its reviewer conversation and exact revision. Closing a tour should hide its annotations and active card presentation without invoking the model. The chat card may offer “Reopen tour.” Publishing another tour replaces the hidden or visible current tour alike.

The card has four states, and the middle two are the ones this plan previously left open:

1. **Investigating** — the agent is tracing. The card shows the intended title and a skeleton spine. **Nothing is installed in the diff until the whole tour validates**; a half-anchored tour is never shown.
2. **Published** — title, summary, and the numbered spine, with the active step marked. Selecting a step here and pressing `]` in the diff are the same action.
3. **Replaced** — a second `/show-me` collapses the superseded card **to a strip in place** rather than deleting it. The transcript stays readable while only one tour is live; the strip's annotations are already gone from the diff and its generation is dead. Replacement is correct either way, but this is what makes it _legible_.
4. **Closed** — the card collapses to a strip carrying Reopen. Closing hides annotations and body without deleting the tour or calling the model.

### The inspector

The inspector has two tabs (`PrReviewFindingsSidebar.tsx`). Putting the spine only in **Ask reviewer** leaves a reviewer who switches to **Review** to check findings or drafts mid-tour with no map.

The tour therefore also renders as a `pr-review-inspector-section` in the Review tab — same chrome, same heading, same `Badge` as every other panel, with the tour signal limited to the 2px left rule and the markers. It sits directly under **Review focus** and above **Neon findings**, because while a tour is open it _is_ the navigation context, and it disappears entirely when no tour is current, so it costs nothing the rest of the time.

## Events

Add a tour-specific event contract rather than disguising tour changes as finding changes:

```ts
type ReviewTourChangeEvent =
  | {
      action: 'tour-replaced';
      conversationId: string;
      reviewId: string;
      revisionKey: string;
      tourId: string;
      generation: number;
    }
  | {
      action: 'tour-activated';
      surfaceId: string;
      tourId: string;
      generation: number;
      stepId: string;
    }
  | {
      action: 'tour-closed';
      surfaceId: string;
      tourId: string;
      generation: number;
    };
```

`tour-replaced` describes durable product-state replacement. `tour-activated` and `tour-closed` describe presentation state for one active review surface.

## Validation And Safety

The publish service must reject the complete replacement if any step has:

- a file outside the bound review source
- an anchor that cannot resolve in the exact mounted revision
- a side or line range not represented by the visible patch
- an end line before its start line
- an excessive line span
- a duplicate key
- empty or oversized explanation text
- an unsupported number of steps
- a stale review or head SHA binding

Initial limits are deliberately bounded at 1–12 steps, with short titles and symbols and explanations sized for inline reading rather than essays.

The application should generate durable ids and provenance. The model must not provide HTML, executable actions, URLs, surface ids, review ids, repository paths outside the review, or revision identifiers.

## Revision Lifecycle

When the PR head revision changes:

- do not show the old tour as current on the new revision
- do not silently reanchor its steps
- preserve enough state to report that the prior tour is stale if the old conversation is inspected
- offer to regenerate the tour for the new revision
- publish the regenerated tour through the new revision-bound reviewer conversation

## Implementation Sequence

### Phase 0: Reviewer slash-command foundation

- Extract the main chat’s reusable slash-command filtering, typeahead, keyboard, and accessibility behavior from its main-session execution path.
- Add a reviewer-scoped command catalog with explicit dispatch kinds.
- Add `/help` and `/re-review` as the initial reviewer commands.
- Reserve `/show-me` as the primary guided-explanation command with `/tour` as its alias.
- Reject unknown reviewer slash commands locally instead of sending them as ordinary model messages.
- Add composer tests for aliases, completion, unknown commands, keyboard behavior, and strict separation from the global main-chat command catalog.

### Phase 1: Domain and service

- Add shared tour and tour-step contracts and Valibot schemas.
- Add app SQLite persistence and the one-current-tour replacement transaction.
- Add exact-revision anchor validation against PR review source data.
- Add service tests for atomic replacement, generation ordering, validation failure, and stale revisions.

### Phase 2: Reviewer tool

- Add the bound `neondeck_publish_pr_tour` Flue tool.
- Mount it on the continuing `pr-reviewer` agent.
- Enable `/show-me` and its `/tour` alias in the reviewer catalog.
- Update reviewer instructions and runtime context with the normalized guided-explanation intent.
- Add lifecycle tests proving the model cannot select another review or revision and a failed replacement preserves the previous tour.

### Phase 3: Review surface and navigation

- Add `tour` as a seventh `traversalKind`, and switch the Traverse control to it when a tour is published.
- Extend navigation targets with optional line anchors and annotation ids.
- Add revision-aware tour activation and acknowledgement.
- Add tour-specific events and client subscriptions.
- Verify multi-window behavior: the durable tour is shared, while activation affects only the chosen surface.
- Verify there is exactly one cursor: `[` / `]`, the annotation buttons, the chat spine and the inspector panel all move it, and all four stay in sync.

### Phase 4: Diff and chat UI

- Add the `--tour` token to both themes in `styles.css`, and to the diff viewer's shadow CSS.
- Add the distinct tour annotation renderer, the untinted card, and the square marker styling.
- Add the collapsed inactive-step marker line.
- Add the custom chat tour card with its four states, including the in-place superseded strip.
- Add the tour panel to the Review tab of the inspector.
- Implement Previous, Next, Start over, Ask about this step, Close, and Reopen.
- Load the current tour when reopening the exact PR revision.
- Ensure replacement atomically removes old annotations and resets progress to step one.

### Phase 4b: Reading view

- Add the `walk | read` toggle to the diff column, defaulting to read below six steps.
- Render the stitched view: anchored ranges only, in tour order, each with its explanation, an `Open in diff` return and a named jump from the previous step.
- Treat the mode as per-surface presentation state, never part of the durable artifact.
- Test it against a one-step tour, a tour whose steps are all in one file, and a tour with a step whose range is longer than the viewport.

### Phase 4c: Findings as tour sources

- Add `Show me why` to the Neon finding annotation and the findings panel, in the leading position, styled as ordinary chrome.
- Route it through the reviewer conversation as a guided-explanation intent carrying the finding's id, title, file and anchor.
- Add `Back to the finding` to a tour published from a finding.
- Verify the finding's lifecycle is unchanged by publishing, and that a second finding's `Show me why` replaces rather than accumulates.

### Phase 5: Evaluation and polish

- Add cross-file authentication, request lifecycle, and error-path tour scenarios to PR review evals.
- Test missing/unavailable patch anchors and generated or truncated files.
- Test conversation compaction and follow-up questions from a selected step.
- Test keyboard navigation, focus management, screen-reader announcements, split/unified diff modes, and narrow companion-display layouts.
- Measure tour investigation latency and workspace-tool usage.

## PR #352 Acceptance Criteria

- A user can ask the PR reviewer for a tour in natural language.
- Publishing a tour switches Traverse to `tour`, and `[` / `]` then walk the steps with the status line reading `Tour · 2 of 4 · <title>`.
- The annotation controls, the chat spine, the inspector panel and the keyboard all drive one cursor and stay in sync.
- A tour annotation is the only annotation in the diff with no tinted fill.
- Read mode shows the anchored ranges in tour order, and names each jump between them.
- A cross-file finding offers `Show me why`, and the tour it publishes carries no severity and cannot be promoted.
- A tour published from a finding offers a return to that finding.
- Neon can publish an ordered, exact-revision, line-anchored tour across multiple changed files.
- The first step opens automatically in the initiating workbench.
- Previous, Next, and Start over navigate without invoking the model.
- Ask about this step creates an unambiguous contextual follow-up.
- Tour annotations are visually and semantically distinct from findings and comments.

The Phase 0 follow-up implements the accessible reviewer-scoped slash-command typeahead, `/show-me` and `/tour` aliases, selection-aware argument handling, `/help`, `/re-review`, and contextual rejection of unknown reviewer commands. The shared filtering, keyboard, completion, and listbox behavior now lives under `web/src/features/chat-commands/`; reviewer catalog and dispatch ownership remain under `web/src/features/pr-review/reviewer-commands.ts`.

- Publishing a second tour atomically replaces the first everywhere it is current.
- Delayed events from the replaced tour cannot restore its annotations or progress.
- A validation failure leaves the current tour unchanged.
- A tour never creates or mutates GitHub review content.
- Tours from an older PR revision are not applied to a newer revision.
- The current tour survives closing and reopening the exact review workbench.

## Explicit Non-Goals

- general-purpose repository tutorials outside a bound PR review
- multiple simultaneous active tours in one reviewer conversation
- branching or graph-shaped tours in v1
- agent-controlled next/previous navigation
- automatic reanchoring across PR revisions
- promotion of tour steps into findings or GitHub comments
- collaborative remote synchronization beyond Neondeck’s local runtime
- exposing the main chat’s complete global slash-command catalog in the reviewer sidebar
