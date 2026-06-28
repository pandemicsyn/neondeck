# Repo Editing Plan

Neondeck needs a first-class repo editing layer for Neon and future subagents. Flue gives us actions, workflows, skills, persistence, and sandbox file primitives, but the product experience we need is higher level: repo-aware reads, search, patch previews, audited writes, stale-read protection, and model-friendly error recovery.

This plan covers that layer. It intentionally defers rollback/checkpoint restore for v1. The near-term goal is a robust edit path that agents can use frequently without gaining arbitrary host filesystem access.

## Summary

Build a deterministic `repo-edit` subsystem exposed through typed Flue actions and local HTTP APIs.

Core capabilities:

- Read repo files with pagination and safe limits.
- Search configured repos with structured results.
- Write files atomically inside declared workspaces.
- Apply exact or fuzzy old-string/new-string replacements.
- Apply V4A/Codex-style multi-file patches.
- Preview and validate mutations before applying them.
- Produce git-backed diff/status summaries.
- Record edit attempts, outcomes, and touched paths in Neondeck SQLite.
- Keep all paths repo-relative and bounded to configured repos.

The agent should treat this as its primary way to modify project files. It should not use unrestricted local filesystem access for normal repo edits.

## Goals

- Give Neon reliable, repeatable file editing actions it can call from chat, commands, schedules, and workflows.
- Make the common agent edit loop fast:
  1. discover repo
  2. search/read files
  3. propose edits
  4. preview diff
  5. apply inside the declared workspace boundary
  6. report exact result
- Support both small targeted edits and multi-file patch application.
- Preserve safety around secrets, `.git`, path traversal, symlinks, and stale file contents.
- Keep the web UI and future TUI on one backend edit/event surface.
- Use Valibot schemas at all API, action, and persistence boundaries.
- Provide high-signal errors that help the model recover by re-reading, narrowing a replacement, or using a patch.

## Non-Goals

- No rollback/checkpoint restore in v1.
- No arbitrary host filesystem edit action.
- No package manager or shell execution as part of repo editing.
- No runtime-loaded third-party patch engines.
- No direct editing of Neondeck config through this subsystem. Neondeck config should continue to use typed configuration actions.
- No full IDE refactoring engine in v1.
- No mandatory lint/test execution after every edit.

## Prior Art

### Flue

Flue supplies the right integration layer:

- actions for deterministic model-callable capabilities
- workflows for bounded operations with run history
- skills for behavior guidance
- schedules for recurring checks
- SQLite-backed runtime persistence
- sandbox file primitives such as `FlueFs.readFile` and `FlueFs.writeFile`

Flue does not appear to provide a full repo edit and patch review layer. Neondeck should build that as application-owned functionality, then expose it to Flue through actions.

### Hermes

Hermes has the closest local-agent editing model.

Useful patterns to borrow:

- Separate tools for `read_file`, `write_file`, `patch`, and `search_files`.
- Guarded path resolution before any read or write.
- Stale-read detection by recording file stamps on reads.
- Per-path locks so concurrent subagents do not race writes.
- Atomic writes through a temporary file in the same directory followed by rename.
- UTF-8 BOM and line-ending preservation.
- Fuzzy old-string/new-string replacement with explicit ambiguity handling.
- V4A-style patch parsing:
  - `*** Begin Patch`
  - `*** Add File: path`
  - `*** Update File: path`
  - `*** Delete File: path`
  - `*** Move File: old -> new`
  - hunk lines with space, `-`, and `+` prefixes
  - `*** End Patch`
- Two-phase patch application: validate every operation before mutating anything.
- Simulated per-file updates while validating multi-hunk patches.
- Helpful failure messages after repeated patch failures.
- Edit proposals that surface old/new diffs before applying.
- Turn-end verification that catches claimed-but-not-applied file mutations.

Things to adapt carefully:

- Hermes checkpointing is not part of v1.
- Hermes' Python parser should be ported to TypeScript with Valibot-facing contracts.
- Hermes' broad local path model should become Neondeck repo-id plus repo-relative paths.

