# Scheduled Task Workspaces And Pluggable Sandbox Providers

Status: **implemented** — repository-capable scheduled tasks with explicit
workspace, Git, permission, retention, and delivery policies. exe.dev is the primary remote
provider; local managed worktrees remain first-class; custom SSH-compatible remotes are the first
extension point.

Written 2026-08-16 against Neondeck's installed `@flue/*` 2.0.3 packages and the bundled Flue
`reference/sandbox-api` and `guide/sandboxes` documentation.

## Purpose

Before this implementation, Neondeck's scheduler dispatched briefings and bounded agent
instructions only into an in-memory virtual workspace. Repository-capable instructions now select
an explicit provider and persist a checkout, exact Git identity, and run-specific evidence; legacy
virtual schedules remain compatible.

Repository-capable schedules need to be able to:

- select local execution or a remote workspace provider;
- resolve a branch such as `main` to an exact base SHA at run admission;
- create or reuse a workspace independently from creating or reusing a Git branch;
- run repository-native tests, formatters, typechecks, and builds inside that workspace;
- retain a failed or reviewable workspace without touching the user's primary checkout;
- capture the final response, command evidence, Git status, diff, and commit before cleanup;
- expose every occurrence and its artifacts through a dedicated Scheduled Tasks UI;
- add another remote provider without threading a new literal through every scheduler, execution,
  schema, API, and UI switch.

This plan makes those choices explicit product state owned by Neondeck. Flue supplies the agent
sandbox adapter boundary; Neondeck owns scheduling, provider provisioning, Git preparation, locks,
permissions, artifact collection, retention, and teardown.

## Decisions

1. **exe.dev is the default remote provider.** It receives the primary setup path, documentation,
   readiness checks, smoke test, and UI presentation. `local` remains the overall default until the
   user opts into remote execution.
2. **Remote providers are pluggable in Neondeck.** Replace the closed `local | exe.dev` execution
   union with a registry-backed provider id. Built-in providers register through the same contract
   that future adapters use.
3. **Custom remote v1 means generic SSH Linux.** Factor the existing SSH/SFTP execution transport
   out of exe.dev. A user can register a dedicated Linux host by environment-variable references
   without writing a provider SDK adapter. Arbitrary SDK-backed providers can be added in code
   later through the provider registry; runtime loading of untrusted npm packages is not part of
   v1.
4. **Workspace lifecycle and Git branch policy are independent.** A task may reuse a physical
   workspace while creating a fresh branch per occurrence, or keep both a persistent workspace and
   persistent task branch.
5. **“Run on `main`” is not synonymous with “mutate the user's `main` checkout.”** The default
   interpretation follows the latest `main` SHA in a Neondeck-owned workspace. Direct operation on
   `main` is an explicit advanced policy available only in a dedicated workspace.
6. **Conversation persistence and workspace persistence are independent.** A fresh scheduled agent
   session may reuse a workspace, and a continuing session may receive a fresh workspace. Neither
   choice silently implies the other.
7. **No silent provider fallback.** A run configured for exe.dev or a custom remote fails with a
   typed readiness result if that provider is unavailable. It never falls back to local execution.
8. **A remote sandbox is not itself an authority grant.** Permissions, credentials, command
   policy, bound delivery tools, and unattended-execution policy remain separate Neondeck policy;
   arbitrary shell is documented as shell rather than treated as a token-parser security boundary.

## Relationship To Existing Plans And Runtime

- `.plans/ROADMAP.md` already says a watch or schedule should be able to create one isolated
  checkout per PR or task and run bounded work inside it. This plan specifies the scheduled-task
  half of that direction.
- `.plans/EXEDEV_WORKSPACE_MODE_PLAN.md` proposes relocating Neon's global workspace to exe.dev and
  was written against Flue `1.0.0-beta.9`. This plan does not require a global mode. It introduces
  the provider and task-workspace seam that a later, version-reconciled global mode should reuse.
