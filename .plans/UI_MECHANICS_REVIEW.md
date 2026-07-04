# UI Mechanics Review — Broken and Half-Built Mechanics

Date: 2026-07-04
Scope: `web/src` dashboard plugins, flue-chat feature, session-reference flow, and the
server-side session/agent plumbing they depend on (`src/modules/sessions`,
`src/agents/display-assistant.ts`).

The headline question that prompted this review — *"does the session button in the
GitHub PR view actually seed the agent's context with useful info?"* — has a clear
answer: **no, not today.** It stores useful metadata in Neondeck's session index, but
nothing carries that metadata into the agent's prompt or transcript. Details in §1.

---

## Priority 0 — mechanics that look like they work but don't

### 1. Session reference buttons don't seed agent context

Where: `web/src/components/SessionReferenceButton.tsx`, used by
`GitHubPrList.tsx`, `ActiveWatches.tsx`, `AutopilotPanel.tsx` (queue, prepared,
activity rows), `BriefingPanel.tsx`.

What happens today when you click `session` on a PR row:

1. The client creates (or reuses) a `chat_sessions` metadata row with a good
   `title`, `summary` (repo, PR number, check status, relation), `uiMetadata`
   (source, url, state), and `linkedRepoId`/`linkedTaskId`
   (`src/modules/sessions/service.ts:39`).
2. The surface's active-session pointer switches to it. The chat panel picks that
   up via SSE and shows an **empty transcript** titled "PR owner/repo#123".
3. The user types "what's going on with this?" —
   `FlueChatSessionView.submit` calls `agent.sendMessage(message)`
   (`session-view.tsx:151`) with **only the raw text**.
4. The Flue agent's prompt is assembled statically in
   `src/agents/display-assistant.ts` from SOUL, memory snapshot, and MCP
   instructions. Nothing reads the session row's `summary`, `uiMetadata`, or
   linked ids. The agent starts blind.

The stored metadata *is* reachable — `neondeck_session_status` returns the full
active `ChatSessionRecord` including summary and links — but neither the agent
instructions nor `src/skills/neondeck/SKILL.md` tells the agent to consult the
active session's linked context before answering, so in practice it never does.

Plan (pick one primary mechanism, plus the UI affordance):

- **a. Server-side context injection (preferred).** When the first message of a
  linked session arrives (or on session switch), prepend a synthetic context
  block: linked kind, repo/PR/watch/task ids, URL, and the stored summary. This
  is deterministic, costs no extra tool round-trip, and works for every entry
  point that already passes `summary`/`uiMetadata`. Natural home: the agent
  route/middleware in `src/agents/display-assistant.ts` (route handler currently
  a no-op passthrough at line 44) or the message-send path, keyed off
  `contextLoadedAt`-style bookkeeping so it fires once per session.
- **b. Instruction fallback.** Add to the display-assistant instructions and the
  neondeck skill: "When the active session has linked repo/watch/task metadata,
  call `neondeck_session_status` and treat the linked entity as the default
  subject of the conversation." Cheaper to ship, but probabilistic.
- **c. UI affordance either way.** Show the linked context in the chat surface:
  a chip row under the chat header ("linked: pandemicsyn/neondeck#123 · open ↗")
  built from `activeRecord.linkedTaskId`/`uiMetadata`, and seed the input
  placeholder from the summary ("Ask about PR #123…"). Right now the only hint
  is the session title in a 22ch dropdown.

Acceptance: click `session` on a PR row, type "summarize the state of this PR",
and the agent answers about *that* PR without the user naming it.

### 2. The chat "Ref" button produces a reference no one receives

Where: `web/src/features/flue-chat/plugin.tsx:127-149`, server
`src/modules/sessions/references.ts`.

`referenceChatSession` refreshes the summary, writes an audit row, and returns a
reference object whose own message says "Prepared cross-session reference…" —
but the result is only rendered as a dashboard banner ("Reference ready · id ·
summary"). It is never delivered to the agent, so the mechanic is a dead end:
the user sees a summary *they* could read, and the agent that was supposed to
consume it never does. The banner also never dismisses (`referenceMutation.data`
persists until the component unmounts).

Plan: decide what "Ref" means and finish it.
- If it means "give the *current* conversation this session's context": compose
  the returned summary into the next `sendMessage` (visible, editable preamble),
  or have the server inject it like §1a.
- If it's agent-only tooling (the agent already has
  `neondeck_session_reference`), remove the button from the header.
- Either way: make the banner dismissible / auto-expire.

### 3. Autopilot approvals are displayed where they can't be resolved

Where: `web/src/plugins/AutopilotPanel.tsx:415-431` (`ApprovalRow`),
`src/modules/autopilot/state.ts:123-133`.

The Autopilot panel's "Approvals" section renders pending approvals —
execution approvals flagged as autopilot **and** prepared-diff push approvals —
as read-only rows. There are no approve/deny controls:

- Execution approvals *are* resolvable from the dashboard, but only via
  `ExecutionApprovalRow` buried ~10 sections deep in the RuntimeOverview scroll
  (`setup-rows.tsx:259`). Same entity, two panels, only one actionable.
- Prepared-diff approvals have **no web API at all** — `web/src/api/` has
  `resolveExecutionApproval`, `resolveMcpApproval`, `decideLearningCandidate`,
  but nothing for prepared-diff push approval. The only path is chat/CLI.

For an autopilot whose global mode is literally "approval required", the
approve/deny loop is the core mechanic and the dashboard can't complete it.

Plan:
- Add approve/deny actions to `ApprovalRow` in the Autopilot panel; reuse
  `resolveExecutionApproval` for execution-backed rows.
- Add a `/api/autopilot/approvals/:id/resolve` route + client function for
  prepared-diff approvals (dispatching to the existing prepared-diff approval
  service), with `approverSurface: 'dashboard'` audit parity.
- Consider a "needs attention" rollup (pending approvals + unread notifications
  + failed checks) surfaced in the statusline or a compact banner, so approval
  requests don't rely on the user scrolling the runtime panel.

### 4. Slash commands bypass the agent and evaporate

Where: `web/src/features/flue-chat/components/session-view.tsx:128-141, 162-176`.

Any input starting with `/` is routed to `flue.workflows.invoke('command-run')`
and rendered in `CommandResultSummary` — a single block that is overwritten by
the next command and lost on tab switch/remount/reload (it's component state;
the transcript records nothing). Consequences:

- The agent instruction "when a user sends a slash command … call
  `neondeck_command_run`" is dead code on the dashboard: the UI intercepts every
  `/` message before the agent sees it.
- There is no durable record in the conversation that a command ran, so a
  follow-up question ("why did that fail?") lands in a transcript that doesn't
  contain the command or its result. The agent *can* find it via
  `neondeck_workflow_summaries_lookup`, but only if it thinks to look.

Plan:
- Keep the fast deterministic path, but persist it: record command invocations
  and results as transcript entries (or a session-scoped command log rendered
  inline in message order rather than a single replaceable block).
- Add an "ask Neon about this" affordance on a command result that sends a
  message referencing the workflow summary id, closing the loop with the
  existing `neondeck_workflow_summaries_lookup` guidance.

---

## Priority 1 — misleading or unfinished surfaces

### 5. Fake/hardcoded status indicators

- `HostMetrics.tsx:74` renders `v0.4.1` while `package.json` says `1.0.0` —
  hardcoded string, will always drift. Inject the real version at build time
  (`import.meta.env` / define).
- `HostMetrics.tsx:107-110` renders a pulsing `flue:online` dot that is static
  text — it says "online" even when the backend is down (at which point the
  metrics query itself errors, but the plugin shows EmptyState then; the deeper
  issue is nothing checks Flue). Wire it to `runtimeStatus.ok` /
  `status.service` or remove it.
- `flue-chat/plugin.tsx:194` header reads `FLUE AGENT · triage.ts` — a
  decorative fake filename. Replace with the agent name from config or drop.

### 6. GitHub PR list timestamps are wrong under an hour

`GitHubPrList.tsx:179-184`: `Math.max(1, Math.round(delta / 3_600_000))` means a
PR updated 2 minutes ago displays `1h`. Every other panel has minute-resolution
`relativeTime`. Fix the floor, and see §12 about consolidating the five
divergent copies of this helper.

### 7. Watches panel is read-only

`ActiveWatches.tsx` + `web/src/api/watches.ts` (GET only). You can open the PR
or open a linked session, but you cannot pause, stop, or delete a watch, and the
GitHub PR list has no "watch this PR" affordance even though the `watch-pr`
workflow exists. Plan:
- `watch` button on PR rows → invoke the existing `watch-pr` workflow.
- stop/pause control on watch rows (with the existing confirmation policy).
- Show `lastCheckedAt`/next-poll info on watch rows; currently there is no
  freshness signal at all.
- `statusClass` treats `closed` like `attention-needed` (accent/alarm); a
  completed watch should read as terminal/neutral, not alarming.

### 8. Session-linking inconsistencies (dedupe correctness)

- Kind mismatch: PR rows create `kind="repo"` sessions with
  `linkedTaskId="github-pr:…"`; autopilot rows use `kind="task"`; watches
  `kind="watch"`. Dedupe (`matchesLinkedSession`, server
  `findLinkedChatSession`) requires kind equality, so the same PR reached from
  different panels can spawn parallel sessions with different kinds. Pick one
  convention (PR sessions are tasks) and normalize.
- Duplicate dedupe logic: `SessionReferenceButton.findExistingLinkedSession`
  re-implements (against a possibly stale react-query cache) what
  `createChatSession` already does server-side in a transaction
  (`service.ts:82-98`). The client pre-check can be deleted; the server response
  already reports reuse and handles archived restore.
- Unregistered repos silently degrade: `repoIds.get(item.repo) ?? null` drops
  the repo link with no signal. Dim or badge PRs whose repo isn't in the
  registry, and/or offer "add repo".