Reference:

- `research-repos/hermes-agent/tools/patch_parser.py`
- `research-repos/hermes-agent/tools/file_operations.py`
- `research-repos/hermes-agent/tools/file_tools.py`
- `research-repos/hermes-agent/tools/file_state.py`

### Kilo

Kilo's repo and diff handling adds useful Git-specific behavior.

Useful patterns to borrow:

- Centralized Git operations instead of scattered shell snippets.
- Binary-safe patch creation using a temporary Git index:
  - set `GIT_INDEX_FILE` to a temp index
  - `read-tree HEAD`
  - `git add -A -- <pathspec>`
  - `write-tree`
  - `git diff --binary --full-index --find-renames --no-color <baseTree> <tree>`
- Selected-file filtering before diff or apply:
  - trim entries
  - reject empty strings
  - reject absolute paths
  - reject any segment equal to `..`
- Preflight conflict checks before applying patches:
  - `git apply --3way --check --whitespace=nowarn -`
- Patch application with conflict parsing:
  - `git apply --3way --whitespace=nowarn -`
  - parse `patch failed`, `patch does not apply`, and file-specific errors
- Summary-first diff loading:
  - hot path returns file status, additions, deletions, binary/generated-like markers
  - full patch content is materialized only when requested
- Worktree/session separation in higher layers.
- Permission metadata includes per-file patches, additions, deletions, and file type.

Things to adapt carefully:

- Kilo's worktree transfer behavior is not the same as Neondeck's direct repo edit actions.
- Kilo's Git patch apply can supplement, but not replace, V4A patch parsing. We need both:
  - V4A for model-authored structured patches
  - unified Git patch apply for future worktree import and advanced flows

Reference:

- `/Users/pandemicsyn/projects/kilocode/packages/kilo-vscode/src/agent-manager/GitOps.ts`
- `/Users/pandemicsyn/projects/kilocode/packages/kilo-vscode/src/agent-manager/local-diff.ts`
- `/Users/pandemicsyn/projects/kilocode/packages/kilo-vscode/src/agent-manager/worktree-diff-controller.ts`
- `/Users/pandemicsyn/projects/kilocode/packages/kilo-vscode/tests/unit/git-ops.test.ts`

## Architecture

Add a repo editing domain under `src/repo-edit/`.

Proposed modules:

```text
src/repo-edit/
  actions.ts
  api.ts
  audit.ts
  diff.ts
  errors.ts
  fuzzy-replace.ts
  git.ts
  locks.ts
  patch-parser.ts
  patch-apply.ts
  path-safety.ts
  read.ts
  schemas.ts
  search.ts
  stale-state.ts
  write.ts
```

Responsibilities:

- `schemas.ts`: Valibot schemas and TypeScript types for all public input/output.
- `path-safety.ts`: repo lookup, path normalization, realpath checks, deny rules.
- `read.ts`: bounded reads, pagination, binary detection, read stamp recording.
- `search.ts`: `rg`-backed search with fallback behavior and limits.
- `write.ts`: atomic writes, line-ending/BOM preservation, post-write verification.
- `fuzzy-replace.ts`: exact and fuzzy replacement logic.
- `patch-parser.ts`: TypeScript V4A/Codex patch parser.
- `patch-apply.ts`: two-phase validation and application.
- `git.ts`: Git status, diff, diffstat, patch preflight, patch apply.
- `locks.ts`: in-process per-repo-path async locks.
- `stale-state.ts`: session-scoped read stamps and stale warnings.
- `audit.ts`: SQLite event records for attempts, blocked operations, failures, and successes.
- `api.ts`: Hono routes used by web and future TUI.
- `actions.ts`: Flue action registration.

All mutation paths should flow through the same service methods so HTTP APIs, Flue actions, slash commands, and future TUI commands have identical behavior.

## Repo Boundaries

Every edit request must identify a configured repo.

Inputs should use:

```ts
{
  repoId: string;
  path: string;
}
```

Do not accept raw absolute paths from model-facing actions. Path resolution should:

