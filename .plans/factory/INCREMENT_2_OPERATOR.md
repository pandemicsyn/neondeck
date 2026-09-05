# Factory planning — increment 2

Factory remains opt-in. Enable it at `/factory`; submit a manual task and optionally
select a registered repository. Intake automatically admits one finite utility-model
triage for the source fingerprint. Its recommendation is advice: it cannot close,
release, or start a coding task. Triage does not start the planner. The same
post-admission entrypoint is available for later source integrations.

Select **Ask Neon to plan** to start the dedicated task conversation. Neon can read
bounded files from the captured local Git commit and propose a structured brief or
record a question. The rendered brief identifies model authorship. Answer in the
conversation to request another immutable revision. Chat prose itself does not save
a specification. On narrow screens, switch between Conversation and Brief. Manual
editing, retained local edits after conflicts, and exact-version human release are
unchanged. Full revision comparison and section-linked discussion belong to increment 3.

Configure the existing **utility** model role for triage and **display assistant**
model role for planning in provider/model settings. The dedicated planner shares the
configured model selection, not the display assistant's capabilities. Provider
credentials continue through the existing credential-reference resolution path.
SOUL, selected active runtime guidance, memory, model settings and source/repository
context are captured deliberately. Context changes require **Refresh planning
context** before a new request. Earlier request snapshots remain retained.

Triage is bounded to four observed model calls, a 12,000-token threshold checked
before the next call, one no-result correction, two Flue recovery attempts and a
60-second submission timeout. A single provider response may cross the token
threshold; this is not an exact provider-side output-token cap. Invalid results,
provider failures and exhausted budgets remain visible with a manual path and
**Retry triage only**. Planning submissions have two recovery attempts and a
three-minute timeout. Flue's framework `task` tool is present but inert because
neither factory agent declares subagents. Neither has a sandbox, shell, writer,
configuration, release, publication, or coding-worker tool.

Repository reads use regular files in the captured commit, with a 32 KB per-file
limit. Literal content search inspects at most 40 files / 256 KB and returns at most
50 matches plus bounded filename matches. It reports truncation. Dot paths,
traversal, symlinks, private key files and common credential directories are denied.
References in a model proposal must name evidence inspected in that request.
Unavailable local context is explicit; the human can supply context in chat.

A stopped request first loses app-side proposal authority. The persisted stop is
then reconciled against Flue admission and settlement. **Retry recovery** uses the
same recorded payload and idempotency key when admission/receipt delivery is
uncertain; a terminal failed submission requires a fresh human request. Startup
also finds intake records that were committed before triage admission. No app table
copies Flue's queues, leases, checkpoints, or transcripts.

## Validation and boundaries

The focused tests use synthetic repositories and a labelled deterministic provider.
The Flue lifecycle test shuts down and restarts the real runtime against persisted
SQLite, retains the conversation, and saves a human-requested second model revision.
Additional tests cover stale saves, cross-session capability misuse, release
rejection, admission uncertainty, stop recovery, automatic triage deduplication,
invalid output/budget exhaustion, initial-load errors and cached-state UI failures.
This fixture evidence is separate from any real-provider smoke result.

Triage repair signals retain their server-bound request identity. A valid result on
the final allowed call can finish its terminating Flue tool without another model
call, including when that response crosses the observed token threshold. Startup
collects factory recovery failures alongside the other subsystems so a malformed
factory intent cannot prevent unrelated recovery from running.

The provider-call interceptor is scoped to the runtime-bound triage submission.
If a batch contains both a valid triage call and a nonterminating invalid call,
Flue may request another turn. That continuation is rejected before another
provider call: the valid advice remains inspectable, while the receipt truthfully
records failure. Single-tool termination remains successful. The interceptor
admits each turn once and permits repeated stream reads for that same turn;
it does not maintain a second queue or retry ledger. Installation is idempotent,
cleanup is explicit, and normal runtime restarts retain the process registration.

Increment 2 does not implement GitHub ingress/writeback, full Markdown version diff,
section discussion, a coding executor, publication, or deployment. Released work
still reads **Released — awaiting coding executor**.
