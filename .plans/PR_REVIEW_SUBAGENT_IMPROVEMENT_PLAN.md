# PR Review Subagent Improvement Plan

Status: in progress

Implementation note: Phase 1 and the within-attempt Phase 2 projection are
implemented on the feature branch. Exact-revision cross-attempt comparison
remains unavailable until Neondeck persists immutable attempt/run/revision
bindings instead of only the current review run. Phase 3 now has a separate
runnable live-model harness and the complete scenario catalog; representative
immutable fixture repositories and their semantic expectations remain pending
the real-review baseline described in steps 5 and 6 of the recommended
implementation order.

Date: 2026-08-20

## Objective

Make Neondeck's initial and follow-up PR reviews faster, more efficient, and
more consistently evidence-backed without weakening exact-revision safety or
adding orchestration that competes with Flue.

The work should improve how the parent reviewer delegates to `explore`, how
the parent consumes delegated evidence, and how Neondeck measures and evaluates
the resulting behavior. It should preserve adaptive use of zero to three
Explore tasks, keep the default Explore reasoning effort at `medium`, and use
Flue primitives wherever they are the smallest correct fit.

## Current Baseline

The current implementation already has the important architectural pieces:

- `explore` is a Flue `defineSubagent` mounted with an explicitly configured
  model and thinking level.
- Explore defaults to `medium` thinking and can be configured during
  `neondeck init` or through typed runtime configuration.
- A delegated task receives a fresh context and a complete task briefing. It
  does not inherit the parent's conversation or review-evidence signal.
- The parent may launch up to three independent Explore tasks in one tool-call
  batch. Flue executes calls in that batch concurrently.
- The parent chooses zero, one, two, or three tasks based on genuinely
  independent review questions. No task count is preferred by default.
- Parent and child use the same exact-revision, read-only workspace tools. The
  reviewed head and merge base are application-bound rather than selected by
  the model.
- Explorer tasks have dedicated instructions for scope, exclusions,
  thoroughness, direct-path inspection, minimal additional investigation, and
  compact evidence-backed results.
- Workspace calls share a durable 500-call safety ceiling across the initial
  reviewer and its children. This is a last-resort guardrail, not a target.
- Broad list, search, and diff output can be retained in application SQLite and
  read back through bounded targeted slices.
- Flue delegated-task transcripts are durable. An interrupted task resumes from
  its child transcript rather than starting over.
- Runtime observations already record task start/completion, duration, model,
  prompt hashes, task-brief field hashes, thoroughness, result hash, result
  size, model usage, and workspace-tool activity.

This means the next improvements are primarily behavioral policy,
submission-level measurement, and live-model evaluation. They do not require a
new subagent framework, a semantic code index, or a custom task scheduler.

## Research Conclusions

### Codex explorer behavior

The checked-out Codex harness confirms that its built-in `explorer` is mainly
an orchestration policy:

- Ask explorers specific, well-scoped codebase questions.
- Launch several explorers in parallel for distinct independent questions.
- Avoid repeating work an explorer already completed.
- Continue unrelated parent work while explorers run.
- Reuse an existing explorer for related follow-ups.

Codex's built-in `explorer.toml` is empty, so that role itself does not select a
special model, reasoning effort, developer prompt, tool surface, or read-only
sandbox. Its effectiveness comes from focused task construction, ordinary
code-search tools, shared repository access, context filtering, parallelism,
and parent orchestration.

Neondeck already goes further in review-specific specialization: it has an
explicit model and reasoning configuration, a dedicated developer prompt,
exact-revision typed tools, read-only application boundaries, retained output,
and durable Flue child tasks.

### Flue 2.0.3 boundaries

This plan targets the installed Flue 2.0.3 contract:

- `defineSubagent` and `useSubagent` are the correct primitives for isolated,
  focused model work.
- A subagent receives a fresh conversation context and only its final answer
  returns to the parent.