1. Load the repo from Neondeck's repo registry.
2. Resolve the configured repo root to a realpath.
3. Normalize the requested path as POSIX-ish repo-relative text.
4. Reject absolute paths.
5. Reject empty paths.
6. Reject any segment equal to `..`.
7. Resolve the candidate full path.
8. For existing paths, realpath the target.
9. Verify the target is inside the repo realpath.
10. For non-existing paths, verify the parent realpath is inside the repo.

Protected paths:

- hard deny `.git/**`
- hard deny `.ssh/**`
- hard deny private keys such as `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`
- allow `.env`, `.env.*`, secret-like names, and CI config when they live inside a declared workspace, but audit them with a sensitive-file marker
- allow generated lockfiles inside declared workspaces, but include a generated-file marker in edit events

Symlink policy for v1:

- Reads may follow symlinks only if the resolved target stays inside the repo.
- Writes through symlinks should be denied by default.
- Deletes and moves involving symlinks should be denied by default unless we add explicit symlink mutation support later.

## Public Actions

Expose these as Flue actions with Valibot schemas.

### `neondeck_repo_file_read`

Read one file from a configured repo.

Input:

```ts
{
  repoId: string
  path: string
  offset?: number
  limit?: number
  includeLineNumbers?: boolean
}
```

Output:

```ts
{
  repoId: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  binary: boolean;
  sizeBytes: number;
  stamp: {
    mtimeMs: number;
    size: number;
    sha256: string;
  }
}
```

Behavior:

- default to a bounded line/character window
- never dump huge files in one response
- reject binary files unless `metadataOnly` is added later
- record the read stamp by `sessionId`, `repoId`, and `path`

### `neondeck_repo_file_search`

Search configured repo content.

Input:

```ts
{
  repoId: string
  query: string
  globs?: string[]
  maxResults?: number
  contextLines?: number
}
```

Output:

```ts
{
  repoId: string;
  results: Array<{
    path: string;
    line: number;
    preview: string;
    before?: string[];
    after?: string[];
  }>;
  truncated: boolean;
}
```

Behavior:

- use `rg` when available
- fall back to a simple bounded scanner only if needed
- reject unsafe globs
- cap result count and preview length
- ignore `.git`, build output, dependency folders, and configured excludes

### `neondeck_repo_file_write`

Write a complete file. This is for generated files and controlled rewrites, not the preferred path for small edits.

Input:

```ts
{
  repoId: string
  path: string
  content: string
  createParentDirectories?: boolean
  expectedStamp?: FileStamp
  reason?: string
  dryRun?: boolean
}
```

Output:

```ts
{
  ok: boolean;
  dryRun: boolean;
  repoId: string;
  path: string;
  diff: string;
  diffSummary: DiffSummary;
  stale: boolean;
  eventId: string;
}
```

Behavior:

- allow mutation when the target is inside a declared workspace and passes path policy
- preserve BOM and dominant line endings when replacing an existing text file
- write through same-directory temp file plus rename
- verify post-write content by re-reading
- return a diff even on dry run
- record every attempt in SQLite

### `neondeck_repo_file_replace`

Apply old-string/new-string replacement.

Input:

```ts
{
  repoId: string
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
  expectedStamp?: FileStamp
  fuzzy?: "off" | "safe"
  dryRun?: boolean
  reason?: string
}
```

Output:

```ts
{
  ok: boolean;
  dryRun: boolean;
  repoId: string;
  path: string;
  matched: 'exact' | 'normalized-whitespace' | 'fuzzy';
  replacements: number;
  diff: string;
  diffSummary: DiffSummary;
  stale: boolean;
  eventId: string;
}
```

Behavior:

- exact unique match first
- `replaceAll` must be explicit
- fuzzy mode must be opt-in and conservative
- ambiguous matches fail with candidate snippets
- no silent best-guess replacement when confidence is low

### `neondeck_repo_file_patch`

Apply a V4A/Codex-style multi-file patch.

Input:

```ts
{
  repoId: string
  patch: string
  expectedStamps?: Record<string, FileStamp>
  dryRun?: boolean
  reason?: string
}
```

