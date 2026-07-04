# exe.dev Workspace Mode Plan

Status: **active** — planning doc for a workspace-location mode: when enabled, Neon's repo
checkouts, worktrees, file edits, verification commands, and the agent's own workspace all live on
a configured exe.dev VM instead of the host. Written 2026-07-03 for implementation agents; sibling
to `.plans/archived/REFACTOR_PLAN.md` and `.plans/archived/MCP_SUPPORT_PLAN.md`, whose conventions this follows.

## Purpose

Neon is an always-ready operator: chat plus managed flows (PR watching, autopilot, briefings).
Today its _brain_ (config, SQLite, GitHub API, sessions, scheduler) and its _workspace_ (checkouts,
worktrees, edits, command execution) are both on the host. This plan separates those concerns and
makes the workspace location a config switch:

```text
workspace.mode = "host"     → everything as today (default, unchanged)
workspace.mode = "exe.dev"  → checkouts, worktrees, repo edits, execution, and the agent's
                              file/shell workspace all happen on the configured exe.dev VM
```

The user expectation this serves, verbatim: "if I turn that on — all things (checkouts, edits,
commands, etc) happen on that remote exe.dev instance."

The brain stays on the host in both modes. GitHub API calls, app/Flue SQLite, config files,
schedulers, watchers, and session state are not workspace concerns and do not move.

## Ground Rules (verified against the codebase and installed `@flue/*` 1.0.0-beta.9, 2026-07-03)

- **Flue's sandbox flag moves only the model's built-in workspace.** `sandbox: exedev(...)` on an
  agent routes the model-facing bash/file tools and `harness.fs` to the VM. It does not and cannot
  route Flue _actions_ — they are application code in the Node server process. Since Neondeck
  deliberately routes real work through typed actions, workspace mode is mostly an
  application-layer change, with the Flue sandbox flag as one (cheap) ingredient.
- **The host coupling is narrow and funneled.** Verified call paths:
  - `src/worktrees.ts`: all git goes through one `git(cwd, args)` helper on
    `execFileAsync` (2 `execFileAsync` call sites total).
  - `src/repo-edit/`: filesystem ops via `node:fs` (`index.ts`), git via `execFileAsync` + one
    `spawn` (`git.ts`), path safety via `realpath`/`lstat` (`path-safety.ts`).
  - `src/repos.ts`, `src/dev-doctor.ts`: host git/fs reads for status.
  - `src/kilo-actions.ts`: spawns the Kilo CLI on the host with streaming (`spawn`) — the one
    consumer that is _not_ a thin exec seam.