- Task calls issued in one model tool batch execute concurrently.
- Delegated tasks have durable child transcripts and resume after interruption.
- A Flue subagent has no persistent state, conversation address, or follow-up
  handle. A continuing addressable child would need to be a registered agent
  reached through `dispatch()`.
- Runtime `observe()` events provide task, turn, tool, token, duration, and
  correlation data, but the observer is live-only and must stay cheap.
- Live-model evals should use the ordinary Flue agent surface in a separate
  Vitest suite with nondeterministic behavioral assertions.

The materially relevant bundled documentation is:

- `guide/subagents`
- `guide/observability`
- `guide/durability`
- `guide/evals`

## Decisions

### Keep adaptive zero-to-three delegation

The parent may use no explorer for a trivial or already-answerable review, one
for one focused independent question, and two or three for genuinely distinct
domains. When multiple questions are independent, the parent should launch
their task calls together in one batch. The implementation must not introduce
a hidden preference for one task or make at least one task mandatory.

### Keep fresh, complete task briefings

Every Explore prompt remains self-contained and uses the existing auditable
fields:

- `Question:`
- `Revision:`
- `Scope:`
- `Exclusions:`
- `Known facts:`
- `Expected evidence:`
- `Thoroughness:`

The parent should assign distinct ownership and sibling exclusions where that
clarifies independent work. It should not copy the whole parent conversation
or introduce a generic context-forking mode. Flue's fresh-context behavior is
the desired boundary.

### Adopt Codex's trust and non-duplication policy

Use the following wording verbatim in the applicable parent delegation
instructions:

```text
To avoid redundant work, do not explore the same problem that Explore has already covered. Typically trust Explore’s results without additional verification. Verify only the smallest evidence
needed for a mutation, external effect, security conclusion, or final review
finding. You may still inspect the code yourself to gain context needed to synthesize the review, but do not repeat the delegated investigation.
```

This replaces broad instructions that can be interpreted as requiring the
parent to replay a child's search. Exact inline review anchors remain subject to
the existing application and prompt requirements: if returned evidence did not
establish the exact RIGHT-side changed line, the parent verifies only that
smallest anchor before submitting the finding.

### Require a compact Explore result contract

Explore should finish with this compact structure:

```text
Answer:
Evidence:
- path:line — symbol — observed fact
Unresolved:
Inspected:
Stop reason: answered | insufficient evidence | blocked
```

Contract semantics:

- `Answer` directly answers the delegated question without becoming a second
  full PR review.
- `Evidence` contains workspace-relative paths, line numbers when available,
  symbols, revisions when relevant, and observed facts. Inference must be
  labeled rather than presented as observation.
- `Unresolved` lists only facts that materially prevented a complete answer;
  use `none` when the question was answered.
- `Inspected` is a compact list of the important files, symbols, diffs, or
  history surfaces actually checked. It is not a tool transcript.
- `Stop reason` makes completion behavior auditable and distinguishes a normal
  stopping decision from missing evidence or a blocked tool path.

Start with instruction-driven compliance. Do not add a typed terminal tool
unless live sessions or evals show that models fail to return the contract
reliably enough to synthesize or measure.

### Keep one initial parallel wave and targeted escalation

The normal path is one initial parallel task wave. Before a second wave, the
parent must identify a concrete unresolved review claim that cannot be answered
from the evidence already returned. The next wave should contain only the
smallest independent questions needed to resolve that claim.

This remains a behavioral rule and an observable metric, not a runtime timeout
or destructive cancellation policy.

### Keep the shared safety ceiling; do not add child timeouts

Do not add hard per-child timeouts or a smaller hard child tool-step limit.
Cancelling a long-running explorer discards useful completed work and does not
make the underlying investigation faster. Retain the durable shared 500-call
workspace ceiling as a safety boundary while treating ordinary call counts as
telemetry to optimize, not a quota to consume.

## Explicit Deferrals And Rejections

### Defer cross-submission exploration caching

Exploration result caching is not needed for interruption recovery. Flue
already resumes an interrupted delegated task from its durable child transcript.