- Existing Autopilot worktrees remain stable, PR-owned workspaces. Scheduled task workspaces are
  occurrence- or task-owned and must not be forced into Autopilot's one-owner-per-PR lifecycle.
- Existing `execution.exeDev` config and approval history remain migration inputs. The first
  provider implementation should synthesize an exe.dev provider from that config before any
  optional config cleanup.

## Flue 2 Boundary

Flue 2.0.3 explicitly supports custom sandbox adapters:

```ts
interface SandboxFactory {
  createSandbox(options: { id: string }): Promise<Sandbox>;
  tools?: SandboxToolFactory;
}
```

`Sandbox` supplies the common `exec`, file, directory, cwd, and path-resolution surface. A provider
adapter implements Flue's `SandboxDriver` and uses `sandboxFromDriver(...)` for standard path and
abort behavior.

The boundary has two consequences for Neondeck:

- Flue creates or reconnects an environment once per initialized harness and may key it by the
  agent instance id.
- Flue has no teardown callback and does not own provider infrastructure lifecycle.

Therefore a `SandboxFactory` alone is insufficient for scheduled work. Neondeck needs an
application-level provider contract that provisions or attaches resources before dispatch, creates
connections for deterministic Git orchestration and Flue, collects artifacts, and destroys or
retains the resource only after run settlement.

## Product Model

### Scheduled task workspace policy

Repository-capable `run-agent-instruction` specs gain an optional workspace policy. Existing tasks
without one retain today's virtual-workspace behavior.

```ts
type ScheduledWorkspacePolicy =
  | { kind: 'virtual' }
  | {
      kind: 'repository';
      repoId: string;
      providerId: string; // `local`, `exe.dev`, or a configured provider id
      subdirectory?: string;
      resource: {
        lifecycle: 'per-run' | 'reuse-task' | 'existing';
        existingResourceId?: string;
      };
      revision: {
        ref: string; // for example `main`
        mode: 'latest-each-run' | 'pinned' | 'continue';
        sha?: string;
      };
      git: {
        mode: 'run-branch' | 'task-branch' | 'direct-branch';
        branch?: string;
        acknowledgeDirectBranch?: boolean;
      };
      authority: 'read-only' | 'trusted-workspace' | 'delivery-enabled';
      retention?: 'cleanup-success' | 'retain-always';
      overlap?: 'skip' | 'queue-one' | 'allow-parallel';
    };
```

Names may be adjusted to match current schema conventions, but the independent dimensions must be
preserved. Do not collapse them into one ambiguous `sandboxMode` or `branch` toggle.

Existing `repoId` and `cwd` fields remain readable during migration. New writes place `repoId` in
the workspace policy and treat `subdirectory` as a repo-relative cwd. Arbitrary absolute `cwd`
values are not accepted for managed repository workspaces.

### Supported combinations

| User intent                 | Resource lifecycle                   | Revision         | Git mode                              | Behavior                                                       |
| --------------------------- | ------------------------------------ | ---------------- | ------------------------------------- | -------------------------------------------------------------- |
| Safest isolated run         | `per-run`                            | latest or pinned | `run-branch`                          | New resource and unique branch for every occurrence            |
| Warm reusable environment   | `reuse-task`                         | latest each run  | `run-branch`                          | Reuse dependencies/cache, create a clean branch per occurrence |
| Continuing maintenance task | `reuse-task`                         | continue         | `task-branch`                         | Preserve one task branch and workspace across occurrences      |
| Always test current `main`  | `reuse-task`                         | latest each run  | `run-branch` or clean tracking branch | Sync before each run without touching the user's checkout      |
| Directly operate on `main`  | `existing` or dedicated `reuse-task` | latest each run  | `direct-branch`                       | Explicit advanced authority, serialized and visibly risky      |

Validation rules:

- `continue` requires `task-branch` and a durable resource, or a branch whose state is durably
  published elsewhere.
- `direct-branch` requires a dedicated provider workspace, an overlap policy that serializes runs,
  and explicit UI/API acknowledgement. It cannot target the user's primary checkout by default.
