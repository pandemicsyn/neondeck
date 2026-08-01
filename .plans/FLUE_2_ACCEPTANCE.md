# Flue 2 Feature-Parity Acceptance

Status: local runtime and recorded live read-only GitHub slices passed; externally mutating PR-review and Autopilot scenarios pending explicit authorization
Applies to: `flue2`  
Companion plan: [FLUE_2_MIGRATION_PLAN.md](./FLUE_2_MIGRATION_PLAN.md)

Run this against a clean runtime home after the automated completion gates pass.
The migration is not feature-complete until every scenario passes without
weakening the beta behavior, including the existing MCP trust, approval, and
audit boundary.

## Evidence Header

Record these values with the final acceptance result:

- commit SHA
- Node, npm, and Flue versions
- operating system
- clean `NEONDECK_HOME` path
- configured model/provider and authentication mode
- registered test repository
- disposable pull request refs used for review and Autopilot
- start/end timestamps
- screenshots or API responses for failed assertions

## Setup

```sh
eval "$(fnm env)"
fnm use 26.4.0
export NEONDECK_ACCEPTANCE_HOME="$(mktemp -d /tmp/neondeck-flue2-acceptance.XXXXXX)"
export NEONDECK_HOME="$NEONDECK_ACCEPTANCE_HOME"
npm run setup -- --home "$NEONDECK_ACCEPTANCE_HOME"
npm run cli -- --home "$NEONDECK_ACCEPTANCE_HOME" status
npm run dev
```

Configure one real model/provider through the normal onboarding or auth flow.
Register a disposable repository and GitHub identity before the review and
Autopilot scenarios. Do not reuse a production runtime home or a valuable pull
request.

## 1. Display Chat And Sessions

1. Open the dashboard and create a new main session.
2. Send a prompt with a unique token. Confirm the response streams, settles,
   and retains the token in history after a full page reload.
3. Create a second scratch session, switch between both sessions, and verify
   each conversation retains its own history.
4. Start a deliberately long response and abort it. Confirm the conversation
   settles as aborted without corrupting later messages.
5. Run `/repo-status` and one typed configuration or lookup command. Confirm
   chat, dashboard controls, and the corresponding local API expose the same
   result.

Pass conditions:

- create, switch, resume, send, stream, history, and abort all work
- shared local host/origin access control remains enforced on agent and app
  routes
- typed data parts and response metadata render without unsafe assumptions

## 2. MCP Capability Preservation

Add Neondeck's local fixture server to the clean runtime home:

```sh
npm run cli -- --home "$NEONDECK_ACCEPTANCE_HOME" mcp add fixture \
  --command node \
  --arg "$PWD/src/domains/mcp/fixtures/stdio-server.mjs"
npm run cli -- --home "$NEONDECK_ACCEPTANCE_HOME" mcp status fixture
npm run cli -- --home "$NEONDECK_ACCEPTANCE_HOME" mcp tools fixture
```

1. Create a new display session after the fixture catalog loads.
2. Ask Neon to call `mcp__fixture__echo` with a unique value.
3. Confirm the first call requires approval and that the dashboard and
   `mcp approvals` CLI show the same hash-bound pending request.
4. Approve that request, retry with identical arguments, and confirm the tool
   result reaches the conversation.
5. Confirm `mcp audit` records the request, decision, and execution without
   leaking secrets.
6. Disable the server. Confirm a new session cannot call its stale tools.
7. Re-enable it and confirm another new session receives the refreshed catalog.
8. Exercise one denied tool policy and confirm it cannot be overridden by the
   model or by changing arguments after approval.

Pass conditions:

- stdio discovery, schema adaptation, invocation, approval, denial, audit,
  enable/disable, and session-stable tool catalogs match beta behavior
- tool output remains explicitly treated as untrusted external data
- the migration does not bypass Neondeck policy by mounting native Flue MCP
  connections directly

## 3. Morning Briefing

1. Configure a briefing profile with at least one repository/GitHub source and
   one intentionally unavailable source.
2. Run a manual briefing from the dashboard or `POST /api/briefings/run`.
3. Confirm one persisted snapshot and run record are created before model work.
4. Confirm the briefing enters the canonical briefing conversation and renders
   validated structured source health, actions, and failures.
5. Reload the dashboard and verify the exact snapshot remains inspectable.
6. Schedule a near-term occurrence and confirm it uses the same admission path.
7. Replay settlement/reconciliation and confirm no duplicate ready or attention
   notification is created.

Pass conditions:

- manual, scheduled, dashboard, and `/briefing` paths all work
- snapshot grounding is exact and failure-tolerant
- run status settles from submission state without workflow-run inspection

## 4. PR Review

1. Start an initial review for a disposable open PR and record its exact head
   SHA and review attempt id.
2. Confirm the bounded review produces validated findings, report artifacts,
   and handoff data for that exact revision.