An application cache could only help separate invocations, such as a new
review submission, repeated follow-up question, or another review attempt
against the identical revision. Exact reuse would require careful keys for the
merge base, head SHA, normalized question, scope, exclusions, thoroughness,
prompt version, workspace-tool version, model, and reasoning configuration.
Semantic reuse would add greater stale-evidence risk.

Do not implement this now. The performance aggregation should detect repeated
task prompt hashes and repeated exact-revision scopes. Reconsider caching only
if real measurements show material repeated cross-submission exploration.

### Reject deterministic path-based review-domain grouping

Do not add a rule engine that groups changed files from directory names, file
names, or lazy path heuristics. The parent sees the authoritative changed-file
index and has semantic review context; it can assess independent investigation
domains more accurately than deterministic path matching. Keep
`neondeck_review_workspace_changes` factual and let the parent decompose the
work.

### Do not add generic forked context

Do not imitate Codex's `fork_turns` modes. The complete briefing plus Flue's
fresh child context is safer, smaller, more auditable, and easier to evaluate.

### Do not make explorers addressable yet

Codex can send follow-up work to an existing explorer thread. Flue subagents
intentionally have no address. Do not replace them with registered long-lived
agents unless measurements show frequent dependent follow-ups where preserving
the child's conversation would materially improve latency or quality. For
initial reviews, focused fresh tasks remain the smaller primitive.

### Do not add a semantic index without evidence

The exact-revision changes, list, read, search, diff, hunk, history, and blame
tools already cover the review surface. Consider a semantic index only if
critical-path measurements show that repository traversal, rather than model
reasoning, provider latency, duplicated work, or synthesis, dominates review
time.

## Phase 1 — Prompt And Result Policy

Update the initial-review and follow-up-reviewer parent instructions to:

1. Use the approved trust and non-duplication wording verbatim.
2. Preserve adaptive zero-to-three delegation and one-batch parallelism.
3. Preserve complete task fields, distinct ownership, and sibling exclusions.
4. Require the compact Explore result contract.
5. Permit a second wave only for a named unresolved claim.
6. Keep exact-line verification limited to the smallest evidence needed when
   the returned evidence did not already establish the anchor.

Update the shared Explore instructions to return the result contract while
retaining the existing scope, thoroughness, direct-path, minimal-batch,
read-only, untrusted-content, and evidence requirements.

Focused deterministic tests should assert that the canonical prompt fragments
and result fields remain present. Existing Flue lifecycle coverage should keep
proving that exact-revision tools are available to the child and that the
parent alone submits the authoritative review.

## Phase 2 — Submission-Level Performance Aggregation

Build a review-level projection over the existing sanitized Flue observations.
Use Flue correlation identifiers and Neondeck's admitted review binding to
associate parent and child activity with one exact review attempt.

### Required measurements

For each review submission, retain or derive:

- Review id, attempt id, exact head SHA, and merge base where available.
- Parent model and thinking level.
- Explore model and thinking level.
- Time from admitted/start to the parent's first model turn.
- Time from the first parent turn to the first Explore task batch.
- Task count and task-wave count.
- Task count in each wave.
- Start, end, duration, outcome, and thoroughness for each task.
- Parallel critical-path duration: earliest task start to latest task end for a
  wave.
- Summed task duration for comparison with the parallel critical path.
- A concurrency-efficiency indicator derived from summed task duration divided
  by wave critical-path duration. Do not sum it into total wall time.
- Parent and child model-turn counts.
- Parent and child workspace-tool counts by tool name.
- Parent and child input, output, cache-read, cache-write, total-token, and cost
  values where the provider reports them. Sum one Flue event level only so
  rolled-up usage is not double counted.
- Time from the final task result to `neondeck_submit_pr_review`.
- Total time from admitted review to durable ready/failed settlement.
- Whether all required task-brief fields were present.
- Whether each returned answer followed the result contract.
- Explorer stop reason.
- Repeated task prompt hashes within an attempt and across attempts on the same
  exact revision.