- `allow-parallel` cannot share one mutable worktree or direct branch.
- `skip` advances past an occurrence that becomes due while its predecessor is active;
  `queue-one` preserves one overdue occurrence and admits it after settlement.
- A reused workspace with unresolved changes is never reset. The run blocks with a retained-state
  result, or uses a fresh fallback resource only when that fallback policy was explicitly chosen.
- Locally, Git cannot normally check out the same branch in two worktrees. When the user's checkout
  already has `main`, “track main” uses a schedule-owned branch or detached exact-SHA checkout.
  Direct local `main` is accepted only through a dedicated existing worktree where the branch is
  not held by the primary checkout.
- A per-run remote resource cannot preserve an unpublished task branch after destruction. Before
  teardown, Neondeck must push through an authorized delivery path or capture a Git bundle/patch
  and commit metadata.

### Branch naming

Neondeck-generated names are deterministic and collision-safe:

```text
neondeck/schedules/<task-slug>/<run-short-id>    # run branch
neondeck/schedules/<task-slug>                   # persistent task branch
```

The run record stores the requested ref, resolved base SHA, actual branch, initial HEAD, final HEAD,
and dirty state. A symbolic ref is never the only recorded revision identity.

## Provider Architecture

### Provider registry

Introduce a single registry used by scheduled workspaces, approved execution, runtime readiness,
and later global workspace mode:

```ts
type WorkspaceProviderDescriptor = {
  id: string;
  label: string;
  location: 'local' | 'remote';
  capabilities: {
    provision: boolean;
    attachExisting: boolean;
    persistentResources: boolean;
    snapshots: boolean;
    commandCancellation: 'native' | 'orphan-possible';
  };
};

type WorkspaceResource = {
  providerId: string;
  externalId: string;
  root: string;
  metadata: Record<string, unknown>;
};

interface WorkspaceConnection {
  env: Sandbox;
  close(): Promise<void>; // closes transport only, never deletes infrastructure
}

interface WorkspaceProvider {
  descriptor: WorkspaceProviderDescriptor;
  validateConfig(config: unknown): ProviderValidation;
  readiness(config: unknown): Promise<ProviderReadiness>;
  provision(input: ProvisionWorkspaceInput): Promise<WorkspaceResource>;
  attach(input: AttachWorkspaceInput): Promise<WorkspaceResource>;
  connect(resource: WorkspaceResource): Promise<WorkspaceConnection>;
  sandbox(resource: WorkspaceResource): SandboxFactory;
  inspect(resource: WorkspaceResource): Promise<ProviderResourceStatus>;
  destroy(resource: WorkspaceResource): Promise<void>;
}
```

The exact TypeScript can evolve, but preserve these separations:

- `close()` ends a transport connection; `destroy()` deletes provider infrastructure.
- provider methods return provider-neutral typed errors;
- provider resource ids and metadata are opaque outside the adapter;
- generic repository preparation runs through `Sandbox`, not provider-specific Git APIs;
- provider capability checks happen before a task is admitted;
- one provider cannot silently proxy or fall back to another.

The registry is code-owned in v1. Config selects registered drivers and supplies environment
variable references. Dynamic execution of arbitrary third-party provider packages is deferred
until Neondeck has a plugin trust, installation, versioning, and migration model.

### Built-in local provider

- Uses Neondeck's existing managed worktree service and Flue `local()` through `boundedLocal()`.
- Never uses the user's primary checkout for autonomous mutations by default.
- `per-run` creates one worktree per occurrence; `reuse-task` records and locks one task-owned
  worktree; `existing` requires an explicitly adopted, declared workspace.
- Does not forward ambient credential environment variables into Flue's local shell. Because that
  shell is not OS-contained and can address host paths, this is credential reduction rather than a
  guarantee that host credentials are unreachable.

### Primary exe.dev provider

exe.dev is implemented through two composable layers:

1. A generic SSH/SFTP transport implementing Flue `SandboxDriver`/`Sandbox` semantics.
2. An exe.dev control-plane driver for VM discovery, create/clone/delete, readiness, and provider
   metadata.

The transport applies byte bounds and deadlines to commands and every structured read/write/stat/
directory operation. A timed-out or post-launch-failed mutation is an orphan-possible result, not a
normal command failure. Its durable workspace record is release-fenced before quarantine is
attempted, so a quarantine-write failure or process restart cannot silently make the physical SSH
resource reusable. The conforming `Sandbox` wrapper owns parent creation and retries `writeFile`
only for a factual missing-parent error; it never masks or repeats a typed uncertain SFTP write.
Disposable command execution checks cancellation before opening a command connection and carries
the command signal and deadline through connection and credential-isolation setup. A setup abort
closes a connection that finishes late without creating the private HOME or launching the command.
Every disposable sandbox verb reports typed setup or transport uncertainty through the same
application-owned release-fence and quarantine boundary. Flue-compatible `exists` still resolves
`false`, but records the uncertainty first and invalidates the exact run before later operations.

Initial delivery supports the existing configured VM immediately because that path already exists.
Then add `per-run` and `reuse-task` resource lifecycles using the app-owned exe.dev lifecycle
helpers already present in `src/sandboxes/exedev.ts`. Do not hide lifecycle creation inside a Flue
adapter in a way that prevents Neondeck from recording or cleaning it up.

exe.dev setup remains environment-reference based (`EXE_VM_HOST`, `EXE_SSH_KEY`, `EXE_API_TOKEN`,
or configured replacements). Raw secrets are never persisted in task specs, provider records, run
results, or audit metadata.

### Custom SSH provider

The extracted SSH/SFTP transport becomes a built-in `ssh` driver for a user-owned Linux host:

```jsonc
{
  "workspaces": {
    "defaultRemoteProvider": "exe.dev",
    "providers": {
      "exe.dev": { "driver": "exe.dev" },
      "build-box": {
        "driver": "ssh",
        "hostEnv": "NEONDECK_BUILD_BOX_HOST",
        "privateKeyEnv": "NEONDECK_BUILD_BOX_KEY",
        "remoteRoot": "/srv/neondeck/workspaces",
      },
    },
  },
}
```

This is the first custom-remote experience: bring a reachable dedicated host with Git and the
repository's toolchain, register it, pass readiness, then select it on a schedule. Provider-specific
SDK integrations such as E2B, Daytona, Modal, or Cloudflare can later implement the same registry
contract without changing scheduled-task schemas.

## Application-Owned Run Lifecycle

The scheduler remains deterministic application code. A repository-capable occurrence proceeds as
an idempotent, inspectable sequence:

1. Claim the due task and enforce its overlap policy.
2. Resolve the provider and validate current readiness/capabilities.
3. Acquire the task workspace/branch lock.
4. Provision, attach, or reuse the provider resource.
5. Connect through `Sandbox`; clone/fetch the declared repo if needed.
6. Resolve the configured ref to an exact base SHA and persist it before mutation.
7. Create, select, or validate the requested branch/worktree policy.
8. Dispatch a bounded scheduled worker with a sandbox factory closed over the persisted resource.
9. On settlement, collect the final response, command/test evidence, Git status, final SHA, commits,
   and bounded diff/artifact metadata.
10. Apply delivery policy through separate typed tools; never make an ordinary sandbox connection
    imply push authority.
11. Retain or clean up the branch, worktree, and provider resource according to the recorded result.
12. Release locks and settle the scheduled run.

Each transition must be retry-safe by task run id. This is a small scheduled-run state machine, not
a second general workflow engine or a revival of the retired Autopilot coordinator.

The long-running agent submission must not depend on one scheduler tick retaining an in-memory
lease. Admission and settlement correlation use the existing scheduled task run, dispatch key,
session id, and submission id patterns.

## Persistence