3. Reload during execution and verify status remains recoverable and visible.
4. Open the continuing reviewer conversation, ask a follow-up question, reload,
   and verify its history resumes.
5. Advance the PR head and confirm the old reviewer refuses revision-bound
   reads or comments rather than silently following the new head.
6. Exercise timeout/failure and retry paths; confirm only the intended attempt
   settles and no duplicate submission occurs.

Pass conditions:

- initial and continuing review retain read-only exact-head scope
- findings, draft comments, reports, handoff, timeout, and recovery match beta
- no raw Flue workflow-run inspector is required to diagnose the review

## 5. Memory And Learning

1. In a fresh display session, capture the effective SOUL, model, skills, and
   active memory guidance through observable behavior or debug metadata.
2. Add and edit a memory through the typed chat/API surface, then archive and
   restore it. Confirm revision checks and audit rows for every mutation.
3. Change SOUL, memory, model selection, or runtime skills while the first
   session remains active. Confirm that session is marked stale but its prompt
   context does not silently change.
4. Create a new session and confirm it receives the new context snapshot.
5. Exercise learning in `off`, `review`, and `auto` modes. Confirm bounded
   evidence, candidate decisions, auto-apply policy, audit history, skill patch
   application, and unchanged-target restore behavior.
6. Confirm conversation and PR learning cadence advances only after successful
   submission settlement.

Pass conditions:

- user/local/project memory scopes and archive history are preserved
- active context is stable and new context is deliberate
- learning remains proposal-first, bounded, auditable, and restorable

## 6. Autopilot

Use disposable PRs with actionable review feedback. Test each authority mode:

1. `notify-only`: confirm meaningful changes notify without creating a managed
   worktree or starting a mutation turn.
2. `prepare-only`: confirm the owner works only in its managed worktree,
   validates changes, and leaves a local commit without push/response tools.
3. `autofix-with-approval`: confirm watcher-generated turns cannot push. Send a
   direct human approval in the same owner conversation and confirm only that
   approval turn gains guarded delivery tools.
4. `autofix-push-when-safe`: confirm the owner may prepare, validate, commit,
   push, and respond only after current mode, head, destination, credentials,
   and worktree checks pass.
5. Change mode/source state between turns and confirm tool and sandbox
   availability changes at the next turn boundary.
6. Exercise stale head, dirty worktree, wrong destination, missing credentials,
   and concurrent-message cases; each must fail closed.
7. Restart the Node process before and after edit, commit, push, response, and
   settlement boundaries. Confirm accepted work recovers or settles without a
   duplicate external effect.

Pass conditions:

- one stable owner, one managed worktree, one active turn, and one pending
  semantic fingerprint remain the coordination model
- capability ceilings cannot be raised by model-selected arguments
- push/comment recovery reconciles actual GitHub and Git state
- no second workflow/coordinator engine is introduced

## Final Result

Record each scenario as pass or fail with evidence. Any compromise, silently
removed capability, missing MCP behavior, unverified crash boundary, or test
failure leaves the migration incomplete.

## 2026-08-01 Acceptance Evidence

Environment:

- source base: `76f9db9` plus the MCP disabled-catalog fix working tree
- Node `26.4.0`, npm `11.17.0`, Flue `2.0.1`
- macOS `26.6` (`25G72`)
- clean runtime home: `/tmp/neondeck-flue2-acceptance.PsmRZL`
- provider/model: KiloCode with `kilocode/kilo-auto/free`
- registered repository: `neondeck` at the `flue2` checkout
- live read-only PR: `pandemicsyn/neondeck#177`, head
  `23799f218539933a71f062056dc06ed5655e187e`
- run window: approximately 2026-08-01 21:48-22:44 UTC

Live local results:

- **Display conversation: pass.** A new conversation returned the unique token
  `FLUE2_ACCEPTANCE_OK`. After two Node restarts, the same conversation retained
  eight messages, four settled submissions, the acceptance token, and the MCP
  result.
- **Display session isolation and abort: pass.** Main and scratch conversations
  retained disjoint unique tokens. A deliberately long scratch turn accepted a
  durable abort, settled with outcome `aborted`, and the same conversation then
  completed a healthy turn containing `AFTER_ABORT_HEALTHY`. `/repo-status
neondeck` returned the same clean `flue2` repository facts through the local
  API and the model-callable typed Tool.
- **MCP discovery and invocation: pass.** The stdio fixture connected and
  exposed two tools. The first echo call produced a hash-bound approval request.
  Resolving the same approval through the CLI nudged the mounted conversation,
  retried the identical arguments, and returned `FLUE2_MCP_APPROVAL`.
- **MCP policy and audit: pass.** Audit history recorded the initial ask result,
  approval, and successful execution. A newly configured `deny` rule for the
  fixture danger tool was enforced in a fresh session and the tool did not run.
  A second CLI-only approval test for `CLI_NUDGE_CHECK` also settled successfully
  without a nudge/import error.