### 9. No navigation/confirmation after opening a session

Clicking `session` switches the active session (SSE + invalidation update the
chat panel), but nothing focuses or highlights the chat region. On a grid
layout the user gets no confirmation beyond a 300ms "opening" label; if the
chat region's tab strip is on a different tab, nothing visibly changes at all.
Plan: dispatch a lightweight `focus-chat` app event on success — the chat
region switches its active tab to `flue-chat` and flashes the header; in column
arrangement, scroll the agent surface into view.

---

## Priority 2 — polish, consistency, structural cleanups

### 10. Native `window.prompt` / `window.confirm` dialogs

`flue-chat/plugin.tsx:175` (rename session) and `AutopilotPanel.tsx:404`
(cleanup worktree confirm). Native dialogs are jarring on a kiosk-style
companion display, can't be styled/themed, and are blocked in some embedded
webviews. Replace with a small inline edit / inline confirm row, consistent
with the existing bordered-row visual language.

### 11. Invisible loading skeleton

`GitHubPrList.tsx:166-177`: `PrSkeleton` draws `bg-soft` bars inside a
`bg-soft` container — the bars are invisible; the skeleton reads as empty
boxes. Use `bg-line` (as HostMetrics' skeleton does) and consider a shimmer.

### 12. Five divergent `relativeTime` implementations (plus duplicated `Metric`/`MiniEmpty`/status-class helpers)

`GitHubPrList`, `BriefingPanel`, `LearningOperatorPanel`,
`WorkflowObservabilityPanel`, `SubagentSummary`, `runtime-overview/lib/format`
each ship their own copy with different floors, suffixes (`5m` vs `5m ago`),
and bucket boundaries (48h vs 24h). Consolidate into `web/src/lib/format.ts`
with one behavior; same for the repeated `MiniEmpty`, `Metric`, and
status-color helpers.

### 13. `EmptyState` lives in `App.tsx` → circular imports

Plugins import `EmptyState` from `../App`, while `App.tsx` imports the plugin
registry, which imports the plugins. Vite tolerates the cycle today, but it's
fragile (HMR anomalies, import-order sensitivity). Move `EmptyState` (and
`BootState`) into `components/ui.tsx`.

### 14. `theme: "system"` doesn't track OS theme changes

`App.tsx:449-454` evaluates `matchMedia('(prefers-color-scheme: dark)')` once
per config change. A companion display that runs for days won't follow the OS
day/night switch. Add a `change` listener on the media query while
`config.theme === 'system'`.

### 15. Subagent delegation detection is a substring heuristic

`SubagentSummary.tsx:177-198` filters workflow events by lowercase substring
match ("subagent", "delegat", role names) over name+message+JSON. This will
both miss structured delegations and false-positive on any message mentioning
the word. Plan: emit a structured event (e.g. `operationKind: 'subagent'`,
`name: <role>`) from the runtime and filter on it; keep the heuristic only as
fallback.

### 16. Silent zero-fill in Briefing panel

`BriefingPanel.readBriefing` coerces any schema drift to `0`/empty via
`readNumber`/`readArray`, so a malformed briefing renders as a confident
"0 repos, 0 PRs, 0 alerts" instead of an error. Distinguish "field missing"
(render `—` or a partial-data note) from a real zero.

### 17. Touch ergonomics

Nearly all row actions (`session`, `open`, `read`, `resolve`, approval buttons)
are `text-[10px]` with `px-1.5 py-0.5` padding — roughly 20×18px targets on a
display class (sensor panel / companion touchscreen) where 40px+ is the norm.
The density system (`deck-density-*`) already scales text; extend it to scale
interactive hit areas, or add invisible padding (`::after` expansion) on
touch-capable displays.

### 18. Canonical-history refresh failures are silent

`session-view.tsx:104-114`: if `flue.agents.history()` rejects, the catch just
clears the pending flag — the user keeps seeing optimistic messages with no
hint the canonical transcript failed to load. Surface a small inline notice
with a retry.

---

## Suggested sequencing

| Phase | Items | Rationale |
|-------|-------|-----------|
| 1 | §1 (context seeding) + §1c chip, §6 | The flagship mechanic every panel already feeds; timestamp fix is trivial and adjacent. |
| 2 | §3 (approvals), §4 (command persistence) | Completes the two operator loops the dashboard currently drops on the floor. |
| 3 | §2, §7, §8, §9 | Finish or remove the half-built affordances around sessions and watches. |
| 4 | §5, §10, §11, §14 | Honesty/polish pass: no fake status, no native dialogs, working skeletons, live theme. |
| 5 | §12, §13, §15–§18 | Consolidation and structural cleanups; best done after phases 1–3 settle the shared helpers they'd touch. |

Each phase is independently shippable; none require schema migrations except
§3's prepared-diff approval route (API-only) and §1a if `contextLoadedAt`
bookkeeping needs a column (the field already exists on `chat_sessions`).
