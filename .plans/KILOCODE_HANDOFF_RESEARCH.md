# KiloCode Handoff Research

Neondeck should be able to delegate large or long-running implementation work to
KiloCode while keeping Neon as the supervising assistant. Kilo should be treated
as a tool in Neondeck's toolbox: useful for substantial autonomous work, but
still bounded by Neondeck's repo registry, worktree isolation, execution policy,
audit trail, and push-back rules.

## Research Scope

Source inspected:

- `~/projects/kilocode/packages/opencode/src/cli/cmd/run.ts`
- `~/projects/kilocode/packages/opencode/src/cli/cmd/acp.ts`
- `~/projects/kilocode/packages/opencode/src/cli/cmd/session.ts`
- `~/projects/kilocode/packages/opencode/src/kilocode/cli/run-auto.ts`
- `~/projects/kilocode/packages/sdk/js/src/v2/server.ts`
- `~/projects/kilocode/packages/sdk/js/src/v2/client.ts`
- `~/projects/kilocode/packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `~/projects/kilocode/packages/opencode/src/acp/README.md`

## Findings

### Kilo Supports ACP

Kilo has an ACP command:

```sh
kilo acp --cwd /path/to/project
```

The implementation starts an internal Kilo server, creates a Kilo SDK client,
and wires `AgentSideConnection` over newline-delimited JSON on stdin/stdout.
This is useful for protocol compatibility, but it is not the best first
Neondeck integration because Neondeck needs Kilo-specific task state: session
ids, event streams, aborts, child task sessions, diffs, and push-back context.

ACP should remain a later adapter option, especially if we want Neondeck to talk
to multiple ACP-compatible harnesses through the same abstraction.

### `kilo run` Is A Practical MVP

`kilo run` supports non-interactive execution. It creates or resumes a session,
sends a prompt, streams progress, and exits when the session becomes idle.

Relevant options:

```sh
kilo run "prompt" \
  --dir /path/to/worktree \
  --title "neondeck: org/repo#123 review feedback" \
  --format json \
  --auto \
  --model provider/model \
  --agent agent-name