- **MCP catalog disable and re-enable: pass.** Disabling the fixture through the
  live local API closed the connection and exposed zero tools. A new session
  omitted `mcp__fixture__echo` and used only the deterministic MCP status lookup.
  Re-enabling reconnected both tools; another new session received the refreshed
  echo Tool and reached the normal hash-bound approval gate. A focused registry
  regression test proves existing session snapshots remain frozen and fail
  closed while deliberately disabled catalogs are excluded from new sessions.
- **Restart durability: pass.** Conversation messages, submission settlement,
  and the approved MCP result survived repeated Node process restarts.
- **Morning Briefing: pass.** The manual run
  `briefing:20260801223513:d07e36b0` persisted its exact deterministic snapshot
  before model work, reported the registered repo as healthy and the
  intentionally unauthenticated GitHub review queue as partial, emitted a
  validated `data-briefing` part, and settled `ready`. A due cron occurrence
  created scheduled run `briefing:20260801223639:6d78eb69` through the same
  persistent briefing session. After restart, both exact snapshots/runs remained
  inspectable and each retained exactly one ready notification.
- **Memory and stable context: pass.** Memory
  `985fbc92-00e5-463d-8d32-3699c05fd577` was created, revision-checked,
  edited, archived, and restored through the typed API with complete
  before/after audit rows. The loaded session became stale after the edit but
  continued to answer from its frozen `MEMORY_CONTEXT_AFTER` snapshot; a
  deliberate new session loaded the same memory id and answered from
  `MEMORY_CONTEXT_EDITED`.
- **Learning policy and restore: pass.** Live `off` mode rejected both curation
  and a Neon skill-patch proposal. `review` mode persisted candidate
  `4ba2d183-dc3a-4d28-9ccf-c73d8a37c064` without editing its target; explicit
  approval applied it and the audit-backed restore returned the unchanged
  target to its exact pre-patch content. `auto` mode admitted Neon-authored
  local memory `67d7eb65-ce24-44e8-a495-cd3c3f3bbd01`. Bounded conversation
  learning review `8d06e910-e073-455f-a30c-0df01fd0dd9a` settled `completed`
  from submission `sub_ik_0b3b896bf1dcb3e98ee061da788c19c3` and correctly
  made no unsupported proposals from metadata-only evidence.
- **Packaged runtime: pass.** `npm run smoke:npm-pack` started the packed CLI and
  server from a clean install, reached health, and loaded shipped runtime skills.

Automated feature evidence:

- Initial and continuing PR review and all
  four Autopilot authority modes pass their unit, git, integration, restart,
  stale-head, recovery, and idempotency fixtures in `npm run verify`.
- `npm run smoke:kilo`, `npm run smoke:learning`, `npm run raycast:build`, and
  `npm run raycast:lint` pass on the Phase 11 tree.

Live GitHub read-only evidence:

- **Initial PR review: pass.** Review attempt
  `136f8218-8837-43ce-8ea9-d0e2b39358bd` reviewed PR #177 at the exact recorded
  head, settled submission `sub_01KYZPNSY8E80HDTADYWC5XNJX`, and persisted two
  report artifacts plus five validated local findings. No review or comment was
  submitted to GitHub.
- **Continuing reviewer: pass.** The revision-keyed reviewer conversation
  retained its uid, history, exact head, and `REVIEWER_CONTINUITY_OK` token after
  a Node restart. A conversation addressed with a different head refused the
  revision-bound request rather than silently following it.
- **Autopilot notify-only baseline: pass.** A live watch of PR #177 persisted all
  eight GitHub event-watermark categories and the exact head, reported no source
  changes on refresh, and retained `notify-only`/`watching` state after restart.
  `ownerInstanceId` and `worktreeId` remained null, proving passive observation
  did not start a mutation turn or create a managed worktree.

Remaining PR-review live scenarios:

- The live read-only happy path, continuing reviewer, restart persistence, and
  revision-mismatch refusal above pass. Automated coverage passes for reload
  during execution, timeout/failure retry, and exact-head advancement.
- Advancing a real PR head is an external GitHub mutation and was not authorized.
  The separately addressed mismatched-head reviewer proved the local
  revision-bound refusal but is not represented as a live head-advance pass.

Pending externally mutating acceptance:

- No authorization was supplied to create, push to, comment on, advance, close,
  or otherwise mutate a disposable live PR, nor to send a purpose-built
  disposable PR and Autopilot owner context to the configured model provider.
  Therefore a real PR head advancement plus `prepare-only`,
  `autofix-with-approval`,
  `autofix-push-when-safe`, live head advancement, and external-effect restart
  reconciliation in section 6 remain unrun against GitHub. Their automated
  fixture coverage passes, but this file deliberately does not label those
  externally mutating scenarios as manually passed.