- **The exe.dev plumbing already exists.** `src/sandboxes/exedev.ts` implements Flue's
  `SandboxApi` over SSH/SFTP (with Neondeck's disposal fix); `execution.exeDev` config already
  carries `vmHostEnv`, `sshKeyEnv`, `apiTokenEnv`, `lifecycle`, `remoteRoot`, env forwarding, and
  per-repo/per-worktree checkout mappings; `neondeck_exedev_checkout_sync` already clones/syncs
  declared repos and worktrees to the VM through the execution approval policy.
- **`SFTPWrapper` exposes `realpath` and `lstat`**, so repo-edit's symlink-escape checks have
  direct remote equivalents — path safety does not need to be weakened remotely.
- **Flue never disposes sandbox session envs.** Any long-lived SSH usage must be owned and reaped
  by Neondeck (the existing `disposeExeDevSessionEnv` pattern, generalized).
- **Trust posture:** execution policy gates _which commands run_, not _where_ — it already brokers
  exe.dev commands today. Approvals, audit, prepared diffs, autopilot policy, and push gates all
  survive this change untouched in semantics.

## Non-Goals

- **No silent fallback across the trust boundary.** If mode is `exe.dev` and the VM is
  unreachable, operations fail with typed errors and runtime-status says why. Nothing quietly
  runs on the host instead.
- **No per-command location choice in v1.** The mode is global (see Open Questions for per-repo
  overrides later). Mixed-location worktrees are explicitly out.
- **No VM lifecycle management in v1.** Same `lifecycle: 'existing-vm'` posture as execution
  today: the user owns the VM. The adapter's create/clone/delete helpers stay unused.
- **Kilo handoff does not move in v1.** Kilo needs its CLI installed remotely and streamed over
  SSH; that is real work with its own trust questions. In `exe.dev` mode, Kilo task start returns
  a typed `kilo-requires-host-workspace` error (see Open Questions).
- **No second agent runtime.** This is the same Neon, same session, same actions — with the
  workspace relocated. The earlier "separate sandboxed worker agent" idea is superseded by this
  mode.

## Architecture

### The seam: `WorkspaceApi`

One interface, two implementations, chosen once per process from config. Lives in `src/lib/`
per REFACTOR_PLAN conventions (`src/lib/workspace.ts` + `src/workspaces/` for implementations, or
`src/domains/workspace/` if the refactor's domain layout has landed — implementer picks the
current convention and notes it here).

```ts
export type WorkspaceKind = 'host' | 'exe.dev';

export interface WorkspaceApi {
  readonly kind: WorkspaceKind;
  /** Absolute-path filesystem surface. Mirrors Flue's SandboxApi file methods. */
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<WorkspaceStat>; // includes isSymbolicLink
  lstat(path: string): Promise<WorkspaceStat>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  /** Arg-vector exec — no shell string assembly at call sites. */
  execFile(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      maxBuffer?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

Design notes:

- **`execFile`, not `exec`.** Flue's `SandboxApi.exec` takes a shell string; Neondeck's callers
  (worktrees, repo-edit) pass arg vectors today, which is injection-safe. The exe.dev
  implementation assembles the quoted shell string internally (reuse `shellArg` from
  `exedev-context.ts`); the host implementation is a thin `execFileAsync` wrapper. Call sites
  never concatenate shell strings.
- **`lstat`/`realpath` are first-class** because `repo-edit/path-safety.ts` needs them. Host:
  `node:fs/promises`. Remote: `SFTPWrapper.lstat`/`SFTPWrapper.realpath`.
- The exe.dev implementation wraps a **shared, supervised SSH connection** (see below), not a
  connection per call.
- Streaming (`spawn`-style incremental output) is deliberately absent from v1 of the interface;
  the two `spawn` consumers are Kilo (deferred) and repo-edit's patch-apply stdin pipe (rework to
  write the patch to a temp file in the workspace and `git apply <file>` — same semantics, no
  streaming needed).

### Connection supervisor

A small module owning the SSH lifecycle for `exe.dev` mode (pattern: the MCP plan's registry):

- One lazily-established `ExeDevSandboxApi` connection shared by all `WorkspaceApi` consumers,
  with reconnect-on-failure and capped backoff; health surfaced in runtime status.
- Reaped on shutdown and on config change (mode flipped off, VM host changed).
- **Also becomes the connection used by the `exe.dev` execution backend**, replacing today's
  connection-per-command in `execution-actions.ts` (fixes the chattiness flagged in the exe.dev
  review — `syncExeDevCheckout`'s up-to-8 steps currently open 8 SSH connections).

### Config

```jsonc
// config.json
"workspace": {
  "mode": "exe.dev"        // 'host' | 'exe.dev'; default 'host'
}
```

Everything else reuses `execution.exeDev` (vm host env, ssh key env, remoteRoot, checkout
mappings, env forwarding) — one VM definition, two consumers. Validation rules when
`mode: 'exe.dev'`:

- `execution.enabledBackends` must include `exe.dev`, and `defaultBackend` must be `exe.dev`
  (a host default alongside a remote workspace is incoherent; fail validation with a pointed
  message rather than silently overriding).
- The VM host env var must be resolvable at runtime-status time (readiness check, not config
  validation — config files must stay machine-portable).

Mode changes publish a `ConfigChangeEvent` and take effect without restart for new operations;
runtime status reflects the active mode. Typed action `neondeck_config_update_workspace`
(confirm-gated when switching mode — it changes where every subsequent mutation lands) plus CLI
`neondeck workspace status|set host|set exe.dev`.

### Path resolution in `exe.dev` mode

- Repo roots: the synced checkout path from `resolveExeDevCheckoutTarget`
  (`remoteRoot/<owner>-<name>-…`), not `repo.path`. A repo without a synced checkout yields a
  typed `checkout-not-synced` error naming `neondeck_exedev_checkout_sync` as the fix.
- Worktree roots: under `remoteRoot/worktrees/…` on the VM. `worktree` DB records gain a
  `location: 'host' | 'exe.dev'` column (migration in runtime-home app-db; default `'host'` for
  existing rows). All worktree operations (create/sync/status/cleanup/locks) run through
  `WorkspaceApi` against the record's own location — so pre-existing host worktrees remain
  manageable after a mode flip, and cleanup never confuses locations. New worktrees always take
  the active mode's location.
- Path-safety semantics in repo-edit are unchanged — same containment, symlink, and sensitive-path
  rules, evaluated with workspace `lstat`/`realpath`.

### Git auth on the VM

Fetch/clone of public repos works anonymously; private repos, and any push (autopilot push gates
run `git push` from the worktree), need credentials **on the VM**. v1 approach: document that
`exe.dev` mode expects either `gh auth login` performed on the VM by the user, or a
`GITHUB_TOKEN`/`GH_TOKEN` forwarded through the existing audited env-forwarding config
(`execution.exeDev.env.hostEnv`). The runtime-status toolchain check probes `git`, `gh`, and auth
(`gh auth status`) and reports what's missing. Neondeck never writes credentials to the VM
itself.

### Service migration map

| Service                                        | Change                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktrees.ts`                                 | Route the single `git()` helper and all fs ops through `WorkspaceApi`; add `location` to records; root resolution per mode                                                                                                                      |
| `repo-edit/`                                   | `index.ts` fs ops, `git.ts` exec, `path-safety.ts` realpath/lstat → `WorkspaceApi`; patch-apply drops stdin `spawn` for temp-file `git apply`                                                                                                   |
| `execution-actions.ts`                         | `exe.dev` backend uses the shared supervisor connection; in `exe.dev` mode, `local` backend requests are policy-denied with a mode explanation                                                                                                  |
| `exedev-checkouts.ts`                          | Unchanged flow, faster (shared connection); becomes the required first step per repo in `exe.dev` mode                                                                                                                                          |
| `repos.ts` / `dev-doctor.ts`                   | Repo status facts via `WorkspaceApi` in `exe.dev` mode (or clearly labeled `host-only` where a check is inherently local)                                                                                                                       |
| `autopilot-workflows.ts` / `prepared-diffs.ts` | No semantic change: they operate on worktrees through the worktree/repo-edit/execution services; verify they never touch `node:fs` directly on worktree paths (fix any strays found)                                                            |
| `kilo-actions.ts`                              | Typed `kilo-requires-host-workspace` error in `exe.dev` mode (v1)                                                                                                                                                                               |
| `agents/display-assistant.ts`                  | `sandbox: exedev(vmHost, …)` with `cwd` at `remoteRoot` when mode is `exe.dev` (initializer already reads config sync; VM host resolution must not throw at definition time — fall back to virtual sandbox + readiness warning if unresolvable) |
| `runtime-status.ts`                            | New checks: VM reachable, toolchain (`git`, `gh`, auth), checkout sync state per configured repo, active workspace mode                                                                                                                         |
| `safety.ts`                                    | Entries for the new workspace action/CLI/route; no class changes elsewhere (locations, not permissions, changed)                                                                                                                                |

### Agent-facing behavior

- Instruction addition (house style): in `exe.dev` workspace mode, all repo work happens on the
  configured VM; use `neondeck_exedev_checkout_sync` before repo actions on an unsynced repo;
  the agent's own file/shell workspace is the VM; Kilo handoff is unavailable in this mode;
  never claim work happened on the host.
- The Flue sandbox connection for chat sessions is separate from the supervisor connection
  (Flue owns its harness lifecycle). Risk: Flue never disposes it. Mitigation: the adapter gains
  an idle-timeout option (close the SSH socket after N minutes idle; it reconnects transparently
  on next use via a lazy-connect wrapper) — implemented in `src/sandboxes/exedev.ts` as a
  Neondeck extension and noted as a candidate to upstream.

## Delivery Plan: two PRs

Both PRs end with `npm run check` green and `npm run test:integration` passing. Integration tests
use a fake `WorkspaceApi` (in-memory) plus an SSH-loopback fixture where a real remote matters;
none require an actual exe.dev VM (a `smoke:workspace` script against a real VM is optional,
gated on `EXE_VM_HOST`).

### PR 1 — seam, config, worktrees, execution

1. `WorkspaceApi` + host implementation + exe.dev implementation + connection supervisor
   (unit tests: quoting, timeout, reconnect, lstat/realpath parity between implementations).
2. `workspace` config schema, validation coupling to execution config, config action + CLI +
   config events, safety entries.
3. `worktrees.ts` migration (git helper + fs + `location` column migration + root resolution).
4. Execution backend on the shared connection; `local`-backend denial in `exe.dev` mode;
   checkout-sync speedup falls out.
5. Runtime-status checks (VM reachable, toolchain, mode).

### PR 2 — repo-edit, agent sandbox, surfacing

1. `repo-edit/` migration (fs, git, path-safety, patch-apply rework) — the largest single piece;
   its existing test suite runs against both implementations via the fake.
2. `repos.ts`/`dev-doctor.ts` status facts; autopilot/prepared-diff stray-`node:fs` audit.
3. Display-assistant sandbox wiring + instruction paragraph + Kilo typed error.
4. Dashboard: workspace mode + VM health in Runtime Overview; docs page; update
   `.plans/ROADMAP.md` (workspace location under Extensibility/Execution).

If PR 1 outgrows review size, the sanctioned split is after step 2 (seam + config, no consumers
migrated) — not more PRs.

## Risks & Open Questions

- **SFTP latency on chatty operations.** repo-edit's search reads many files; over SFTP that's a
  roundtrip per file. Mitigation: in `exe.dev` mode, implement workspace-level search/grep as one
  remote `execFile('grep', …)` (the seam allows per-kind strategies); measure before optimizing
  further.
- **Behavioral parity between implementations.** The fake/host/remote trio must agree on error
  shapes (ENOENT vs SFTP status codes), exit codes, and output limits. Mitigation: a shared
  conformance test suite run against all `WorkspaceApi` implementations — write it first in PR 1.
- **Mode flips with live state.** Host worktrees + remote mode (and vice versa) are handled by
  per-record `location`, but in-flight autopilot runs during a flip are not. Mitigation: the
  confirm-gated mode switch warns when active worktrees/locks/running workflows exist and lists
  them.
- **VM as credential holder.** Push-back from the VM means repo credentials live there. This is
  the same trust decision as running Kilo or CI on any remote machine, but it must be _explicit_:
  documented, surfaced in readiness ("gh authenticated as X"), never automated by Neondeck.
- **Flue sandbox connection lifetime.** Covered by the idle-timeout mitigation above; verify no
  connection-per-message behavior in real chat before shipping PR 2.
- **Open question — per-repo workspace override.** A `workspaceMode` field on repo config could
  pin specific repos to host. Deferred: global-only in v1; revisit if a real mixed need appears.
- **Open question — Kilo on the VM.** Requires remote CLI install, streamed events over SSH, and
  session storage decisions. Deferred to its own plan if wanted; the typed error keeps the
  boundary honest meanwhile.

## Definition of Done

- With `workspace.mode: 'exe.dev'` configured and a reachable VM: repo checkout sync, worktree
  create/sync/cleanup, repo-edit reads/writes/patches, verification commands, autopilot
  prepare/verify flows, and the chat agent's own file/shell workspace all demonstrably execute on
  the VM (audit rows and worktree records say so), while GitHub facts, config, sessions, and
  schedules continue working from the host.
- With the VM unreachable in `exe.dev` mode, affected operations fail with typed errors, nothing
  falls back to the host, and runtime status pinpoints the failure.
- `workspace.mode: 'host'` behaves byte-for-byte as before this work.
- Existing host worktrees remain listable and cleanable after switching modes.
- The `WorkspaceApi` conformance suite passes for fake, host, and exe.dev implementations;
  `npm run verify` passes.
