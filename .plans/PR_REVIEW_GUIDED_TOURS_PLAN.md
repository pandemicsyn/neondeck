# PR Review Guided Tours Plan

Status: proposed

## Summary

Add revision-bound guided code tours to the PR review workbench. A reviewer can ask Neon to explain a flow in natural language or use `/show-me`, such as `/show-me how this bearer token is authenticated`, and Neon can publish an ordered sequence of line-anchored explanations into the diff viewer. `/tour` is an alias for `/show-me`.

Tours are not review findings. They have a distinct visual identity, interaction model, storage contract, and lifecycle. A tour explains how code fits together; it does not allege a defect, carry severity or confidence, or promote into a GitHub review comment.

There is exactly one current tour for a PR reviewer conversation and exact PR revision. Publishing a new tour atomically replaces the previous tour.

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

“Ask about this step” should send or prefill an unambiguous follow-up containing the tour title, step number, symbol, file, and line range.

## Visual Identity

Tours must be visually distinct from Neon findings, GitHub threads, and local draft comments.

Recommended visual language:

- numbered route markers rather than severity badges
- a tour-only accent color, such as electric cyan or violet
- visible sequence language such as `1 → 2 → 3`
- “Tour 2 of 4” progress rather than confidence or lifecycle metadata
- expanded content for the active step and compact markers for inactive steps
- Previous, Next, Start over, Ask, and Close controls
- no severity, confidence, suggested fix, promote, or finding-dismiss controls

Tours should be addressable through the diff viewer’s annotation system, but they should use a separate annotation type such as `ReviewGuideAnnotation` rather than overloading `NeonReviewFinding`.

## Core Invariants

1. A tour is bound to one durable PR review, reviewer conversation, and exact head revision.
2. At most one current tour exists for that conversation and revision.
3. Publishing is replacement-only. The agent cannot append or partially edit a tour.
4. Replacement is atomic: the UI never displays steps from two tours together.
5. Every step must resolve to a visible file and line anchor in the mounted review source.
6. Tour navigation is deterministic application behavior, not a model tool call.
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
  scope: "main" | "pr-reviewer";
  dispatch:
    | { kind: "app-command" }
    | { kind: "agent-message"; intent: string }
    | { kind: "surface-action"; action: string };
};
```

The initial reviewer catalog should stay small:

- `/help` lists reviewer-scoped commands locally.
- `/re-review` exposes the existing exact-revision re-review capability.
- `/show-me <flow, behavior, or area>` requests a guided explanation; `/tour` is its alias.
- `/next`, `/previous`, `/restart-tour`, and `/close-tour` may be added with the tour UI as deterministic surface-action equivalents of the visible controls.

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
    key: string,
    file: string,
    side: "additions" | "deletions",
    startLine: number,
    endLine: number,
    symbol: string | null,
    explanation: string
  }>
})
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
    kind: "line-range";
    side: "additions" | "deletions";
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
    side: "additions" | "deletions";
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

## Events

Add a tour-specific event contract rather than disguising tour changes as finding changes:

```ts
type ReviewTourChangeEvent =
  | {
      action: "tour-replaced";
      conversationId: string;
      reviewId: string;
      revisionKey: string;
      tourId: string;
      generation: number;
    }
  | {
      action: "tour-activated";
      surfaceId: string;
      tourId: string;
      generation: number;
      stepId: string;
    }
  | {
      action: "tour-closed";
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

Initial limits should be deliberately bounded, for example 2–12 steps, short titles and symbols, and explanations sized for inline reading rather than essays.

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

- Extend navigation targets with optional line anchors and annotation ids.
- Add revision-aware tour activation and acknowledgement.
- Add tour-specific events and client subscriptions.
- Verify multi-window behavior: the durable tour is shared, while activation affects only the chosen surface.

### Phase 4: Diff and chat UI

- Add the distinct tour annotation renderer and route-marker styling.
- Add the custom chat tour card.
- Implement Previous, Next, Start over, Ask about this step, Close, and Reopen.
- Load the current tour when reopening the exact PR revision.
- Ensure replacement atomically removes old annotations and resets progress to step one.

### Phase 5: Evaluation and polish

- Add cross-file authentication, request lifecycle, and error-path tour scenarios to PR review evals.
- Test missing/unavailable patch anchors and generated or truncated files.
- Test conversation compaction and follow-up questions from a selected step.
- Test keyboard navigation, focus management, screen-reader announcements, split/unified diff modes, and narrow companion-display layouts.
- Measure tour investigation latency and workspace-tool usage.

## Acceptance Criteria

- A user can ask the PR reviewer for a tour in natural language.
- The sidebar provides accessible reviewer-scoped slash-command discovery without exposing unrelated main-chat commands.
- `/show-me where the migration is applied` requests a guided explanation, and `/tour` behaves as its alias.
- An unknown reviewer slash command is rejected contextually rather than sent to the model.
- Neon can publish an ordered, exact-revision, line-anchored tour across multiple changed files.
- The first step opens automatically in the initiating workbench.
- Previous, Next, and Start over navigate without invoking the model.
- Ask about this step creates an unambiguous contextual follow-up.
- Tour annotations are visually and semantically distinct from findings and comments.
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
