# Conversational Briefings Plan

Status: completed
Written: 2026-07-11
Completed: 2026-07-11
Related: `.plans/ROADMAP.md` Morning Briefing, Phase 7, Phase 14, and Phase 16

## Purpose

Neondeck's current `/briefing` is a deterministic operational digest. It
collects repo, review queue, watch, job, notification, and hygiene facts; picks
up to three actions with hard-coded ordering; stores a workflow summary; and
renders that structured result in a dedicated dashboard panel.

That implementation does not match the intended product experience. A
briefing should give the user a normal conversation with Neon:

```text
deterministic Neondeck facts
          +
user-authored briefing instructions
          +
the display assistant's complete configured MCP toolset
          |
          v
user-selected display-assistant model
          |
          v
ordinary assistant message in a durable chat session
```

The input facts remain structured and auditable. The assistant's output is not
required to follow a schema, is not parsed back into application state, and is
not reconstructed as a metrics dashboard. The user reads and follows up with
Neon in chat.

## Current State

- `src/modules/commands/handlers/misc.ts` implements `briefingCommand` by
  reading deterministic state and constructing a fixed top-three list.
- `src/workflows/briefing.ts` associates the display assistant with a workflow
  but directly calls `runNeonCommand({ command: '/briefing' })`; it does not
  dispatch a model turn for the scheduled path.
- `src/modules/scheduler/dispatch.ts` invokes that workflow with `{}` for a
  `morning-briefing` job. Schedule `config` is not passed into synthesis.
- `web/src/features/flue-chat/components/session-view.tsx` intercepts slash
  commands and renders their deterministic command result without sending a
  normal message to the display assistant.
- `web/src/plugins/BriefingPanel.tsx` searches for
  `workflow === 'command:briefing'` and parses the stored JSON into repo, PR,
  alert, watch, job, and top-action widgets.
- `src/agents/display-assistant.ts` already exposes
  `mcpAgentToolsSync()` alongside Neondeck tools and actions.
- `src/modules/routines/service.ts` already demonstrates the desired Flue
  primitive split: a scheduler admits work, a continuing display-assistant
  session receives an ordinary input through `dispatch`, and app state tracks
  run admission and settlement without owning the transcript.
- Chat session kind `briefing` already exists in
  `src/modules/sessions/schemas.ts`.

## Product Decisions

### A briefing is a conversation, not a report schema

The model response is a normal display-assistant response. It may use prose,
bullets, headings, links, questions, or whatever presentation best serves the
briefing instructions and current facts.

Neondeck must not:

- require JSON or another output schema;
- parse the response to recover top actions or metrics;
- copy the response into a parallel app-owned report body;
- render a second dashboard-shaped approximation of what Neon said;
- treat output formatting as an application API contract.

The Flue transcript is the canonical generated response. App state stores only
operational metadata such as snapshot id, schedule id, session id, dispatch or
run id, status, and timestamps.

### Deterministic facts remain the grounding layer

Before model dispatch, Neondeck collects a bounded structured snapshot of the
facts it owns. This separates fact acquisition from narrative synthesis and
makes it possible to inspect exactly what local state was given to the model.

The model, rather than hard-coded ordering, decides what deserves emphasis and
which actions to recommend. It must distinguish facts from inference in the
same way the display assistant does elsewhere.

### All configured MCP tools remain exposed

Briefing configuration does not contain a Jira toggle, MCP allowlist, or list
of selected external sources. Every enabled and successfully connected MCP
tool exposed to the display assistant is also available during a briefing.

If the user's instructions reference Jira, Atlassian, Linear, a calendar, or
another configured MCP, the model can choose the relevant tools. Adding a new
MCP should not require modifying the briefing implementation.

Tool exposure does not bypass existing controls:

- OAuth/login state still applies;
- MCP tool approvals and annotations still apply;
- calls remain audited;
- unavailable or approval-blocked sources produce a candid partial briefing;
- the default briefing task is informational and instructs the assistant not
  to mutate external systems;
- user instructions do not override MCP, execution, or application safety
  policy.

The implementation must use the display assistant's normal MCP registry at
dispatch time. It must not take a snapshot of only Jira or maintain a second
briefing-specific MCP adapter layer.

### The user's selected model produces the briefing

The briefing turn is dispatched to `display-assistant`, so it uses the user's
configured display-assistant model, reasoning level, SOUL, stable session
context, memory, runtime skills, Neondeck tools, and configured MCP tools.

The finite workflow orchestrates admission and audit. The continuing agent
owns conversation and model generation.