Output:

```ts
{
  ok: boolean;
  dryRun: boolean;
  repoId: string;
  files: Array<{
    path: string;
    operation: 'add' | 'update' | 'delete' | 'move';
    diff: string;
    additions: number;
    deletions: number;
  }>;
  diff: string;
  diffSummary: DiffSummary;
  stale: Array<{ path: string; reason: string }>;
  eventId: string;
}
```

Behavior:

- parse the whole patch before validation
- validate every file operation before mutating anything
- lock all touched paths in sorted order
- apply all operations or none
- return per-file failure details with hunk numbers and context

### `neondeck_repo_diff`

Return git-backed repo diff summaries and optional full patches.

Input:

```ts
{
  repoId: string
  base?: string
  paths?: string[]
  includePatch?: boolean
  maxPatchBytes?: number
}
```

Output:

```ts
{
  repoId: string;
  base: string;
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    additions: number;
    deletions: number;
    binary: boolean;
    generatedLike: boolean;
    patch?: string;
    truncated?: boolean;
  }>;
}
```

Behavior:

- summary-first by default
- materialize full patches only when requested
- filter path inputs with the same relative path guard as Kilo
- handle binary and huge diffs with metadata instead of large payloads

### `neondeck_repo_checkout_status`

Return branch and working tree status.

Input:

```ts
{
  repoId: string;
}
```

Output:

```ts
{
  repoId: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  clean: boolean
  files: Array<{
    path: string
    status: string
  }>
}
```

## HTTP API

Expose the same capabilities for the dashboard and future TUI.

Proposed routes:

```text
GET  /api/repos/:repoId/status
POST /api/repos/:repoId/files/read
POST /api/repos/:repoId/files/search
POST /api/repos/:repoId/files/write/preview
POST /api/repos/:repoId/files/write
POST /api/repos/:repoId/files/replace/preview
POST /api/repos/:repoId/files/replace
POST /api/repos/:repoId/files/patch/preview
POST /api/repos/:repoId/files/patch
POST /api/repos/:repoId/diff
GET  /api/repo-edits
GET  /api/repo-edits/:eventId
```

The Flue actions should call the service layer directly, not loop back through HTTP.

## SQLite State

Add tables to `data/neondeck.db`.

### `repo_edit_events`

Records all edit attempts.

Columns:

- `id`
- `repo_id`
- `session_id`
- `workflow_run_id`
- `actor_type`: `agent`, `user`, `system`
- `actor_id`
- `action`: `read`, `search`, `write`, `replace`, `patch`, `diff`, `status`
- `status`: `preview`, `applied`, `failed`, `blocked`
- `reason`
- `paths_json`
- `input_hash`
- `diff_summary_json`
- `diff_patch`
- `error_json`
- `created_at`
- `updated_at`

Patch bodies and diffs should be capped. Store full large artifacts only if we introduce an artifact store later.

### `repo_file_reads`

Tracks read stamps for stale-write detection.

Columns:

- `id`
- `session_id`
- `repo_id`
- `path`
- `mtime_ms`
- `size`
- `sha256`
- `partial`
- `read_at`

Only recent session reads need to be retained. Add cleanup for old records.

## Stale-Read Protection

Agents often edit files they read earlier in the session. The edit layer should detect when that assumption is stale.

Read stamp:

```ts
{
  mtimeMs: number;
  size: number;
  sha256: string;
}
```

Mutation behavior:

- If `expectedStamp` is provided and does not match, fail by default.
- If no `expectedStamp` is provided but this session read the file earlier and it changed since, return a stale warning and require a re-read before mutation.
- If no prior read exists, allow preview and apply as long as path policy passes.
- For multi-file patches, report stale files as an array.

This protects against a frequent agent failure mode: applying an edit to content that another user or agent already changed.

## Locks

Use in-process async locks keyed by:

```text
repoId + "\0" + normalizedPath
```

Rules:

