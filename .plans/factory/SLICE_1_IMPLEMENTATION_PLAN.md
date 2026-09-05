# Slice 1 — Intake, collaborative shaping, and human release

Status: increments 1–4 are reviewed and open in the PR stack; increment 5 is an
uncommitted implementation candidate, with final verification and reviews pending.
Nothing in this stack is merged or deployed. Code, review, publication, merge and
live deployment acceptance are separate gates.

This implements **slice 1: Intake to inbox** from the
[software factory proposal](../research/software-factory-proposal.html#rollout).
The [handoff](SLICE_1_HANDOFF.md) defines ownership and the GitHub PR stack.
This document is the detailed slice contract; the proposal remains the wider
architecture reference. Changes to this contract must be explicit.

## 1. Outcome and boundary

A user can submit a task manually or admit a GitHub issue, see a small model's
triage recommendation, and shape it with Neon in a persistent conversation. Neon
reads bounded repo context, proposes an approach and acceptance criteria, asks
questions, and revises a durable brief. The human compares revisions and releases
one exact version into the queue. An opted-in GitHub connection maintains a concise
issue status comment and brings attributed issue replies into the conversation.

The final queue reads **“Released — awaiting coding executor”**. It has no worker
consumer in this slice. A released task is neither running nor completed.

Included:

- Manual and GitHub sources, explicit source-to-repo mapping, durable inbox.
- Deterministic validation, deduplication, reconciliation, and cheap model triage.
- One persistent planning conversation per work item, with stable context.
- Immutable brief/plan revisions, open decisions, review and human release.
- Existing briefing, chat, Markdown and diff UI adapted for task shaping.
- A dedicated public webhook listener and private dashboard/API deployment path.
- Opt-in managed GitHub status comments; explicitly approved outbound questions;
  attributed inbound replies; visible sync failures and recovery.

Excluded:

- Coding agent launch, worker allocation, worktree creation, execution sessions,
  dev servers, tests run by Neon, artifact collection, coding cleanup, and PR delivery.
- Codex/OpenCode adapters, VM provisioning, remote sandbox support, Linear,
  multi-repo tasks, auto-release, auto-merge, and auto-deploy.
- Replacing existing PR Autopilot/Kilo features or rebuilding the removed Autopilot
  coordinator. Factory source/effect records are product state, not a new Flue runtime.
- Rich threaded inline review, interactive proposal HTML, and a new generic document
  platform. MVP feedback uses chat plus revision-bound document context.

The implementation PRs described below are development delivery work. They are
separate from the factory's future ability to generate PRs for its own tasks.

## 2. End-to-end flow and human touchpoints

| Step         | Deterministic application work                                                  | Model contribution                                                                         | Human interaction                                                                         |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Configure    | Bind a source to a registered repo; validate readiness and policy               | Explain missing setup if asked                                                             | Choose admission rules and explicitly enable writeback, if wanted                         |
| Admit        | Verify/dedupe delivery, fetch current issue, map repo, persist source/work item | None in the HTTP request                                                                   | Submit manually or configure which issues enter the inbox                                 |
| Triage       | Dispatch bounded reasoning after meaningful input changes                       | Recommend implement/investigate/clarify/duplicate/defer/decline, with reasons and unknowns | Correct the recommendation, choose a repo, or disposition the task                        |
| Shape        | Bind the task conversation and revision tools                                   | Propose a brief, inspect allowed repo facts, ask focused questions, revise the approach    | Answer in chat, edit Markdown, ask for alternatives, compare versions                     |
| Resolve      | Persist questions/answers and their revision references                         | Explain remaining decisions and recommend an answer                                        | Resolve blocking scope/design choices; optionally approve an exact question for GitHub    |
| Release      | Atomically validate the current revision and record authority                   | Summarize readiness; cannot grant release                                                  | Review scope, criteria and permitted next step; select **Release vN**                     |
| Hold         | Preserve the exact released version and queue position                          | No coding work                                                                             | Pause, withdraw release, or reopen shaping; see that executor support is pending          |
| Update issue | Reconcile opted-in, owned external effects                                      | May draft public-safe summary/question text                                                | Review publishable summary or question; issue replies are context, never release commands |

Waiting is durable. Show who needs to act, the specific question, Neon's
recommendation, relevant evidence, and available choices. Silence, a thumbs-up in
an issue, or a model saying “approved” does not authorize release. Ordinary planning
turns and already-authorized status updates do not require repeated confirmation.

## 3. Small domain model and invariants

Keep application records in the existing app SQLite database. Flue owns conversation
history, submissions and turn recovery in its own database. Use Valibot at API,
provider, model-tool and persisted-data boundaries. Names below are proposed domain
contracts, not a mandate to create one table or framework per row.

| Record            | Minimum durable content and identity                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source connection | Provider, configured repo mapping/admission rule, credential references, enabled state, writeback policy and consent                                                    |
| Inbound delivery  | Connection + delivery ID unique key, event/action, bounded verified payload or normalized recovery envelope, digest, processing result/error and retry metadata         |
| Work source       | Provider + stable remote issue identity, current source revision/fingerprint, repo mapping, source status and attribution; manual submissions have a client request key |
| Work item         | Source link, title, repo ID, lifecycle, triage result, current spec revision, planning session binding, attention reason and optimistic concurrency version             |
| Spec revision     | Work item + increasing version, immutable canonical content, author kind/identity, parent version, source/context references and content hash                           |
| Release decision  | Human actor, exact spec version/hash, repo, accepted source/context versions, limited authority, timestamp; withdrawal/invalidation preserves the prior decision        |
| External effect   | Work item, operation identity, authorized payload/hash, desired vs applied status, remote receipt/comment ID, attempts/error and reconciliation state                   |

A spec contains outcome, scope/non-goals, approach Markdown, acceptance criteria
with stable IDs, constraints, assumptions, unresolved decisions, and supporting
source/repo references. Brief and plan sections belong to the same immutable
revision: avoid independently versioned narrative copies that drift. Render the
canonical record into Markdown and a deterministic text form for diffing. Answers
that change the specification create a new revision; chat itself is not the spec.

Use the smallest lifecycle: `inbox → shaping → queued`, plus `paused` and `closed`.
Triage disposition, model activity, sync health, and attention reason are separate
facts, not dozens of lifecycle phases. Required behavior:

1. A delivery retry cannot create another work item. A new delivery concerning the
   same issue updates its source, not its identity. Multiple connections cannot
   silently create competing work for one admitted issue; ambiguous mappings wait
   for a human. Duplicate suggestions across different issues require human choice.
2. Triage is advice. It cannot close an issue, discard work, select an unconfigured
   repo, grant permissions, or release a task. Invalid/failed triage leaves an
   inspectable inbox item with a retry or manual path.
3. Revision saves use `expectedVersion`; stale editor and model saves return a
   conflict with current revision information. No last-writer-wins spec updates.
4. Release checks the current spec, repo, source revision, unresolved blocking
   decisions and caller authority in one transaction. Repeated identical release
   requests are idempotent. A new revision withdraws the queued eligibility of the
   old release atomically, while keeping its audit history.
5. A meaningful source/body/repo/context change makes release stale and requires
   review; a new comment is attributed context, not an automatic spec edit. A
   material reply is flagged for review and cannot silently expand released scope.
6. Source closure pauses work and invalidates queued eligibility. An out-of-order
   “opened” event cannot revive it. Reopening returns it to human review; it never
   resurrects an old release. Pause/close racing release must resolve transactionally.
7. Release records approval to implement the exact spec under the displayed, versioned
   coding policy, even though this slice has no executor. It does not grant publish,
   merge or deployment authority. A future executor must honor those captured limits;
   ask again only if scope, context or permissions change, not merely because executor
   support has been installed. Missing or incompatible policy makes work ineligible.
8. One app service owns transitions. UI, APIs and model tools use that service;
   no business rules live only in buttons, prompts, labels or chat parsing.

Use the existing audit/notification primitives where they fit; avoid a generic
event-sourcing system. Persist only the domain operations needed to recover work,
not parallel copies of Flue message queues, leases, checkpoints or turn status.

## 4. Triage and planning model responsibilities

### Bounded triage

After eligibility checks, admit one finite Flue submission for an input fingerprint.
Use the existing configured utility model role by default and a bounded input,
turn/token budget and retry policy. Record model/config identity and the result.
Configuration must use the existing provider and credential-reference system.
No hardcoded provider key or new model gateway.

The classifier receives normalized source facts, configured repo candidates and a
bounded set of possible duplicates. Its typed result contains disposition,
reasoning summary, priority suggestion, missing information and candidate links.
It gets no shell, write, release, or external publication tools. A failed schema
check can receive a bounded repair attempt; exhaustion becomes Needs attention.
Subsequent issue comments do not restart classification of an already-shaped task.

### Continuing planning

Add a dedicated, explicitly named planning agent with a per-work-item Flue identity.
Reuse normal chat/session infrastructure, with `kind: task` and a durable factory
binding. Do not reuse the singleton daily briefing conversation or expose all of
the display assistant's capabilities to a planning session.

The model can read the current source/spec, read and search bounded files in the
mapped repo, propose a new spec revision, and record focused questions. It cannot
edit repository files, run arbitrary shell commands, release tasks, update source
policy, or publish to GitHub. Use curated read tools and revision-pinned repo
references; do not mount a writable coding sandbox just to enable exploration.
Missing local repo context is visible and can be supplied by the human; invented
code references are not acceptable evidence.

Capture SOUL, selected skills, model settings, memory summaries and repo/source
context deliberately. Repo evidence records the inspected commit and path.
Context refresh is an explicit action with a visible change record; if rotation is
needed, retain a link to the prior conversation and its artifacts.

Use ordinary model prose for collaboration and schema-backed tools for durable
drafts. Do not force every conversational reply into a JSON “workflow response.”
Track submission receipts and use Flue's documented recovery/idempotency facilities.
The app persists a pending dispatch intent before crossing databases; recovery
reconciles that intent/receipt before resubmission. Never assume a transaction spans
app SQLite and Flue SQLite. A stale turn's spec save must fail its version check.

Tool authorization derives from the server-bound work item/session, not a model
supplied ID. Planning agent routes must enforce that binding for read, send, abort
and attachment operations. No human-release service is registered as a model tool.
Tests must prove that source text cannot invoke it indirectly through another tool.

## 5. Shaping workbench in Neon

Add a Factory inbox entry within the existing dashboard navigation. Show source,
repo, triage recommendation, lifecycle, and next human action. A task opens a
briefing summary with links into a split workbench: conversation beside the current
rendered brief/plan. On narrow screens preserve these as navigable views.

Required interactions:

- Submit a manual task; select a registered repo or leave it explicitly unresolved.
- Ask Neon to propose a plan; answer questions and request changes in normal chat.
- Read rendered Markdown, enter edit mode, save a new version, cancel edits, and
  recover from stale saves without losing the user's local text.
- Compare any two retained versions using the existing diff renderer. Show author,
  version and changed acceptance criteria, with readable empty/loading/error states.
- “Discuss this section” carries the version and stable section/criterion reference
  into chat. A minimal section reference is enough; do not build a rich inline
  comment database for this slice. Stale references remain attached to their version.
- Review open decisions, accepted repo/source context, and a release summary. The
  button names the actual version. Disable/reject release with a specific reason.
- Pause/withdraw/reopen without deleting history. Show pending model work and
  writeback errors independently of whether the task is ready for human review.

Reuse `MarkdownMessage`, existing chat message/session components, briefing
presentation and `@pierre/diffs`. Extract small reusable presentation pieces where
necessary. The configured chat plugin currently accepts only `display-assistant`:
add a typed planning-session route/client binding, not arbitrary configurable agent
URLs. Do not impersonate a PR to get document diffs. Add a narrow revision/document
source adapter if needed, with truthful capability flags and canonical retained text.

The review-surfaces registry is ephemeral; it cannot store the canonical draft or
review decisions. Keep those in app SQLite. Preserve existing morning briefings,
PR reviews, guided tours, and display-assistant behavior.

## 6. GitHub ingress, reconciliation and exposure

Start with one explicitly configured repo webhook connection per mapping and the
existing GitHub credential resolution. Building GitHub App installation/OAuth UI
is out of scope. Admit `issues` lifecycle/content events and relevant
`issue_comment` events; exclude PR-shaped issues and unrelated actions.

Use a separate minimal Hono app on a dedicated public listener. It exposes only
`POST /hooks/github/:connectionId` and a minimal health endpoint. The connection ID
is a routing identifier, not a secret. No dashboard, `/api`, `/agents`, reports,
attachments, static app fallback or catch-all forwarding can reach the private app.

Verify `X-Hub-Signature-256` against the original bounded request bytes using HMAC
SHA-256 and constant-time comparison before parsing/processing. Reject missing or
malformed signatures. Validate event/action and payload schemas, and bind signed
repo identity to the configured connection. Do not trust payload-supplied URLs as
arbitrary fetch targets. These follow GitHub's
[signature validation guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Persist accepted deliveries before acknowledging; keep model calls and provider
fetches out of the request path. Duplicate delivery IDs acknowledge the retained
receipt. Persistence failures cannot return success. GitHub expects a prompt
response and preserves delivery IDs on redelivery; use its
[webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
when setting request deadlines and replay tests.

Process accepted input asynchronously through a small app-owned recovery loop.
Re-fetch the current issue with full required fields: the existing open-issue
listing's 600-character excerpt is insufficient for a planning source or closure
check. Serialize source updates, retain a content fingerprint, and refuse older
remote revisions from overwriting newer state. Process comments by remote identity
and revision so retries and edits don't create repeated planning messages.

Reconcile accepted-but-unprocessed deliveries on startup. Also support operator
“Sync source” and a bounded periodic rescan of admitted issues and eligible changed
issues, with overlap, pagination and durable cursors. A truncated page cannot mark
unseen issues removed or advance a cursor past unprocessed data. Include closed
issues and comment edits/deletions in reconciliation. This repairs missed events
without depending on automatic provider redelivery. Retry transient failures with
backoff; auth/mapping failures become concrete operator attention.

Production wiring is part of the slice, not a dev-only example. Integrate both
listeners into the packaged Node server lifecycle with one runtime owner, shared
services, graceful shutdown, and bind/startup failure reporting. Verify that the
Vite/Flue production bundle contains the ingress app and planner. Do not start a
second Flue runtime or duplicate scheduler because a second HTTP port exists.

Deploy the webhook listener through exe.dev public routing. Keep dashboard/API
access private behind verified operator authentication or an SSH-only route.
Existing host/origin checks are browser request guards, not internet authentication.
Check the actual routing configuration at deployment time using the
[exe.dev documentation index](https://exe.dev/llms.txt); do not hardcode any VM or
deployment hostname. An anonymous probe must prove private routes are inaccessible.

## 7. GitHub writeback and inbound discussion

`off` is the stored default. Setup offers an explicit opt-in `status` policy with a
preview explaining the allowed fields and transitions. Choosing `status` authorizes
one maintained comment on an admitted issue, containing a template-based state,
accepted public summary/spec version where available, and the next action. No PR
link exists yet. A private workbench link is included only when explicitly configured
as shareable; never expose internal deployment addresses automatically.

The human approves the publishable scope summary in the shaping/release surface.
Before that, publish only authorized template status; don't send draft internals.
Coalesce state changes. Never publish raw chat, prompts, logs, secrets, private
repo context or speculative implementation claims. Do not change issue bodies,
labels, assignees or open/closed state in slice 1.

“Ask on GitHub” is a separate action: Neon drafts a concrete question, the human
edits/previews and explicitly sends that payload to that issue. It is not implied by
ordinary status consent. It can create an attributed question comment with its own
effect identity; the single managed status comment remains distinct. An edited
question requires new approval. Incoming replies carry author, source comment and
revision references; they can answer a question or propose a change, never release
work or grant execution/publication authority.

Extend the existing GitHub client with typed issue-comment list/create/update
operations. Persist the desired authorized effect before writing. Store a stable
ownership marker, content hash and remote comment ID. On timeout or restart,
reconcile remotely before retrying a create; GitHub comment creation must not be
treated as an exactly-once operation. Serialize writes per issue, and never claim
success without a receipt or observed matching comment. If remote reconciliation
is inconclusive, show “sync uncertain” and do not blindly create another comment.

Ignore echoes only when they match our recorded remote identity/ownership and
revision. A bot login alone is insufficient: it could also post relevant unrelated
comments. Detect human edits/deletions of managed comments, stop automatic overwrite
or recreation, and offer an explicit repair choice. A failed status write is visible
and retryable but does not block an otherwise valid release. An unanswered blocking
planning decision still does.

## 8. Existing code: reuse, adapt, preserve

| Area                                    | Entry points to inspect                                                                                                                                         | Decision                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Config, repos, credentials              | `src/runtime-home/`, `src/modules/config/`, `src/modules/repos/`, `src/modules/github/`                                                                         | Reuse home resolution, repo IDs, provider settings and credential references; add typed factory config |
| Domain persistence                      | `src/runtime-home/app-db/`, nearby module stores, `shared/`                                                                                                     | Add forward migrations and domain/API schemas; keep Flue storage separate                              |
| Sessions and context                    | `src/modules/sessions/`, `src/modules/briefings/service.ts`                                                                                                     | Reuse task session indexing and stable context patterns; add explicit planner binding                  |
| Finite model work                       | `src/modules/pr-review-assist/admission.ts`, `src/agents/pr-reviewer.ts`                                                                                        | Adapt bounded submission/recovery and route-binding patterns; do not copy PR-specific state            |
| Agent tools                             | `src/modules/briefings/actions.ts`, `src/modules/pr-reviewer/draft-tools.ts`                                                                                    | Reuse typed tools and server-derived scope; keep release/publication unavailable to planner            |
| GitHub                                  | `src/modules/github/issues.ts`, `comments.ts`, `client.ts`                                                                                                      | Extend detail/comment operations; preserve existing list consumers                                     |
| Server and startup                      | `src/server/create-app.ts`, `src/server/serve.ts`, `src/server/app.ts`, Vite server build config                                                                | Add isolated ingress and recover domain intents once per runtime                                       |
| Events/attention                        | `shared/dashboard-events.ts`, `src/server/events/event-stream.ts`, `web/src/api/event-hub.ts`                                                                   | Add typed factory updates to existing event stream; reuse notifications                                |
| Briefing/chat/Markdown                  | `web/src/plugins/BriefingPanel.tsx`, `web/src/features/flue-chat/`, `web/src/components/MarkdownMessage.tsx`, `web/src/features/pr-review/PrReviewBriefing.tsx` | Reuse presentation; separate task binding from singleton/PR-specific behavior                          |
| Diffs and review references             | `shared/review-source.ts`, `src/modules/review-surfaces/registry.ts`, existing diff components                                                                  | Adapt renderer and source contracts narrowly; persist spec versions elsewhere                          |
| Old issue triage                        | `src/skills/neon-issue-triage/SKILL.md`, `scripts/check-import-layers.mjs`                                                                                      | Skill guidance remains but `src/modules/issue-triage/` does not exist; no service to reuse             |
| Kilo, worktrees, PR Autopilot, learning | Existing modules and `.plans/DEVIATIONS.md`                                                                                                                     | Preserve behavior. Later slices own execution extraction and factory-owned PR routing                  |

Proposed new homes: `src/modules/factory/` for domain services, `shared/factory.ts`
for cross-boundary schemas, explicit factory routes/agent modules, and
`web/src/features/factory/` for task UI. Follow the import-layer checker: register
the new domain module without broadly weakening boundaries. Inject dispatch/wake
dependencies from server/agent layers rather than importing the server into stores.

Remove only code made redundant by the narrow presentation/client extraction in
this slice. Do not delete unrelated legacy features or revive the removed PR
Autopilot admission/coordinator abstractions under new names.

## 9. Five stacked implementation PRs

Each PR builds and passes its own checks against its declared parent. Each adds an
inspectable user path. Keep incomplete factory functionality disabled by default;
do not leave enabled buttons backed by placeholders. The manager may split an
oversized PR further, recording the changed stack, without silently dropping scope.

| PR / proposed branch                     | Deliverable                                                                                                                                                                        | Acceptance gate                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — `agent/factory-s1-01-intake`         | Factory config, app records/migration, typed services, manual intake and minimal inbox/detail UI. Draft revisions, pause and exact-version release service/API with no consumer.   | Submit/retry once; restart; retrieve one task and immutable drafts. Prove stale revision/release races and source/repo invariants. Feature disabled retains existing startup behavior.                                                                                                 |
| 2 — `agent/factory-s1-02-planning`       | Bounded triage, durable planner session, read-only repo tools, typed spec proposals/questions, initial chat + rendered draft. App/Flue dispatch reconciliation.                    | A task gets a recommendation and model-authored plan; human replies change a new revision. Restart preserves both; duplicate intent produces no duplicate effective proposal. Inject invalid triage, provider failure and stale tool save. No writer/release/publication capabilities. |
| 3 — `agent/factory-s1-03-shaping`        | Full human shaping workbench: version selection/diff, Markdown edit, section discussion, decisions, version-specific release/withdraw and attention.                               | Compare versions, resolve a decision, race two editors, release vN, revise to vN+1 and see release invalidated. Refresh retains work; existing briefing/chat/PR review routes still work.                                                                                              |
| 4 — `agent/factory-s1-04-github-ingress` | GitHub config/mapping, signed public listener, current issue detail and comment ingestion, source reconciliation, production lifecycle and private/public deployment instructions. | Replay signed duplicates/reordered/closed events and restart mid-processing. Invalid input creates no work. Replies are attributed. Missed updates recover without losing pagination. Built server keeps privileged routes off public ingress.                                         |
| 5 — `agent/factory-s1-05-github-status`  | Opt-in managed status, approved question send, durable effect recovery, writeback health and full slice acceptance exercise. Finish operator documentation and readiness.          | Off means zero writes. Retry ambiguous create with reconciliation; no duplicates/self-trigger loop. Human-edited comment needs attention. Replies cannot release. Complete manual/GitHub shaping-to-queue demo with no coding side effects.                                            |

PR 1 provides the backend release contract; PR 3 provides the final human review
experience. PR 2's model output must not depend on an unbuilt review UI for safety.
PR 4 admits attributed replies without writeback; PR 5 adds outbound effects and
question linkage. No provider credentials are needed for deterministic PR tests.

## 10. Acceptance evidence and verification

Implementers own execution and evidence, including screenshots for applicable UI
changes. Dedicated independent subagents perform static reviews until they return
no findings. The manager then performs the final implementation/product-plan review.
No PR, even a draft, is created before those gates pass. See the handoff for review
mechanics, reasoning levels and screenshot publication requirements.
Use temporary homes/databases, fake provider clients and controlled model responses
for deterministic tests. Test behavior at transaction, restart and authorization
boundaries rather than duplicating private helper implementations.

| Scenario                 | Required observation                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path, both sources | Triage → model proposal → human revision → exact-version release; one durable work item, queue explicitly awaiting executor                                                  |
| Admission/restart        | Retry request/delivery and restart after receipt, before dispatch, and after dispatch before local receipt update; no lost accepted input or repeated effective spec changes |
| Source ordering          | Old events cannot revert latest content or reopen closed tasks; source closure and mapping changes invalidate eligibility                                                    |
| Model boundary           | Bad output, unavailable provider, exhausted budget and stale turn show recoverable state; malicious source text cannot write repo, publish or release                        |
| Human concurrency        | Stale editor text is preserved, stale release fails, unresolved decisions block, spec revision invalidates old release atomically                                            |
| Isolation                | One work item cannot read/update another task's session, artifacts or release through substituted IDs                                                                        |
| Source recovery          | Pagination/truncation, rate limits, auth failure, closed issues and edited/deleted comments are handled without fabricated success                                           |
| External effects         | Consent off, pending writes, create timeout, restart, owned echo, unrelated bot comment and human edit/delete have distinct correct outcomes                                 |
| Public exposure          | Signed ingress succeeds; anonymous dashboard, agent stream, APIs, reports and attachments are unavailable through public routing                                             |
| No coding                | Factory flow creates no coding run/worktree/process/PR and does not dispatch to legacy PR Autopilot                                                                          |

For each PR, run the repository's `npm run check` plus focused integration tests
covering its changed boundaries. Run `npm run verify` for build/runtime wiring and
multiple-surface changes, and on the final stack. Include fresh/existing-home
migration coverage when schema changes and a packaged-server exercise when routing
changes. Use Node 26 as instructed by `AGENTS.md`. Record exact commands, results,
commit SHA, and any unavailable checks; a skipped check is not a pass.

Before slice acceptance, exercise one real model planning conversation and one
authorized GitHub test issue on the deployment target, with a restart. Perform
anonymous exposure probes from outside the private access path. Keep addresses,
credentials and raw environment evidence private; public evidence contains only
redacted outcomes. If deployment access is unavailable, code can be reviewed but
deployment acceptance remains explicitly incomplete.

Add changesets for user-facing package changes under the repository convention;
skip docs-only work. Do not run package version/prerelease commands. Every commit
runs the configured `.githooks/pre-commit` gitleaks scanner, with no bypass flags or
hook overrides. Also inspect staged text for operational addresses: secret scanning
does not guarantee that a deployment hostname will be detected.

## 11. Readiness and intentional deferrals

Local implementation can start with installed dependencies, Node 26, a clean owned
worktree and functioning gitleaks hook. Live SSH, model credentials and a webhook
are not prerequisites for PR 1. See the handoff for the later private setup list.

Factory enablement, admission mapping, triage budget and writeback consent must be
visible through typed configuration/readiness surfaces. Missing config should say
what is missing without displaying credential values. A public bind must not
silently fall back to serving the privileged dashboard.

Slice completion requires all five PR contracts and acceptance evidence, not just
a merged schema or a working webhook. Code completion, review approval, merge and
deployment validation remain separate statuses in the handoff ledger.

The wider proposal already defers executor isolation/lifecycle to slices 2/6 and
OpenCode to slice 4. Do not add empty execution tables or speculative host adapters
now. Carry the released spec/repo/context references forward as the future input
contract, including its captured permissions. The future executor must validate
that contract before consuming the queue.

Record actual deviations, changed PR ordering, narrowed UI scope or deferred checks
in `.plans/DEVIATIONS.md` with reason and follow-up. These documents do not mark any
implementation complete or alter historical completion claims.