### Scheduled and manual briefings have conversational destinations

Scheduled morning briefings use a dedicated persistent `kind: briefing`
session linked to the schedule/profile. The session is created inactive and
reused for later occurrences, producing an ongoing briefing conversation.

- A scheduled run never silently replaces the user's active dashboard chat.
- Completion creates a targeted `Morning briefing ready` notification.
- Opening the notification switches the chat surface to the briefing session.
- The user can immediately reply to the assistant message.

Manual `/briefing` runs in the current active display-assistant session. It
should feel like asking Neon a question, not like invoking a data-panel refresh.

If long-lived briefing context becomes undesirable, a later explicit `Start a
fresh briefing conversation` operation can rotate the linked session. Do not
silently rotate or discard transcript context in v1.

## Architecture

### Deterministic briefing snapshot service

Extract fact collection from the current command handler into a bounded,
reusable service under the app's module conventions. The initial snapshot
includes:

- configured repositories;
- assigned/open PR and review queue facts;
- CI/check failures available through current GitHub adapters;
- active watches and release state;
- autopilot queue, prepared diffs, verification failures, and approvals;
- unread notifications;
- scheduler/job state;
- hygiene issues such as stalled prepared diffs and cleanup candidates;
- per-source status, fetch timestamps, truncation, and errors.

The collector does not call external MCP tools. MCP usage belongs to the model
turn because the user's instructions determine which configured external tools
are relevant.

The collector must return partial results when one deterministic provider is
unavailable. A GitHub failure should not prevent Neon from briefing from local
watch, notification, hygiene, and MCP context.

### Snapshot persistence

Persist the exact JSON-safe snapshot before dispatch, using existing workflow
summary/run metadata where that remains queryable and bounded. Add a dedicated
briefing snapshot table only if the existing workflow summary surface cannot
provide stable ids, retention, and session linkage without overloading its
contract.

The persisted operational record needs:

- snapshot id;
- schedule/profile id or manual trigger metadata;
- session id;
- deterministic source statuses and snapshot payload;
- instructions snapshot or instructions hash plus version;
- Flue dispatch/run id;
- queued/completed/failed status and timestamps.

Do not store or parse the assistant response here. The transcript remains
Flue-owned.

### First-class briefing configuration

Add a typed briefing profile over the morning-briefing schedule rather than
depending on the current loose `config` object.

Suggested user-owned values:

```ts
type BriefingProfile = {
  enabled: boolean;
  instructions: string;
  schedule: string;
  timezone: string;
  sessionId: string | null;
};
```

`instructions` is the user's editable task prompt. It is appended beneath the
application's fixed briefing framing and safety guidance; it does not replace
the display assistant's system instructions.

Provide two supported mutation surfaces:

1. A compact dashboard editor for schedule, timezone, enabled state, and
   briefing instructions.
2. A typed agent action so a user can say, for example, `Change my morning
briefing to include Jira sprint blockers and prioritize review requests
from my team.`

Configuration changes must use typed validation and audit. The primary path is
not manual editing of `schedules.json`.

Existing morning-briefing schedules receive default instructions during
read/migration compatibility without requiring immediate file rewrites.

### Flue primitive split

Use a bounded workflow for orchestration and the persistent Agent for the
actual response:

```text
Neondeck scheduler / manual briefing admission
                    |
                    v
         bounded briefing workflow
          1. collect snapshot
          2. persist audit metadata
          3. resolve briefing session
          4. compose agent input
          5. dispatch display-assistant turn
                    |
                    v
      persistent display-assistant session
          - may call configured MCP tools
          - produces ordinary chat response
                    |
                    v
       observation settles app run metadata
          and emits ready/attention notice
```

Reuse or extract the routine admission and observation-reconciliation machinery
instead of building a parallel dispatcher. Relevant reusable behavior includes
session creation, non-active scheduled dispatch, command-event bookkeeping,
run concurrency/duplicate protection, settlement, and targeted notification.

The current `briefing` workflow's direct `runNeonCommand` call is replaced by
this orchestration. Associating an agent with `defineWorkflow` is not treated
as proof that model generation occurred.

### Session policy

For scheduled runs:

- create a `kind: briefing` session titled from the briefing profile;
- keep `activate: false` during background admission;
- link it to a stable schedule/profile id through existing linked task or
  explicit UI metadata;
- store the resolved session id on the profile/run metadata;
- reuse it for future runs;
- publish session events so a currently open briefing session refreshes when a
  new turn completes.

For manual runs:

- use the active display-assistant session;
- preserve normal chat history and streaming behavior;
- attach snapshot/run metadata to a command event or related audit row without
  rendering the deterministic payload as the response.

### Agent input composition

The dispatched input is an internal, ordinary turn with four parts:

1. Trigger and timestamp.
2. The bounded deterministic Neondeck snapshot or an unambiguous snapshot
   reference plus an automatically loaded lookup.
3. The user's saved briefing instructions.
4. Task framing that asks for a normal response, permits relevant configured
   MCP tool use, requires candid partial-source disclosure, and prohibits
   unattended mutation for this informational task.

Conceptually:

```text
Prepare the scheduled morning briefing for 2026-07-11.

Neondeck fact snapshot:
<bounded deterministic facts>

User briefing instructions:
<saved user instructions>

Respond to the user normally in this conversation. Use any configured MCP
tools relevant to their instructions. If a source is unavailable or awaits
approval, explain that naturally and continue with the useful context you do
have. This briefing is informational; do not mutate external systems.
```

There is no output-format clause beyond `respond normally`. The assistant can
choose prose, lists, headings, or questions based on the actual briefing.

The snapshot should usually be embedded directly when it is within a strict
size bound, avoiding a model-visible lookup that could be skipped. Oversized
sections should be compacted deterministically with truncation metadata, not
silently dropped. If snapshot-by-reference is needed, briefing instructions
must provide the display assistant a bounded fact tool and the orchestration
must verify that the reference is resolvable.

### MCP behavior

At agent/session creation and dispatch, verify that `mcpAgentToolsSync()`
contributes the complete currently configured enabled tool catalog. The
briefing layer does not select tools on the model's behalf.

The model decides whether to call a configured MCP based on the user's
instructions and the current conversation. Tests should use a Jira-like MCP
fixture but assert the generic property: any enabled configured MCP tool can be
used, and an unrelated tool need not be called.

If MCP configuration changes make a reused briefing session context stale,
surface the existing stale-session reason and offer explicit session rotation.
Do not silently change tools or system context mid-session contrary to
Neondeck's stable-session rules.

### Manual `/briefing` behavior

The chat UI currently intercepts all slash commands and waits for a deterministic
workflow result. Special-case `/briefing` as conversational admission:

1. create the local command/audit event;
2. collect and persist the snapshot;
3. send the composed request to the current display-assistant session;
4. let the normal Flue chat stream render the assistant response;
5. settle the command/audit event from observation without inserting a second
   synthetic command-result card as the briefing content.

Other commands can retain deterministic rendering. `Ask about this result`
remains useful for those commands but is unnecessary for a briefing that is
already an assistant response.

### Briefing dashboard surface

`BriefingPanel` stops parsing response or snapshot JSON into metrics and top
actions. Chat is the consumption surface.

Either remove the panel from the default dashboard preset or repurpose it as a
small conversation launcher. The recommended retained surface shows only
operational metadata:

- briefing profile name;
- latest run time;
- queued/ready/failed state;
- unread indicator;
- `Open conversation`;
- `Run now` and `Edit instructions` when space permits.

It must not duplicate the assistant message or invent a structured summary of
it. The chat transcript remains canonical.

### Notification integration

Successful completion creates a targeted notification linked to the briefing
session:

> Morning briefing ready
>
> Neon has added today's briefing to your Morning Briefing conversation.

The in-app toast plan opens that session directly. If actual MCP tool activity
is available from Flue observations/audit, notification detail may name sources
used. It must not claim Jira or another source was consulted based only on the
saved instructions.

A failed dispatch or model turn creates an attention notification linked to
the run/session inspection surface. Partial deterministic or MCP sources do not
make the entire briefing fail when the assistant still completed a candid
response.

## Delivery Plan

### Phase 1 — Snapshot extraction and compatibility

- Extract the current deterministic collectors into a reusable briefing
  snapshot service.
- Add autopilot/approval and source-status facts missing from the current
  digest.
- Remove hard-coded final prioritization from the collector.
- Keep the old deterministic command result temporarily backed by the new
  snapshot so existing tests/API callers remain functional during migration.
- Add partial-provider and bounded-size tests.

### Phase 2 — Briefing profile and typed actions

- Define typed profile/schedule configuration and defaults.
- Add read/update/run-now actions and local API routes using existing config
  mutation conventions.
- Add dashboard editing for schedule, timezone, enabled state, and free-form
  instructions.
- Preserve existing morning-briefing schedules through compatibility parsing.

### Phase 3 — Conversational scheduled dispatch