```

Important behavior from source:

- `--dir` changes the Kilo working directory when not attached to a server.
- `--format json` emits JSON lines for events.
- Each JSON event includes `sessionID`, so Neondeck can capture the created Kilo
  session as soon as the first event arrives.
- Non-interactive mode subscribes to Kilo events, sends the prompt or command,
  and exits when the root session returns to idle.
- `--session` and `--continue` can resume existing sessions.
- `--fork` can fork before continuing.
- `--command` can run Kilo slash-command style commands.
- `--auto` auto-approves Kilo permissions for autonomous/pipeline use.

This path is good enough for an initial handoff runner because it does not
require Neondeck to depend on Kilo internals beyond the CLI contract and JSON
event format.

### `--auto` Needs Neondeck Policy Around It

Kilo's `--auto` mode tracks the root session and child `task` sessions, then
auto-approves permissions for those sessions. That is useful for delegated
background work, but it should not become Neondeck's safety boundary.

Neondeck should only use Kilo auto mode when all of these are true:

- the target is a declared repo or Neondeck-managed worktree
- the worktree is isolated from the user's primary checkout
- the handoff was allowed by Neondeck autopilot policy
- the workflow records task state and Kilo session ids
- Neondeck captures the final diff before any push-back
- checks and push actions still go through Neondeck policy

For stricter repos, Neondeck should ask Kilo to produce a proposed patch or
limited diff, then apply changes through Neondeck repo-edit actions.

### Kilo Session Listing Is A Fallback

Kilo has:

```sh
kilo session list --format json
kilo session list --format json --all
kilo session list --format json --all --search "title"
```

The JSON output includes session id, title, timestamps, project id, directory,
and, for global listings, project metadata. This is a useful recovery path if a
Neondeck task starts but fails to parse a `sessionID` from the event stream.

### Kilo Sessions Are Queryable Through The SDK

The generated Kilo SDK exposes the session APIs Neondeck needs for normal
operation:

- `session.list` with directory, roots, search, and limit parameters.
- `session.get` for session metadata.
- `session.messages` for transcript/message pages.
- `session.children` for subagent or task-child sessions.
- `session.todo` for task state.
- `session.diff` for resulting file changes.
- `session.status` for active session state.

Neondeck should prefer these APIs whenever it manages or can attach to a Kilo
server. They are safer than direct disk reads because they use Kilo's current
schema and directory routing.

### Disk Storage Is A Last-Resort Compatibility Path

Kilo's current source uses a SQLite database under Kilo's XDG data path,
normally with a database filename such as `kilo.db`, while older storage paths
and some package instructions still describe JSON blobs under
`<kilo-data>/storage/`.

Neondeck should not teach Neon to read these paths directly. If direct disk
inspection is needed, implement it as a typed, read-only adapter behind Flue
actions:

1. Resolve Kilo data locations using Kilo-compatible environment handling,
   including `KILO_DB` where applicable.
2. Prefer SQLite reads from the current `session`, `message`, `part`, `todo`,
   and related tables.
3. Fall back to legacy JSON only when the database is absent or unreadable.
4. Return a normalized, redacted session view.
5. Record that disk fallback was used, because direct storage shape can change.

The fallback should be used for recovery, troubleshooting, and historical
sessions when `kilo serve` or CLI APIs are unavailable. It should not be the
primary integration path.

### Managed Kilo Server Plus SDK Is The Better End-State

The Kilo SDK can spawn and talk to a headless server:

- `createKiloServer()` spawns `kilo serve`.
- `createKiloClient()` talks to the server and can scope requests to a
  directory via `x-kilo-directory`.
- SDK APIs include event subscription, session create/get/fork/children,
  `promptAsync`, `command`, `shell`, `abort`, `summarize`, messages, todos, and
  diff endpoints.

For long-running Neondeck autonomy, this is cleaner than raw CLI spawning:

1. Neondeck starts or reuses a managed local Kilo server.
2. Neondeck creates a Kilo session in a specific worktree.
3. Neondeck calls `session.promptAsync`.
4. Neondeck subscribes to events and persists them.
5. Neondeck can abort the session if the user cancels or policy changes.
6. Neondeck can query session messages, children, todos, and diff summaries.

This should be the target architecture once the first CLI runner proves the
handoff flow.

## Recommended Neondeck Model

### Concept

Kilo handoff is a delegated worker lane, not a replacement for Neon.

Neon remains responsible for:

- deciding whether a Kilo handoff is appropriate
- choosing a declared repo/worktree
- framing the task with constraints
- tracking the Kilo session id
- inspecting the final diff
- running checks through Neondeck policy
- asking for approval or pushing when policy allows
- explaining the result to the user

Kilo is responsible for:

- doing the large implementation/research/fix loop
- editing inside the assigned worktree
- using its own tools and subagents
- producing a final summary

### Flue Primitive Mapping

Use Flue primitives deliberately:

- Actions: deterministic Kilo operations such as start task, abort task, search
  sessions, read session metadata/messages/todos/children/diff, and inspect
  final git state.
- Workflows: bounded jobs such as `handoff_to_kilo`,
  `summarize_kilo_session`, `review_kilo_result`, `verify_kilo_result`, and
  `promote_kilo_result`.
- Skills: runtime guidance that teaches Neon when Kilo handoff is appropriate,
  how to interpret Kilo session summaries, and why it should call Kilo actions
  instead of reading Kilo storage directly.
- Schedules: recurring maintenance or watch-triggered Kilo handoffs should
  enqueue workflows, not run prompt-only background loops.
- Routing: expose local APIs for dashboard/TUI task state, session search,
  transcript pages, summaries, and approvals over the same backend event/API
  surface.

### Runtime State

Add Kilo task tables to `data/neondeck.db`.

Suggested tables:

```text
kilo_task_runs
  id TEXT PRIMARY KEY
  source TEXT
  source_id TEXT
  workflow_run_id TEXT
  repo_id TEXT
  worktree_id TEXT
  cwd TEXT NOT NULL
  title TEXT NOT NULL
  prompt_preview TEXT NOT NULL
  mode TEXT NOT NULL
  status TEXT NOT NULL
  kilo_session_id TEXT
  child_session_ids_json TEXT
  process_id INTEGER
  command_json TEXT NOT NULL
  model TEXT
  agent TEXT
  started_at TEXT
  ended_at TEXT
  exit_code INTEGER
  stdout_preview TEXT
  stderr_preview TEXT
  error TEXT
  diff_summary_json TEXT
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