- Read does not require a lock.
- Write, replace, delete, move, and patch apply acquire locks.
- Multi-file patches acquire all touched path locks in sorted order.
- Locks should have timeouts and always release in `finally`.
- If the process restarts, no lock state survives. SQLite audit state is for history, not distributed locking.

This is enough for local v1. If Neondeck later supports multiple backend processes, replace or supplement this with SQLite advisory locking.

## Fuzzy Replacement

Implement exact matching first, then conservative fuzzy matching inspired by Hermes.

Algorithm:

1. Normalize input line endings to `\n` for matching.
2. Strip UTF-8 BOM from the comparison buffer but remember it for output.
3. Try exact match.
4. If exact match count is one, replace it.
5. If exact match count is greater than one:
   - fail unless `replaceAll` is true
   - if `replaceAll`, replace every exact match
6. If exact match count is zero and `fuzzy` is `off`, fail with nearby candidate guidance.
7. If `fuzzy` is `safe`, compute candidates using:
   - whitespace-normalized matching
   - line-trimmed matching
   - bounded edit distance over line windows
   - optional shared prefix/suffix scoring
8. Accept only one candidate above threshold.
9. Fail if candidates are ambiguous or below threshold.
10. Preserve original file line endings and BOM in the final output.

Failure output should include:

```ts
{
  code: 'NO_MATCH' | 'AMBIGUOUS_MATCH' | 'LOW_CONFIDENCE';
  message: string;
  candidates: Array<{
    startLine: number;
    endLine: number;
    score: number;
    preview: string;
  }>;
}
```

Important constraints:

- Never use fuzzy matching for binary or huge files.
- Never silently replace the highest-scoring candidate if there are close ties.
- Keep match windows bounded to avoid expensive whole-file edit-distance work.
- Return candidate snippets that help the model produce a narrower `oldString`.

## V4A/Codex Patch Parser

Implement a TypeScript parser based on the Hermes V4A parser and Codex-style `apply_patch` grammar.

Supported format:

```text
*** Begin Patch
*** Add File: src/new.ts
+export const value = 1
*** Update File: src/existing.ts
@@ optional context hint
 const keep = true
-const oldValue = 1
+const newValue = 2
*** Delete File: src/old.ts
*** Move File: src/old-name.ts -> src/new-name.ts
*** End Patch
```

Parser output:

```ts
type ParsedPatch = {
  operations: PatchOperation[];
};

type PatchOperation =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'update'; path: string; hunks: PatchHunk[] }
  | { type: 'delete'; path: string }
  | { type: 'move'; from: string; to: string; hunks: PatchHunk[] };

type PatchHunk = {
  contextHint?: string;
  lines: Array<
    | { kind: 'context'; text: string }
    | { kind: 'remove'; text: string }
    | { kind: 'add'; text: string }
  >;
};
```

Validation rules:

- `Begin Patch` and `End Patch` should be accepted when present. For model tolerance, missing markers can be accepted only if at least one file operation is otherwise valid.
- File headers must contain a non-empty repo-relative path.
- Reject absolute paths and `..` path segments.
- `Add File` fails if the target already exists unless an explicit future `overwrite` mode is added.
- `Update File` fails if the target does not exist.
- `Delete File` fails if the target does not exist.
- `Move File` fails if the source does not exist or the destination already exists.
- `Update File` must contain at least one hunk.
- Hunk lines must start with space, `-`, or `+`.
- Addition-only hunks require a unique context hint or unique surrounding context.
- Removal hunks must match the simulated current content.
- Multi-hunk updates must advance through simulated content so later hunks validate against earlier hunk changes.
- All operations must validate before any write occurs.

Application rules:

- Parse the entire patch.
- Resolve and lock all touched paths.
- Load original file contents.
- Validate against in-memory simulated contents.
- Generate per-file before/after content.
- Generate unified diffs.
- If `dryRun`, stop here and return preview.
- If path policy blocks the edit, return a typed blocked result and stop.
- Apply all filesystem mutations.
- Verify each changed path post-write.
- Record audit event outcome.

Error output should identify:

- operation index
- operation type
- path
- hunk index if applicable
- reason code
- short model-actionable message
- optional candidate context