Add provider-neutral workspace records rather than overloading the current PR-oriented worktree
row with remote-only meanings.

Suggested application SQLite entities:

### `task_workspaces`

- id, task id, and optional owning run id;
- provider id and opaque provider resource id;
- lifecycle (`per-run`, `reuse-task`, `existing`);
- repo id and workspace root;
- requested ref, revision mode, and Git mode;
- branch name, base SHA, initial SHA, final SHA, and dirty state;
- linked local managed-worktree id when the local provider uses one;
- status, lock owner/expiry, retention reason, and provider error;
- a release fence for an SSH effect whose settlement is unknown;
- created, last-used, retained, cleanup-attempted, and deleted timestamps.

Physical-resource leases persist the exact provider id alongside their canonical resource key,
owner, and expiry. A release-fenced lease is never removed by failure, retention, collection
recovery, or cleanup terminalization. If durable quarantine persistence failed, the fence itself is
listed as an operator-visible quarantine. Explicit clearance atomically removes only the exact
expired lease, quarantine, and inactive fence; active or replaced ownership is refused.
After a managed provider confirms destruction, a separate cleanup-owner transition atomically
verifies the exact live cleanup lease, terminalizes the resource, and removes that lease, its fence,
and quarantine. A stale cleanup owner is refused, and this provider-confirmed transition does not
weaken the expiry requirement for ordinary operator clearance.

### `scheduled_task_runs`

Retain immutable occurrence facts even after workspace cleanup:

- workspace id and provider id;
- resolved base SHA, branch, and final SHA;
- authority and delivery result;
- artifact ids or bounded artifact summary;
- provisioning, preparation, execution, collection, and cleanup timings;
- typed terminal reason when setup fails before Flue dispatch.

V1 persists these facts in a run-keyed workspace snapshot rather than projecting an occurrence
through the mutable reusable workspace row. Provisioning records a deterministic provider intent
before remote side effects, and local worktree creation already records its own durable intent;
restart reconciliation cleans or retains either form before admitting more work.

Provider config remains in runtime config; secret values remain in environment variables. Provider
resource state and cleanup history live in app SQLite. Flue continues to own conversation,
submission, and event persistence only.

## Authority And Security

Scheduled coding tasks cannot wait indefinitely for ordinary per-command prompts, but remote
isolation does not make every command safe. Use explicit workspace authority profiles:

- **read-only** — inspect through bounded file/search tools; no shell, file mutation, or commit.
- **trusted-workspace** — the agent may edit and run arbitrary commands with network access. The
  environment strips known ambient credentials and defaults structured operations to the declared
  workspace, but the shell is not a network or filesystem containment boundary. This is the
  practical mode for unit tests and builds. Its custom Flue tool set retains the standard read,
  write, edit, grep, glob, and bash capabilities; read-only removes the mutating and shell tools.
- **delivery-enabled** — reserved for trusted workspace plus separately configured delivery tools.
  V1 mounts none, so it currently has the same effective shell capabilities as trusted-workspace.

All providers share:

- the unattended-execution policy and run/lease authorization;
- repo/workspace containment for structured file operations and default command cwd, not arbitrary
  shell tokens;
- bounded, redacted command output and env-source audit metadata;
- explicit environment-variable forwarding by name;
- no raw secrets in config or task state;
- credential-free clone URLs derived from repository identity rather than copied local remotes;
- no separately bound Git delivery tool in v1; arbitrary shell remains capable of network access,
  so this is not claimed as a generic-delivery security boundary;
- provider, resource, task, run, branch, and revision correlation on every audit event.

Direct-branch mode gets an additional warning and acknowledgement because it can make the next run
observe the previous run's mutations. Direct push is never inferred from direct checkout.
Pinned mode accepts only a full commit SHA. Persistent task branches pair only with continuation;
latest-from-ref and pinned occurrences use generated run branches or an explicitly acknowledged
direct branch whose checked-out commit must match the resolved pin exactly.

## Output, Artifacts, And Retention

