# Flue 2 Feature-Parity Acceptance

Status: captured; final execution pending  
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
- local authentication remains enforced on agent and app routes
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