Example:

```json
{
  "code": "HUNK_CONTEXT_NOT_FOUND",
  "path": "src/app.ts",
  "operationIndex": 1,
  "hunkIndex": 0,
  "message": "The hunk context was not found. Re-read src/app.ts and regenerate the patch with current surrounding lines."
}
```

## Atomic Writes

For write, replace, and patch operations:

1. Load existing metadata if the file exists.
2. Build final content in memory.
3. Create parent directories only when allowed.
4. Write to a temp file in the target directory.
5. Apply existing mode bits when replacing an existing file.
6. Rename temp file over target.
7. Re-read target and verify hash/content.
8. Remove temp file on failure.

Line ending policy:

- Existing file with CRLF stays CRLF unless the new content already explicitly uses mixed endings.
- Existing file with LF stays LF.
- New files use LF.
- Preserve leading UTF-8 BOM only if the existing file had one.

## Git Integration

Add a centralized `RepoGit` service instead of scattering `execFile("git", ...)`.

Commands should use argument arrays and `execFile`/`spawn`, never shell interpolation.

Core methods:

```ts
status(repoRoot): Promise<RepoStatus>
diffSummary(repoRoot, base, paths?): Promise<DiffSummary>
diffFile(repoRoot, base, path): Promise<FileDiff>
buildWorktreePatch(repoRoot, base, paths?): Promise<string>
checkApplyUnifiedPatch(repoRoot, patch): Promise<ApplyCheckResult>
applyUnifiedPatch(repoRoot, patch): Promise<ApplyPatchResult>
```

Borrow from Kilo:

- temporary index for binary-safe worktree patch generation
- selected-file path filtering
- `--binary`
- `--full-index`
- `--find-renames`
- `--no-color`
- `git apply --3way --check --whitespace=nowarn -`
- conflict parsing from git stderr/stdout

For Neondeck v1, V4A patching is the primary model-authored patch path. Unified patch apply should exist as an internal utility and future public action for worktree transfer or advanced user flows.

## Workspace Trust Policy

Declared workspaces are the trust boundary.

Neondeck should never prompt for approval to read or edit a file that is inside a declared workspace and passes path policy. This applies to reads, search, status, diff summaries, writes, replacements, and patches.

Instead of prompting, the edit layer has two outcomes:

- allowed: apply the operation and audit it
- blocked: reject the operation with a typed policy error

Policy classes:

- `read`: file read
- `search`: repo search
- `write`: full file write
- `replace`: old/new string replacement
- `patch-update`: V4A update hunks
- `patch-add`: new files
- `patch-delete`: deletes
- `patch-move`: moves
- `sensitive`: secret-like file inside the workspace, allowed but highlighted in audit records
- `blocked`: denied paths such as `.git/**`, private keys, outside-workspace targets, or symlink writes

Suggested default:

```json
{
  "repoEdits": {
    "declaredWorkspaceDefault": "allow",
    "deny": [
      ".git/**",
      ".ssh/**",
      "**/*.pem",
      "**/*.key",
      "**/id_rsa",
      "**/id_ed25519"
    ],
    "sensitiveMarkers": [".env", ".env.*", "**/*secret*", "**/*token*"]
  }
}
```

Edit event UI should show:

- repo
- files touched
- operation classes
- reason supplied by the agent
- additions and deletions
- capped unified diff
- sensitive-file warnings
- stale-read warnings
- blocked policy errors

The web dashboard should show edit events and blocked operations first. Future TUI should use the same API.

## Agent UX

Neon should receive a runtime skill update that explains the edit loop:

1. Use repo registry to identify the repo.
2. Search before reading when file location is unknown.
3. Read the specific files before editing.
4. Prefer `replace` for small targeted edits.
5. Prefer V4A `patch` for multi-file changes.
6. Use `write` for new generated files or deliberate full rewrites.
7. Include a short reason for every mutation.
8. If stale or no-match errors occur, re-read and retry once with current context.
9. After apply, call diff/status when useful and summarize exact files changed.