Every occurrence produces a run detail record even when the agent is silent or workspace setup
fails. Capture:

- final agent response and Flue submission link;
- provider and resource identity, with secrets removed;
- requested ref and resolved base SHA;
- branch, final HEAD, clean/dirty status, and commits created;
- commands/checks with bounded stdout/stderr previews and exit status;
- bounded diff summary plus a retained patch or Git bundle when an ephemeral remote contains
  unpushed work;
- delivery, retention, cleanup, and failure reasons.

Cleanup defaults:

- no changes: clean up per-run resources promptly;
- delivered success: clean up after a configurable grace period;
- awaiting review: retain branch/workspace and expose Inspect/Diff actions;
- failed run: retain by default for a bounded debugging window;
- adopted/existing workspace: never delete provider infrastructure automatically;
- operator-triggered cleanup or detach requires explicit confirmation at every public
  service/API/action/UI boundary; automatic post-run cleanup is internal;
- remote teardown: forbidden until required artifacts have been collected successfully.

## UI And API

Scheduled tasks should graduate from a status row into a dedicated section or full detail surface.

### Task editor

Show independent controls for:

- schedule and timezone;
- agent instruction and session continuity;
- workspace: Virtual, Trusted local worktree, exe.dev, or another configured provider;
- resource lifecycle: Fresh each run, Reuse task workspace, Existing workspace;
- revision: Latest from branch, Pinned commit, Continue previous state;
- Git changes: Run branch, Persistent task branch, Direct branch;
- authority: Read only, Trusted workspace, Delivery enabled;
- overlap and retention policies.

Use progressive disclosure. The default repository path is “latest target branch, fresh run branch,
fresh managed workspace.” Direct branch, existing workspace, delivery, custom env forwarding, and
parallelism are advanced settings with inline consequences.

### Task and run detail

Expose:

- next/last run, current phase, duration, and terminal reason;
- provider health and resource retention state;
- `main @ <sha> -> <task branch> -> <final sha>`;
- workspace kind/path identifier and Inspect/Open affordances when locally meaningful;
- final response, logs/checks, commits, and diff;
- Pause, Run now, Retry, Retain, Clean up, and approved delivery actions.

No single “sandbox enabled” toggle should hide these semantics. Provider, lifecycle, revision,
branch, authority, and retention are separate fields in the typed API used by the dashboard and a
future TUI.

## Delivery Sequence

### Package 1 — Provider seam and schema foundation

1. Add the provider registry, descriptors, typed errors, readiness model, and fake provider.
2. Add a provider conformance suite for `Sandbox` path/file/exec behavior, timeout, abort,
   unsupported operations, connection close, and infrastructure teardown separation.
3. Register `local` and the current existing-VM exe.dev path without changing current execution
   behavior.
4. Change execution/task APIs from the closed backend union to validated provider ids while
   preserving `local` and `exe.dev` config compatibility.
5. Add scheduled workspace policy schemas and migrations; legacy scheduled tasks remain virtual.

### Package 2 — Local repository schedules

1. Add task workspace records, occurrence snapshots, and locks.
2. Implement exact-ref resolution and the branch/worktree policy matrix through the existing
   managed-worktree service.
3. Add a scheduled worker that receives the resolved local sandbox instead of the display
   assistant's virtual workspace.
4. Add trusted-workspace shell authority without forwarding ambient credentials or mutating the
   primary checkout, while documenting that local shell is not host-filesystem containment.
5. Collect commits, diffs, command evidence, and cleanup/retention state.

### Package 3 — exe.dev primary remote

1. Extract reusable SSH/SFTP transport primitives from `src/sandboxes/exedev.ts` without changing
   the public exe.dev behavior.
2. Implement exe.dev provider readiness, attach-existing, connect, inspect, and cleanup against the
   registry.
3. Add fresh-per-run and reuse-task lifecycle support through app-owned exe.dev control-plane
   helpers.
