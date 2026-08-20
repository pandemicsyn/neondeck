# Live PR-review evals

`npm run eval:pr-review` is deliberately excluded from `check`, `test`,
`test:all`, and `verify`. It runs Neondeck's real `PrReviewAssistant` through
Flue's public in-process `start()` and `init()` APIs, so it needs live provider
credentials and can spend tokens.

Supply one external fixture at a time:

```sh
NEONDECK_HOME=/path/to/eval-home \
NEONDECK_PR_REVIEW_EVAL_PROVIDER=anthropic \
NEONDECK_PR_REVIEW_EVAL_FIXTURE=/absolute/path/to/fixture.json \
npm run eval:pr-review
```

The process environment must contain the selected provider's normal Flue
credential. The fixture's `initialData` selects the exact model and reasoning
levels; the harness replaces only its parent instructions with the current
configured initial-review prompt. Its repository path, `headSha`, `baseSha`,
and `mergeBase` must exactly match the available workspace in
`initialData`; the harness asks Git to resolve both commits and prove their
merge base before dispatch. The live assertion also verifies that every
observed parent model turn used the expected provider; Explore may
intentionally use a different configured provider. Do not put credentials or
private fixture reports in this repository.

Fixture shape:

```json
{
  "schema": "neondeck.pr-review-eval-fixture.v1",
  "scenario": "trivial-single-file",
  "immutableRevision": {
    "repoPath": "/absolute/path/to/fixture-repo",
    "headSha": "40-hex-character-head-sha",
    "baseSha": "40-hex-character-base-tip-sha",
    "mergeBase": "40-hex-character-merge-base"
  },
  "initialData": "the complete persisted PrReviewAssistant initial data",
  "message": "optional review request override"
}
```

The harness validates final review schema and task-count/batch contracts. It
captures streamed tool calls and correlated live Flue observations, including
model turns, task calls, tool activity, usage, and settlement. Failed and
aborted durable submissions are returned as reportable eval outcomes before
the live assertion fails, preserving their diagnostics. The harness
intentionally does not claim semantic recall or replay coverage until the
scenario-specific immutable fixtures (and expected findings) exist.

Each live run writes a private local JSON report beneath
`$NEONDECK_HOME/evals/pr-review/`. Set
`NEONDECK_PR_REVIEW_EVAL_REPORT=/absolute/path/report.json` to choose an
explicit destination. Reports contain model output and repository evidence;
do not publish them without reviewing their contents.