Failures should be phrased for model recovery:

- "Re-read this file and retry with current context."
- "The old string matched 3 locations. Provide more surrounding lines or set replaceAll."
- "The patch touched `.env`; the edit was applied and marked sensitive in the audit log."
- "The path resolves outside the repo and was rejected."

## Runtime Skill Changes

Update the Neondeck runtime skill in a later implementation phase to include:

- available repo edit actions
- when to use read/search/replace/patch/write
- path safety rules
- declared workspace trust rules
- stale-read recovery
- examples of V4A patch format
- warning not to edit Neondeck config files through repo edit actions

The repo's Codex/Kilo skills can also mention this subsystem once it exists.

## API And UI Surfaces

Initial web UI:

- Repo edit event panel in the runtime/workflow area.
- Diff preview modal with keyboard shortcuts:
  - copy patch
  - open file path
- Edit event history with status and touched paths.

Future TUI:

- Same repo edit event list.
- Diff viewer optimized for terminal width.
- Commands:
  - `neondeck diff <repo>`
  - `neondeck edit-events`

Do not build a separate TUI edit runtime. It should call the same HTTP API.

## Testing Plan

### Unit Tests

Path safety:

- rejects absolute paths
- rejects `..`
- rejects empty paths
- rejects `.git`
- rejects symlink writes that resolve outside repo
- allows reads through symlinks only inside repo
- creates new files only when parent is inside repo

Read/search:

- paginates large files
- returns line metadata
- records read stamps
- detects binary files
- caps search output
- rejects unsafe globs

Fuzzy replace:

- exact unique match
- exact ambiguous match
- `replaceAll`
- no match
- whitespace-normalized match
- ambiguous fuzzy candidates
- low-confidence candidate rejection
- CRLF preservation
- BOM preservation
- huge-file refusal

V4A parser:

- add file
- update file
- delete file
- move file
- multiple operations
- multiple hunks in one file
- addition-only hunk with unique context hint
- malformed headers
- missing begin/end tolerance
- absolute path rejection
- traversal path rejection
- hunk context not found
- all-or-none validation

Atomic write:

- temp file cleanup on failure
- parent directory creation when allowed
- mode preservation
- post-write verification failure handling

Git integration:

- status clean/dirty
- diff summary for tracked files
- diff summary for untracked files
- binary file summary
- generated-like file marker
- selected-file path filtering
- invalid selected paths ignored or rejected according to method contract
- unified patch check success
- unified patch check conflict
- unified patch apply success
- unified patch apply conflict

Policy/audit:

- mutation inside a declared workspace applies without prompting when path policy passes
- blocked path policy prevents mutation
- sensitive files inside declared workspaces apply and receive sensitive audit markers
- audit event records failure details
- stale read blocks apply

### Integration Tests

Use temporary git repos.

Scenarios:

- repo registry resolves repo id to root
- search, read, replace, diff in one flow
- dry-run V4A patch preview creates no filesystem changes
- V4A patch applies multiple files without prompting inside a declared workspace
- malformed multi-file patch applies no partial changes
- stale file read prevents patch apply after external modification
- Flue action smoke test can invoke read/search/dry-run patch
- HTTP API and Flue action service results match for the same request

### Manual Smoke Tests

- Ask Neon to make a one-line code change in a configured repo.
- Ask Neon to add a small new file.
- Ask Neon to modify two files with one patch.
- Ask Neon to edit a stale file after manually changing it.
- Ask Neon to edit `.env` inside a declared workspace and verify the edit is applied with a sensitive audit marker.
- Ask Neon to summarize current repo diff after edits.

## Implementation Phases

### Phase 1: Core Repo File Substrate

- Add `src/repo-edit/schemas.ts`.
- Add repo path safety helpers.
- Add read action/service with pagination and read stamp recording.
- Add search action/service using `rg`.
- Add checkout status and basic diff summary.
- Add unit tests for path safety, read, search, and status.

Exit criteria:

- Neon can safely inspect configured repos without mutation access.
- All model-facing paths are repo-relative and bounded.