kilo_task_events
  id INTEGER PRIMARY KEY AUTOINCREMENT
  task_id TEXT NOT NULL
  kilo_session_id TEXT
  event_type TEXT NOT NULL
  event_json TEXT NOT NULL
  created_at TEXT NOT NULL
```

Useful task statuses:

```text
queued
starting
running
idle
completed
failed
cancelled
blocked
needs-review
ready-to-verify
ready-to-push
```

### Typed Actions

Add Flue actions for Kilo handoff management:

- `neondeck_kilo_task_start`
- `neondeck_kilo_task_status`
- `neondeck_kilo_task_events`
- `neondeck_kilo_task_abort`
- `neondeck_kilo_task_sessions`
- `neondeck_kilo_task_diff`
- `neondeck_kilo_sessions_search`
- `neondeck_kilo_session_read`
- `neondeck_kilo_session_messages`
- `neondeck_kilo_session_children`
- `neondeck_kilo_session_todos`
- `neondeck_kilo_session_diff`

The start action should require:

- repo id or worktree id
- task title
- task prompt
- handoff mode, such as `draft-fix`, `implementation`, `research`, or
  `review-feedback-fix`
- whether Kilo may edit directly or must propose a patch
- optional Kilo model/agent
- optional source workflow/watch id

The action should validate that `cwd` is under a declared repo/worktree root.
Neondeck should never prompt for approval to read/edit inside declared
workspaces, but the Kilo handoff itself is still an autonomous agent execution
and should be governed by repo/autopilot policy.

Session search/read actions should be deterministic and schema-backed:

- Search by linked Neondeck task id, Kilo session id, title query, repo,
  worktree path, or time window.
- Prefer managed SDK calls.
- Fall back to CLI `kilo session list --format json` when no server is managed.
- Fall back to direct disk reads only through an internal read-only adapter.
- Return bounded, redacted transcript snippets by default.
- Require explicit input flags for larger transcript windows, tool outputs, or
  diffs.
- Persist an audit event whenever a Kilo session is read for context.

### First Workflow

Add a `handoff_to_kilo` workflow:

1. Resolve the repo or PR worktree.
2. Acquire the worktree lock.
3. Build a constrained task prompt with repo, branch, PR, checks, limits, and
   expected output.
4. Start Kilo in that worktree.
5. Persist the Kilo task id and Kilo session id.
6. Stream/persist Kilo events.
7. On completion, read git status and diff summary.
8. Run configured verification checks through Neondeck execution policy when
   applicable.
9. Mark the task as `needs-review`, `ready-to-push`, `completed`, or `failed`.
10. Release the worktree lock.

This workflow can later be used by:

- `fix_pr_review_feedback`
- `fix_pr_ci_failure`
- manually requested "take this larger task" chat commands
- scheduled repo maintenance

Add a companion `summarize_kilo_session` workflow:

1. Resolve the target Kilo session by Neondeck task id, Kilo session id, or
   search query.
2. Read metadata, messages, todos, children, and optional diff through Kilo
   session actions.
3. Emit a bounded structured summary with what was attempted, what changed,
   current blockers, and recommended next steps.
4. Store the summary in Neondeck workflow summaries and link it back to the Kilo
   task/session record.

This lets Neon answer questions like "what happened in that Kilo run?" without
requiring raw transcript scraping in prompt context.

### CLI MVP Command Shape

For the initial runner:

```sh
kilo run "$PROMPT" \
  --dir "$WORKTREE_PATH" \
  --title "$TITLE" \
  --format json \
  --auto