4. Implement provider-neutral remote clone/fetch/exact-SHA/branch preparation through `Sandbox`.
5. Add remote artifact collection before teardown and an opt-in real exe.dev smoke script.

### Package 4 — Custom SSH and product UX

1. Register the generic SSH provider with environment-reference-only config.
2. Add provider setup/readiness UI and CLI/API surfaces; recommend exe.dev first.
3. Add the Scheduled Tasks editor, run list, run detail, logs, diff, retention, and cleanup controls.
4. Add migration guidance for existing `execution.exeDev` users and update product documentation.
5. Reconcile `.plans/EXEDEV_WORKSPACE_MODE_PLAN.md` against Flue 2.0.3 and this provider seam before
   implementing any global workspace-location switch.

## Verification

Automated coverage:

- schema compatibility for existing virtual tasks and current exe.dev config;
- provider registry duplicate ids, unknown drivers, capability mismatch, and no-fallback behavior;
- shared `Sandbox` conformance fixtures for fake, local, exe.dev transport, and generic SSH;
- exact branch-to-SHA resolution and immutable run recording;
- per-run branch uniqueness and persistent task-branch continuity;
- reused workspace clean, dirty, retained, stale-lock, and failed-cleanup cases;
- direct-branch validation and overlap serialization;
- no access to the user's primary checkout for autonomous local mutations;
- remote connection failure, command timeout, possible orphan settlement, and sandbox death;
- artifact capture before remote teardown, including an unpushed commit;
- authority separation between edit/test, commit, and push;
- scheduler restart between admission and Flue settlement;
- dashboard/API projection of setup failure, active run, retained diff, and cleanup state.

Use temporary repos/worktrees and fake providers for normal tests. No automated test requires a real
exe.dev account or external network. A credential-gated smoke test verifies one real exe.dev
workspace lifecycle and is never part of the default unit suite.

Run at each package boundary:

```sh
npm run check
npm run test:integration
npm run db:check
```

Run `npm run verify` before the final package is considered complete.

## Definition Of Done

- A user can create a repository-capable scheduled task and independently choose provider,
  resource reuse, revision, branch, authority, overlap, and retention policies.
- A task can safely follow the latest `main`, continue a persistent task branch, or explicitly use
  a dedicated direct-`main` workspace.
- Local schedules run in Neondeck-managed worktrees; exe.dev schedules run on a recorded exe.dev
  resource; neither silently touches the other location.
- exe.dev is the recommended and fully tested remote setup, including existing and app-managed
  lifecycle modes.
- A user can configure a custom SSH Linux workspace and run the same scheduled task contract there.
- Adding another SDK-backed remote requires a provider adapter and conformance tests, not scheduler
  or scheduled-task schema branches.
- Every run retains inspectable output and exact Git/provider identity, including before an
  ephemeral remote is destroyed.
- Historical run detail exposes the immutable repository id, canonical GitHub owner/name, path,
  provider id, and provider resource id captured for that occurrence; later workspace reuse cannot
  rewrite those values.
- Failed and reviewable work is retained; successful/no-op work follows explicit cleanup policy;
  adopted resources are never automatically destroyed.
- Permission and delivery authority remain consistent across local, exe.dev, and custom providers.
- The dashboard and future TUI can use the same typed backend command/event surface.

## Deferred Questions

- Whether externally packaged provider adapters should load in-process, through a plugin worker, or
  through an MCP-like out-of-process boundary. Do not choose this until Neondeck has a general
  plugin trust and upgrade model.
- Provider adapter/config snapshots are first-class per-workspace persistence. They contain only
  validated configuration and environment-variable references, never secret values. Cleanup,
  recovery, and sandbox creation use the admitted snapshot so later config changes cannot switch
  adapters underneath a durable resource.
- Whether persistent task branches should optionally publish to a hidden remote namespace. Keep
  local/provider-only persistence until a concrete cross-resource continuation need appears.
- Whether one schedule can fan out across several providers. v1 selects exactly one provider per
  occurrence.