- Repeated broad workspace operations and targeted retained-output reuse.
- Evidence of parent replay after delegation, approximated conservatively from
  overlapping path/scope hashes and repeated tool-query signatures. This is a
  diagnostic signal, not an automatic correctness judgment.

### Storage and observer constraints

- Keep the Flue `observe()` subscriber synchronous and cheap. Perform
  aggregation from already-sanitized persisted activity or queue bounded work
  outside the emission path.
- Keep product metrics in Neondeck application SQLite, separate from Flue's
  conversation/runtime database.
- Prefer deriving the first report from existing activity rows. Add an
  aggregate table only if query cost, retention, or stable historical reporting
  requires it.
- Preserve the existing privacy posture: use hashes, counts, enums, byte sizes,
  and bounded sanitized summaries rather than persisting raw repository
  content, prompts, or child answers solely for performance analysis.
- Treat `submission_settled` or the durable Neondeck review outcome as the
  terminal signal. A failed child task is diagnostic and does not necessarily
  mean the parent review failed.

### Initial analysis questions

The first report should answer:

1. Are reviews slow before delegation, inside child work, or after child work?
2. Are independent tasks actually launched in one concurrent batch?
3. How often does the parent launch a second or later wave?
4. Does the parent repeat child exploration after a successful result?
5. Which workspace tools dominate calls and elapsed time?
6. How do `quick`, `medium`, and `very thorough` tasks differ in duration,
   calls, tokens, and result quality?
7. Do configured Explore models or thinking levels materially change latency or
   findings quality?
8. How often do identical task hashes recur on the same exact revision?

Do not set new hard latency budgets until a representative real-review baseline
exists. Report distributions and outliers rather than relying on one mean.

## Phase 3 — Live-Model PR Review Eval Suite

Create a separate live-model Vitest suite that exercises the complete Flue
review loop. It must remain separate from `npm run check`, unit tests, and the
ordinary full verification path because evals spend real time and tokens and
are nondeterministic.

### Harness

- Use the normal Flue in-process or HTTP agent surface rather than mocking the
  model loop.
- Mint a fresh review conversation/attempt per case unless the case explicitly
  evaluates follow-up behavior.
- Bind every fixture to an immutable merge base and head revision.
- Capture final structured review output, tool calls, task calls, runtime
  observations, usage, and settlement.
- Record the provider, requested and response models, thinking levels, prompt
  hashes, fixture revision, and run timestamp with each result.
- Prefer deterministic assertions for tool and output contracts. Use an LLM
  judge only for semantic properties that cannot be asserted directly.

### Required scenarios

1. **Trivial single-file review** — completes without Explore when direct
   inspection is sufficient.
2. **Small coupled change** — uses zero or one task rather than splitting
   tightly coupled files into artificial lanes.
3. **Independent domains** — launches two or three distinct tasks together in
   one batch, with non-overlapping scope and useful exclusions.
4. **Named path or symbol** — inspects the target directly instead of beginning
   with broad traversal.
5. **Explorer finds a real issue** — parent uses the evidence, verifies only
   the smallest missing finding/anchor evidence, and submits the correct
   finding.
6. **Explorer returns no issue** — parent accepts the supported answer and does
   not replay the delegated investigation.
7. **Insufficient evidence** — child reports the unresolved fact and stop
   reason; parent performs the smallest targeted follow-up or returns a bounded
   supported result.
8. **Second-wave threshold** — a second wave occurs only when the fixture
   contains a concrete unresolved claim that the first wave cannot answer.
9. **Clean multi-domain PR** — completes with an empty findings array and no
   unnecessary extra exploration.
10. **Inline anchor discipline** — a finding is inline only when the exact
    RIGHT-side changed line is established; otherwise it remains report-only.
11. **Security conclusion** — the parent verifies the smallest evidence needed
    for a security conclusion without repeating the child's whole search.
12. **Follow-up reviewer** — answers from the current review context when
    possible and delegates only a genuinely new repository question.

### Assertions and scores

At minimum, report:

- Final review schema validity.
- Expected finding recall for seeded issues.
- False-positive rate on clean fixtures.
- Correct inline versus report-only disposition.
- Task count and task-wave count.
- Whether independent tasks overlapped in time.
- Delegated scope overlap.
- Parent exploration replay signal.
- Result-contract compliance.
- Parent and child turn counts, workspace-tool counts, tokens, cost, and wall
  time.
- Time before the first task batch and after the last task result.

Latency assertions should initially be comparative and distribution-based.
Avoid brittle single-run millisecond gates. Establish repeated baselines for
the chosen provider/model combination, then flag statistically meaningful or
material regressions while keeping quality and false-positive gates primary.

### Run policy

- Provide an explicit local command such as `npm run eval:pr-review`.
- Run on demand while changing prompts, model routing, tool descriptions, or
  review orchestration.
- Consider scheduled or manually dispatched CI after fixture and credential
  handling is stable.
- Do not make live evals part of the fast unit loop.
- Retain reports as local or access-controlled artifacts because they may
  contain prompts, tool arguments, repository evidence, and model output.

## Phase 4 — Data-Driven Tuning

After real-review aggregation and the eval baseline exist:

1. Compare the current Explore model and `medium` thinking against any proposed
   faster model or effort setting.
2. Tune task-brief and result-contract wording only when observations or eval
   failures identify a repeatable problem.
3. Identify whether review latency is dominated by provider/model time,
   workspace operations, sequential task waves, parent replay, or final
   synthesis before proposing architectural work.
4. Reconsider cross-submission caching only if exact repeated tasks on the same
   revision are frequent and material.
5. Reconsider addressable child agents only if dependent follow-ups are common
   enough to justify a continuing Flue agent lifecycle.
6. Reconsider additional code-navigation infrastructure only if traversal is a
   measured bottleneck after prompt and orchestration improvements.

## Recommended Implementation Order

1. Update the parent trust/non-duplication wording.
2. Add the Explore result contract.
3. Extend focused prompt and lifecycle tests.
4. Implement submission-level critical-path aggregation.
5. Analyze recent real reviews, especially reviews exceeding five minutes.
6. Build immutable eval fixtures from representative observed review shapes.
7. Add the separate live-model eval command and reports.
8. Use the baseline to evaluate later prompt, model, and reasoning changes.

## Acceptance Criteria

- Parent review instructions contain the approved trust wording verbatim.
- Explorer instructions require the compact result contract.
- Adaptive zero-to-three delegation remains intact and unbiased toward a fixed
  task count.
- Independent tasks are still launched in one Flue tool batch.
- No hard child timeout or new per-child hard step limit is introduced.
- The durable shared 500-call workspace safety ceiling remains a ceiling, not a
  target.
- Submission-level reporting separates pre-delegation, child critical-path,
  and post-delegation time.
- Reporting distinguishes task waves and actual concurrent overlap.
- Reporting separates parent and child turns, tools, tokens, and cost without
  double counting Flue roll-ups.
- Reporting can identify likely parent replay and repeated exact task hashes.
- A separate live-model eval suite covers the required no-explorer,
  single-explorer, parallel-explorer, second-wave, clean-review, real-finding,
  security, anchoring, and follow-up cases.
- Live evals are not added to the fast unit or standard verification loop.
- Cross-submission caching, deterministic path clustering, generic context
  forks, addressable explorer agents, and a semantic index remain deferred or
  rejected unless later measurements justify them.

## Non-Goals

- Implementing this plan in the planning commit.
- Making at least one explorer mandatory.
- Preferring one explorer over two or three independent explorers.
- Replacing Flue's `task` primitive with a custom scheduler.
- Copying the parent conversation into child context.
- Letting Explore submit the final review or perform mutations and external
  effects.
- Adding a hard child timeout that discards completed investigation work.
- Removing the shared 500-call safety boundary.
- Building a path-based domain classifier, semantic index, or generalized code
  search engine.
- Persisting raw model content solely for performance analytics.