- Extract reusable session dispatch/reconciliation from Routines where needed.
- Create/reuse the non-active `kind: briefing` session.
- Persist snapshot and admission metadata.
- Dispatch the composed turn to `display-assistant`.
- Reconcile Flue observations into run status without parsing assistant prose.
- Emit targeted ready/attention notifications.

### Phase 4 — Complete MCP exposure

- Verify the briefing agent path receives the display assistant's full enabled
  MCP tool catalog.
- Add generic fake-MCP tests plus a Jira-like fixture demonstrating that saved
  instructions can cause a tool call.
- Cover connected, needs-login, approval-required, denied, failed, and
  unrelated-tool cases.
- Confirm tool calls are audited and informational briefing instructions do
  not auto-approve mutations.

### Phase 5 — Manual chat behavior

- Change `/briefing` in the dashboard chat path from deterministic rendering
  to conversational admission in the active session.
- Ensure the resulting assistant message streams and persists like every other
  normal chat response.
- Keep audit/snapshot links accessible without showing a parallel briefing
  result card.

### Phase 6 — Briefing panel transition

- Replace metrics/top-action parsing with the compact conversation launcher,
  or remove the panel from the default preset if the launcher does not earn
  its display space.
- Link run-now, open-session, and edit-instructions actions.
- Preserve historical workflow summaries as audit records; do not replay them
  into chat or attempt to convert them into model prose.

### Phase 7 — Documentation and cleanup

- Document the difference between deterministic grounding, model synthesis,
  and optional MCP enrichment.
- Explain that every configured MCP is available but only relevant tools are
  expected to be called.
- Document partial-source and approval behavior.
- Remove the legacy deterministic-only scheduled briefing path after migration
  coverage proves no callers remain.

## Verification

- Unit tests for deterministic snapshot content, partial failures, truncation,
  and persistence.
- Scheduler test proving a scheduled job dispatches a real
  `display-assistant` turn to a `kind: briefing` session.
- Test proving scheduled admission does not switch the active dashboard chat.
- Test proving later scheduled runs reuse the linked briefing conversation.
- Test proving the configured display-assistant model and reasoning level are
  used rather than a hard-coded utility model.
- Test proving all enabled configured MCP tools are exposed without a
  briefing-specific allowlist.
- Jira-like MCP fixture proving matching instructions can trigger a read call.
- Approval/login failure tests proving Neon produces a useful partial response
  and identifies the unavailable source.
- Manual `/briefing` integration test proving the output is a normal Flue chat
  assistant message rather than a deterministic result card.
- Observation test proving run completion is settled without parsing message
  prose.
- Toast/navigation test proving `Morning briefing ready` opens the correct
  session.
- Regression test proving the Briefing panel never parses assistant response
  content into application state.

## Acceptance Criteria

- A scheduled morning briefing produces an ordinary assistant message from the
  user's selected display-assistant model.
- The message appears in a durable `kind: briefing` conversation and supports
  immediate user follow-up.
- Scheduled runs do not hijack the currently active conversation.
- Manual `/briefing` responds normally in the current conversation.
- The exact deterministic local snapshot remains inspectable and separate from
  model prose.
- User-authored instructions control the requested emphasis and external
  context.
- Every enabled, connected MCP configured for the display assistant is
  available during briefing generation without per-briefing integration code.
- MCP auth and approval failures produce honest partial briefings rather than
  fabricated facts or total failure.
- No structured output is required from the model.
- Assistant prose is never parsed to drive application state, metrics, or
  recovery actions.
- The dedicated Briefing panel is no longer the primary reading surface and
  does not duplicate the chat response.

## Non-Goals

- Giving the model authority to invent or mutate deterministic Neondeck state.
- Creating a Jira-specific briefing integration or MCP selection UI.
- Requiring the user to select which configured MCP tools a briefing may see.
- Parsing generated prose into top-action records, notifications, or metrics.
- Replacing the display assistant with a separate briefing persona or utility
  model.
- Automatically switching the user's active chat when a scheduled briefing
  completes.
- Silently changing stable session context after MCP, SOUL, memory, model, or
  skill configuration changes.

## Open Implementation Questions

- Whether existing `workflow_summaries` can carry bounded snapshot/audit data
  cleanly or whether briefing snapshots need a dedicated table. Prefer reuse
  until retention or query requirements prove otherwise.
- Whether the compact Briefing conversation launcher earns a default dashboard
  slot after toast-to-session navigation exists. Chat remains canonical either
  way.
- Whether a later explicit profile option should support one fresh session per
  occurrence. The initial behavior is a persistent session per briefing
  profile because it best supports conversational follow-up.