### Phase 2: Atomic Write And Fuzzy Replace

- Add atomic write implementation.
- Add dry-run diff generation.
- Add conservative fuzzy replace.
- Add stale-read checks.
- Add per-path locks.
- Add write and replace preview/apply services.
- Add unit tests for fuzzy replace, line endings, BOM, locks, and stale writes.

Exit criteria:

- Neon can propose and apply precise single-file edits inside declared workspaces.
- Ambiguous replacement errors are recoverable by the model.

### Phase 3: V4A Patch Parser And Multi-File Apply

- Port Hermes-style V4A parser to TypeScript.
- Add strict validation and typed error results.
- Add two-phase multi-file apply.
- Add add/update/delete/move support.
- Add all-or-none tests with malformed patches.
- Add dry-run preview for patches.

Exit criteria:

- Neon can apply model-authored multi-file patches reliably.
- Failed patches do not partially mutate the repo.

### Phase 4: Git Patch And Diff Hardening

- Add Kilo-style temporary-index worktree patch builder.
- Add unified patch preflight and apply helpers.
- Add conflict parsing.
- Add binary/huge/generated-like diff handling.
- Add summary-first diff APIs.

Exit criteria:

- Neondeck can produce compact diff summaries quickly and full patches on demand.
- Unified patch helpers are ready for future worktree transfer flows.

### Phase 5: Flue Actions, Runtime Skill, And Agent Guidance

- Register Flue actions for read/search/write/replace/patch/diff/status.
- Update runtime Neondeck skill with edit-loop guidance.
- Add examples for fuzzy replace and V4A patch.
- Add action smoke tests.

Exit criteria:

- Neon naturally uses the repo edit actions instead of raw local file edits.
- The model sees enough guidance to recover from stale, ambiguous, and malformed edit errors.

### Phase 6: Edit Event And Audit UI

- Add `repo_edit_events`.
- Add `repo_file_reads`.
- Add Hono edit event routes.
- Add dashboard edit event history and diff preview.
- Add event history.

Exit criteria:

- Mutations have a clear audit trail and blocked-policy visibility.
- Edit history can be reviewed after the fact.

### Phase 7: Polish And Operational Hardening

- Add cleanup jobs for old read stamps and audit rows.
- Add better generated-file detection.
- Add size caps and config knobs.
- Add docs for repo editing and workspace trust policy.
- Add CLI commands for diff and edit events.
- Add future TUI acceptance notes.

Exit criteria:

- Repo editing feels like a dependable product surface, not a hidden model tool.

## Acceptance Criteria

- All public inputs are Valibot-validated.
- All model-facing file paths are repo-relative.
- Path traversal and absolute paths are rejected.
- Symlink writes outside repo are impossible.
- `.git` writes are impossible.
- Secret-like edits inside declared workspaces are applied and marked sensitive in audit records.
- Read/search/status work without prompting.
- Mutations support dry-run preview.
- Mutations inside declared workspaces do not prompt for approval.
- Fuzzy replace never silently applies ambiguous matches.
- V4A patches validate all operations before applying any mutation.
- Multi-file patch failures leave the repo unchanged.
- Applied edits are audited.
- Stale reads are detected and surfaced with model-recoverable errors.
- Git diff/status APIs handle binary and large files without dumping huge payloads.
- Web and future TUI can share the same API and event model.

## Open Questions

- Should `.env` edits be hard-denied or always-ask by default?
- Should `Delete File` and `Move File` be enabled in the first V4A release, or hidden behind stricter path policy?
- Should generated lockfiles require special workflow provenance before mutation?
- Should unified patch apply be public in v1, or remain internal until worktree transfer exists?
- How much lint/LSP feedback should be included in v1 without slowing the edit loop?
- Should stale-read requirements be strict for all mutations, or only when the session has previously read the file?

## Deferred

- Rollback checkpoints and restore.
- Distributed locking across multiple Neondeck backend processes.
- IDE-grade AST transforms.
- Automatic test/lint execution after edits.
- External plugin patch engines.
- Editing files outside configured repos.