```

Add `--model` and `--agent` only when configured.

Use `spawn`, not `execFile`, because the task can be long-running and streaming.
Parse stdout as JSON lines. Every event that includes `sessionID` should update
the task record if the stored session id is missing.

Abort behavior:

- send SIGTERM to the child process first
- mark the Neondeck task `cancelled`
- if a managed Kilo server is available later, also call `session.abort`

### SDK End-State

Once the CLI path works, add a managed server mode:

```text
Neondeck process
  Kilo server supervisor
    kilo serve
  Kilo client
    session.create
    session.promptAsync
    event.subscribe
    session.abort
    session.diff/messages/children
```

Benefits:

- no stdout JSON parsing as the primary event source
- reliable async prompting
- reliable aborts
- direct access to session diff/message/todo/children APIs
- better dashboard/TUI reattach behavior

Keep CLI mode as a fallback for users who do not want an SDK dependency or if
the SDK package is not available in the installed environment.

### ACP Later

ACP should be tracked as a future compatibility path:

- useful for generic harness handoff
- useful if Neondeck eventually wants an ACP client abstraction
- less useful for the first Kilo integration because Kilo-specific session and
  diff APIs are more directly valuable

## Dashboard And Future TUI Needs

Expose Kilo tasks through the same backend event/API surface used by the web UI
and future OpenTUI client.

Needed views:

- active Kilo tasks
- task status, title, repo, worktree, age, and current phase
- Kilo session id and child session ids
- event stream preview
- final summary
- changed files and diff summary
- verification checks
- pending review/push approvals
- abort/retry/open-session actions
- session search by title, repo, worktree, session id, or Neondeck task id
- compact session transcript view with pagination
- linked child sessions and todos

## Safety Notes

- Kilo should only edit in declared repo/worktree roots.
- Kilo should normally run in Neondeck-managed worktrees, not primary checkouts.
- Direct edits by Kilo must be followed by Neondeck diff capture.
- Direct push-back must remain a Neondeck workflow decision, not a Kilo default.
- High-risk files should require explicit approval even if Kilo completes
  successfully.
- Neondeck should record enough task events that the user can understand what
  happened after returning to a long-running task.
- Kilo session transcripts may contain secrets, prompts, tool outputs, and file
  contents. Default session-read actions should return bounded summaries and
  redacted snippets, not unbounded raw transcript dumps.
- If direct disk fallback is used, it must be read-only and audited.

## Open Questions

- Should the first implementation be CLI JSON only, or should we go directly to
  managed `kilo serve` plus SDK?
- Should Kilo direct-edit mode be enabled by default only for worktrees, with
  patch-proposal mode available for stricter repos?
- Should Kilo `--auto` be allowed in `draft-fix` mode, or only in
  `auto-fix-no-push` and stronger modes?
- How should Neondeck reattach to an already-running Kilo task after restart in
  CLI mode?
- Should Kilo tasks share the same global autonomy concurrency limits as Flue
  workflows, or have a separate limit?
- Where should Kilo task logs be retained: SQLite previews only, file-backed
  raw logs under `NEONDECK_HOME/data`, or both?
- Which Kilo model/agent settings should be exposed in Neondeck config?
- How should child Kilo task sessions be represented in the dashboard and
  audit trail?
- What transcript redaction rules should apply before Kilo session content is
  exposed to Neon, the dashboard, or future TUI?
- Should Neondeck index Kilo session metadata into its own SQLite database for
  faster search, or query Kilo on demand and cache only linked task/session ids?
