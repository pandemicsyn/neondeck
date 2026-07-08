# neondeck

Local-first autonomous developer assistant for companion displays and sensor-panel style decks.

neondeck is a Node 26 app with a Hono/Flue backend and a Vite/React/Tailwind dashboard designed to live full time beside your work: on a companion display, on a vertical panel, or as a sensor-panel style deck on your primary monitor. It provides an autonomous local assistant, compact GitHub work queues, active PR watches, runtime state panels, persistent Flue chat sessions, and a terminal-style host status line.

The dashboard supports horizontal and vertical use, from 32:9 ultrawides like the Corsair Xeneon Edge to custom layouts that Neon can adapt through validated runtime config.

The repository also includes an Astro marketing/docs site under `docs/`, deployed to Cloudflare for `neondeck.dev`.

## Requirements

- Node 26.4.0, managed with `fnm`
- A KiloCode, OpenAI, or Anthropic API key for the configured Flue model provider
- A GitHub token for the PR panel

```sh
fnm install 26.4.0
fnm use 26.4.0
npm install
```

## First Run

Run the guided CLI setup:

```sh
npm run init
```

The wizard prepares the runtime home, writes local secrets to `$NEONDECK_HOME/.env`, tunes `SOUL.md`, configures the selected model provider, optionally sets a low-cost utility model, adds local git checkouts, applies a dashboard preset, and optionally creates schedules and command preapprovals. When KiloCode is selected, init can discover and search available KiloCode models before writing the default model config.

The same CLI is the foundation for future command-and-control surfaces, including an OpenTUI client:

```sh
npm run cli -- status
npm run cli -- db status
npm run cli -- repo add ~/dev/neondeck
npm run cli -- watch-pr pandemicsyn/neondeck#123 --until prod
npm run cli -- schedule --morning-briefing
npm run cli -- tui
```

For the installed-app path after a production build or package install:

```sh
neondeck service install
neondeck open
neondeck open sidebar
```

`neondeck service install` creates a macOS launchd agent or Linux systemd user unit with absolute Node and built server entry paths and logs under runtime-home `data/logs/server.log`. `neondeck open` probes `/api/health`, starts the installed service when present, falls back to a detached built server process when no service exists, and opens a dedicated Chromium app-mode window when Chrome/Edge/Brave/Chromium is available. The dashboard also ships a PWA manifest, so Safari Add to Dock and Chrome/Edge Install create a standalone Neondeck app window with remembered bounds.

`neondeck serve` and the login service run the built Flue server entry from
`dist/server.mjs`; from a source checkout, use `npm run dev` for the fast loop
or run `npm run build:server` before testing the packaged path.

## Configure

For packaged/local app use, secrets live in the runtime home:

```text
$NEONDECK_HOME/.env
```

`npm run init` creates and manages that file. For checkout-based development, you may also copy `.env.example` to repo-root `.env`; Neondeck treats repo `.env` as a dev-only fallback when the runtime-home file does not define a value.

```sh
KILOCODE_API_KEY=...
KILOCODE_ORGANIZATION_ID=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GITHUB_TOKEN=...
GITHUB_LOGIN=...
```

On first run, neondeck creates a local runtime home and seeds it from the repo defaults:

```text
NEONDECK_HOME
XDG_CONFIG_HOME/neondeck
~/.config/neondeck
```

The runtime home contains `.env`, `config.json`, `mcp.json`, `repos.json`, `dashboard.json`, `schedules.json`, `SOUL.md`, `skills/`, and separate `data/neondeck.db` and `data/flue.db` databases. Neondeck app database migrations are shipped with the package and auto-apply before app code touches `data/neondeck.db`; pre-migration backups are kept under `data/backups/`. `npm run cli -- db status` reads the migration journal, shipped head, pending entries, and latest backup path. `config.json` includes a generated `localApi.token` used by the local dashboard for guarded raw Flue run inspection. The repo-local `config/dashboard.json` and `SOUL.md` files are defaults for new homes; edit the runtime-home copies for local customization.

You can initialize or validate the runtime home explicitly without starting the server:

```sh
npm run setup
npm run setup -- --home ./data/dev-home
```

For new installs, prefer `npm run init`; `npm run setup` is the lower-level non-interactive runtime-home initializer.

The built-in Neondeck guidance is an application-owned Flue skill at `src/skills/neondeck/SKILL.md`. User runtime skills live under `skills/<skill-id>/SKILL.md`; valid user skills from that root, plus external skill roots from `config.json`, are registered as Flue skills when the agent initializes. Start a new session or restart the server after changing runtime skills. Treat runtime skill directories as trusted input; do not put secrets in skill resources. Learning can propose or apply audited skill patch candidates for the built-in `neondeck` skill and user skills under `NEONDECK_HOME/skills`; external and bundled third-party skills are not patched by the initial learning loop. Applied skill patches can be restored from retained audit data with `POST /api/skills/patches/:id/restore` or `neondeck learning restore-skill-patch <id>` when the current file still matches the applied patch.

Chat sessions are indexed in `data/neondeck.db` while Flue remains the owner of `display-assistant/:id` transcripts. Neondeck stores titles, linked repo/watch/task metadata, compact summaries, stale-context badges, and audit records so agents and dashboard rows can reference other sessions without reading raw transcript pages by default. Raw transcript access is audited and requires an explicit user request.

External local agents can hand work to Neon without gaining execution or approval powers. After pushing a PR, a tool such as Claude Code, Codex, Kilo, or a git hook can run `neondeck register-pr owner/repo#123 --from codex --note "adds retry logic" --json`; significant non-PR work can use `neondeck note "..." --from codex --repo neondeck --level ready --json`. The localhost-only `/api/handoff/*` mirror requires a `source` field for curl-based local hooks. Handoff creates attributed watches, notifications, and release watches; `register-pr --review` can queue the bounded PR review workflow only when `handoff.allowExternalReviewQueue` in runtime-home `config.json` permits it. Handoff does not execute commands, approve work, push, submit GitHub reviews, or mutate provider settings. The external-agent skill lives at `skills/neondeck-handoff/SKILL.md`; copy that folder into a local agent skill root such as `~/.claude/skills/` when you want another agent to register work automatically.

Agent, utility, and subagent models are configurable in runtime-home `config.json`. Environment variables remain a fallback, but checked-in defaults should live in config:

```json
{
  "version": 1,
  "skillRoots": ["/absolute/path/to/skills"],
  "models": {
    "displayAssistant": "kilocode/kilo-auto/balanced",
    "displayAssistantThinkingLevel": "medium",
    "utility": "kilocode/kilo-auto/fast",
    "utilityThinkingLevel": "low",
    "selfImprovement": "kilocode/kilo-auto/fast",
    "selfImprovementThinkingLevel": "low",
    "subagents": {
      "default": "kilocode/kilo-auto/balanced",
      "defaultThinkingLevel": "medium",
      "repoResearcher": "kilocode/kilo-auto/balanced",
      "repoResearcherThinkingLevel": "medium",
      "ciInvestigator": "kilocode/kilo-auto/balanced",
      "ciInvestigatorThinkingLevel": "medium",
      "releaseReviewer": "kilocode/kilo-auto/balanced",
      "releaseReviewerThinkingLevel": "medium"
    }
  },
  "providers": {
    "kilocode": {
      "enabled": true,
      "apiKeyEnv": "KILOCODE_API_KEY",
      "organizationIdEnv": "KILOCODE_ORGANIZATION_ID"
    },
    "openai": {
      "enabled": true,
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "anthropic": {
      "enabled": true,
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }
}
```

The Neondeck chat agent can update those model and thinking settings through the typed `neondeck_config_update_agent_models` action when asked. Model strings must use allowlisted provider-qualified names such as `kilocode/...`, `openai/...`, or `anthropic/...`. `models.utility` is optional; if skipped, Neondeck falls back to the display assistant and recommends configuring a cheaper model for short titles, summaries, notification text, and compact classification. `models.selfImprovement` is optional, falls back through the utility and display-assistant model, and is used for bounded conversation reflection, memory curation, and PR/autopilot retrospectives. Provider config stores environment variable names only; raw secrets stay in `.env`.

Structured memory is current guidance, not a transcript archive. New memory writes use `user`, `local`, and `project` scopes only; legacy `session` and `watch` memory rows remain readable but are not created by learning actions. Memory rows are either `active` or `archived`; archived rows stay in audit history but do not load into new session prompts. Memory curation is configured under `learning.memoryCurationEnabled`, `learning.memoryCurationMode`, `learning.memoryCurationTurnInterval`, and `learning.memoryMaxActiveItems`. PR/autopilot retrospectives are configured under `learning.prRetrospectiveThreshold` and review compact handled-event, workflow, prepared-diff, verification, notification/recovery, Kilo, memory, and skill summaries after durable PR outcomes. Memory writes and applied skill patches update SQLite immediately and mark sessions stale, but active prompt context changes only after a new session or explicit context refresh.

Host execution is also configured in runtime-home `config.json`, but Neondeck does not expose an unrestricted shell executor. `neondeck_execution_run` gates all local and `exe.dev` commands through policy, approvals, and the `execution_approvals` audit log. `local` is the default backend; `exe.dev` uses the Flue sandbox adapter against an existing VM.

```json
{
  "version": 1,
  "execution": {
    "defaultBackend": "local",
    "enabledBackends": ["local"],
    "approvalMode": "manual",
    "unattended": "deny",
    "exeDev": {
      "lifecycle": "existing-vm",
      "vmHostEnv": "EXE_VM_HOST",
      "sshKeyEnv": "EXE_SSH_KEY",
      "apiTokenEnv": "EXE_API_TOKEN",
      "remoteRoot": "/home/user/neondeck/checkouts",
      "repos": {
        "neondeck": {
          "env": {
            "enabled": true,
            "files": [".env.exe"],
            "vars": {
              "NEONDECK_PROFILE": "sandbox"
            },
            "hostEnv": {
              "GITHUB_TOKEN": "GITHUB_TOKEN"
            }
          }
        }
      },
      "checkouts": {
        "worktree-id": {
          "remotePath": "/home/user/neondeck/checkouts/neondeck-pr-123"
        }
      }
    },
    "preapprovedCommands": [
      {
        "id": "test",
        "command": "npm test",
        "match": "exact",
        "backends": ["local"],
        "description": "Run the repo test suite."
      }
    ]
  }
}
```

Preapproved commands must be single commands without shell operators such as `&&`, `|`, redirection, subshells, or newlines. Commands outside the preapproval list require interactive approval and are denied in unattended contexts. Hardline destructive commands cannot be preapproved. Neon can inspect policy through `neondeck_execution_policy_lookup` and `neondeck_execution_policy_check`, update policy through `neondeck_config_update_execution_policy`, request approvals through `neondeck_execution_request_approval`, and run approved commands through `neondeck_execution_run`. Approval resolution is dashboard/API/user-owned, not model-callable. Policy updates are audited in `config_history`; executions are audited in `execution_approvals`.

Trusted-local execution runs on your machine and is best for local git/dev commands you already trust. `exe.dev` is the isolated sandbox option; enable it explicitly by adding `"exe.dev"` to `enabledBackends` after `EXE_VM_HOST` points at an existing VM and SSH auth is configured.

## MCP servers

Neondeck can register local stdio and remote HTTP MCP servers from runtime-home `mcp.json`. MCP tools are exposed to Neon as Flue tools named `mcp__<server>__<tool>`, but each third-party tool result is treated as untrusted data and gated by exact per-server policy. Tools default to ask; `tools.autoApprove` and `tools.deny` are exact original MCP tool names.

```json
{
  "servers": {
    "linear": {
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "auth": { "kind": "oauth" }
    },
    "local-tools": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "tools": {
        "deny": ["dangerous_tool"]
      }
    }
  }
}
```

Secrets are never stored directly in `mcp.json`. Header-authenticated servers use environment-variable references, and OAuth access/refresh tokens are stored only in `data/neondeck.db`.

```json
{
  "servers": {
    "internal": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "auth": {
        "kind": "header",
        "headers": {
          "Authorization": { "env": "INTERNAL_MCP_AUTHORIZATION" }
        }
      }
    }
  }
}
```

Manage servers with the CLI, local API, direct `mcp.json` edits, or safe HTTP/OAuth chat actions:

```sh
neondeck mcp list
neondeck mcp add linear --url https://mcp.linear.app/mcp --oauth
neondeck mcp login linear
neondeck mcp tools linear
neondeck mcp approvals
neondeck mcp approvals --resolve <id> --approve
neondeck mcp logout linear --confirm
```

Stdio servers, header-authenticated servers, and MCP auto-approval policy are user-owned surfaces because they can spawn host processes or forward environment-backed secrets. Configure those through the CLI, local API, or `mcp.json`, not through model-callable actions. Pending MCP tool approvals and OAuth login/logout appear in Runtime Overview.

Use `neondeck_exedev_checkout_sync` to clone or sync a configured repo or Neondeck-managed worktree on the existing VM. If a sync step needs approval, approve the returned execution request and retry with `approvals[blockedStep]` set to that approval id. Then call `neondeck_execution_run` with `repoId` or `worktreeId` so the remote cwd resolves to that checkout. Env forwarding is opt-in per global/repo/checkout config. Enabled sources can include repo-relative `.env` files, literal config `vars`, and explicitly mapped host env variables. Neondeck does not filter forwarded variable names by heuristic; execution audit metadata records which sources and keys were used, not the values.

Autopilot PR work uses managed worktrees as the isolation boundary. Prepared diffs remain backed by the retained source worktree, and push-back is allowed only after prepared-diff approval, passed verification, autopilot policy, clean committed state, and GitHub branch permission checks all pass. The local API exposes `/api/autopilot/state`, `/api/prepared-diffs`, `/api/prepared-diffs/:id/recovery`, and `/api/prepared-diffs/:id/recovery/run` for dashboard/TUI-style inspection and bounded recovery. Recovery can inspect the retained worktree, retry after a new PR commit by rebasing/resyncing the clean worktree, retry verification, retry push, retry the result comment, request revision, abandon with confirmation, clean up the worktree through cleanup policy with confirmation, or surface manual follow-up; each option dispatches to the same typed backend services used by Flue actions.

Autopilot notifications are deduped by deterministic source ids. Prepared review/CI fixes, passed verification, pushed commits, and posted result comments are `ready`. Blocked verification, push-blocked states, failed result comments, and unexpected autopilot workflow failures are `attention`. Repeated retries update the existing unresolved notification count, while a new state such as failed verification later passing creates a separate actionable notification with recovery metadata.

Handled PR/autopilot outcomes are also counted for learning with idempotent `pr_handled` source ids. Accounting covers Flue workflow observations and direct local API action routes for autopilot preparation/fixes, prepared-diff verification/push, result comments, recovery actions, and Kilo review/verify/promote decisions. When the handled-event count reaches `learning.prRetrospectiveThreshold`, or when `POST /api/learning/reviews/prs` is called manually, `review_pr_batch_for_learning` can propose project/local memory and skill patch candidates. Inspect the consolidated operator view with `GET /api/learning/state`, the Learning dashboard tab, or `neondeck learning status`. Candidates can be applied/rejected through `GET /api/learning/candidates`, `GET /api/skills/patches`, matching local API routes, or `neondeck learning approve|reject <id>`. Applied skill patches can be restored with `POST /api/skills/patches/:id/restore` or `neondeck learning restore-skill-patch <id>` when the audited target file is unchanged.

To disable autopilot quickly, set global `config.json` `autopilot.defaultMode` to `notify-only` or override the repo `metadata.autopilot.mode` to `notify-only`, then remove any PR watches that should stop producing notifications. Direct push-back is off unless policy, approval, checks, and GitHub permissions all allow it; force-push remains disabled by default.

KiloCode handoff is available only as an explicit delegated-worker path. Neon should normally do work itself or use Neondeck subagents unless the user asks for Kilo or a future repo policy opts in. Optional runtime-home `config.json` settings:

```json
{
  "version": 1,
  "kilo": {
    "enabled": true,
    "cliPath": "kilo",
    "defaultMode": "patch-proposal",
    "autoPolicy": "managed-worktree-draft-fix",
    "explicitHandoffOnly": true,
    "concurrency": 1,
    "rawLogRetentionDays": 14,
    "repos": {
      "neondeck": "allow"
    }
  }
}
```

Kilo tasks are stored in `data/neondeck.db` as `kilo_tasks`, `kilo_task_events`, `kilo_result_state`, and `kilo_result_events`. The runner starts `kilo run <prompt> --dir <workspace> --title <title> --format json` in a configured repo or Neondeck-managed worktree, captures JSONL stdout/stderr and session ids, and exposes task/session read/search actions plus `/api/kilo/*` routes. `review_kilo_result` classifies completed diffs, `verify_kilo_result` runs configured checks through the execution approval policy, and `promote_kilo_result` records only the safe promotion admission decision. It does not commit, push, or comment yet. `--auto` requires explicit confirmation and is limited by policy; prefer managed worktrees for code-changing handoffs.

Kilo handoff notifications are reconciled by delegated task and state. Started/running progress updates stay quiet and deduped, completed/verified/promoted results are `ready`, and failures, timeouts, waiting approvals, needs-review, and promote-blocked states are `attention`. The Kilo task API and Runtime Overview rows include linked notification facts, result placeholders, pending approvals, verification state, and prepared-diff ids so Neon and the dashboard can report the current gate without reading Kilo storage directly.

## Run

```sh
npm run dev
```

Open `http://127.0.0.1:5173/`.

Neon command workflows can be run from the chat panel buttons, typed into chat, or invoked through Flue:

```sh
curl -X POST 'http://127.0.0.1:5173/api/flue/workflows/command-run?wait=result' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"command":"/briefing"}}'
```

Supported commands include `/repo-status`, `/review-queue`, `/review-pr <ref>`, `/fix-ci [ref]`, `/explain-ci [--report] [ref]`, `/summarize-pr [ref]`, `/draft-pr-description [repo]`, `/prepare-pr [repo]`, `/review-local [repo]`, `/briefing`, `/reasoning [level]`, `/memory ...`, `/dev-doctor`, `/watch-pr <ref>`, and `/watch-release <repo>`. A `/reasoning` command shows the current display-assistant reasoning level; `/reasoning high` changes it to a level supported by the selected model and starts a fresh Neon session. A `/watch-pr` command creates a persistent PR watch, polls for merge/check changes, and shows it in the active watches panel. `/watch-release` tracks default-branch GitHub checks until green; `/watch-pr ... until prod` waits for the source PR to merge, then tracks the source PR merge SHA until checks are green. `/review-pr` prepares local reports and Neon-origin draft review comments for a human reviewer without submitting a GitHub review. `/fix-ci` writes a CI failure dossier and routes any agent-produced fix through prepared-diff review; `/explain-ci --report` writes the dossier without starting the fix attempt. `/dev-doctor` checks local repo health, package scripts, Node version, env keys, dev ports, API health, and runtime databases. Runtime home, repository, MCP servers/approvals, scheduler job, and skill state are shown in the runtime overview panel. Results are stored in `workflow_summaries` and exposed at `/api/workflows/summaries`.

Busywork automation writes durable local reports for PR review assistance, CI failure dossiers, docs drift, issue triage, hygiene, and routine runs. The dashboard Reports panel lists them, individual artifacts are served from `/reports/:id`, and docs-drift reports can stage a bounded docs fix into the prepared-diff review loop. Routines are user-defined scheduled Neon tasks with a prompt, optional runtime skills, optional repo/cwd scope, and notification/report/session delivery. Manage them from the Routines panel, `/api/routines`, or typed `neondeck_routine_*` actions; the global routines config can pause the subsystem, and agent-created routines are capped and guarded by minimum intervals.

Dashboard PR, watch, repo, briefing, Kilo, and autopilot rows include session affordances that create or open linked chat sessions. The chat panel also has a compact reference control for the active session; it refreshes summary metadata and records cross-session context use without forcing side-by-side chat.

GitHub PR review rows support inline draft comments, thread replies/resolution, and one-review submit from the dashboard. Compact deck layouts keep the review controls tight; use the PR review pop-out button or `neondeck open` when a full review needs a wider window.

Dashboard panels subscribe to `/api/events/config` for local config action and reload events, so model/provider/repo/schedule/dashboard changes refresh affected surfaces without a browser reload.

Dashboard layout is configured by `dashboard.json` and validated by `dashboard.schema.json`. The statusline is a single top or bottom strip; main regions are tab stacks. Neon can apply known layouts through `neondeck_config_apply_dashboard_preset` (`classic` or `cockpit`) or replace the full validated layout through `neondeck_config_update_dashboard_layout`.

Desktop window profiles live under `dashboard.json` `windows`. `neondeck open sidebar` and `neondeck open xeneon` use those profiles as launch-time Chromium app-mode geometry; installed PWA windows instead remember their own size and position.

## Build

```sh
npm run typecheck
npm run build
npm start
```

## Test

```sh
npm run check
npm run test:integration
npm run test:all
npm run verify
```

`npm run check` is the fast local loop: lint, typecheck, and the unit Vitest
suite. The slower git/worktree/Kilo/autopilot workflow coverage lives under
`npm run test:integration`, while `npm run test:all` runs every Vitest suite.
`npm run verify` keeps the full pre-release path: lint, typecheck, all tests,
format check, and production builds.

## Publishing

Use npm's built-in semver-aware version command for now:

```sh
npm version patch
npm version minor
npm version major
```

That updates `package.json` and `package-lock.json`, creates a `v*` git tag,
and gives the publish workflow a stable release ref. Push the version commit and
tag together:

```sh
git push origin main --follow-tags
```

The npm release path is separate from the GitHub app archive release:

- `.github/workflows/npm-package.yml` validates the packed npm artifact on PRs.
- `.github/workflows/npm-publish.yml` verifies the release tag, runs
  `npm run release:npm:check`, and publishes `neondeck` to npm from `v*` tags.

For the first npm publish, the package may need to be created once before npm
trusted publishing can be configured. Either publish the first version locally
with npm 2FA, or set a temporary GitHub Actions `NPM_TOKEN` secret with publish
access and run the publish workflow for the first tag. After `neondeck` exists on
npm, configure trusted publishing for GitHub Actions with workflow filename
`npm-publish.yml`, environment `npm`, and allowed action `npm publish`, then
revoke the temporary token if one was used.

## Marketing/docs site

```sh
npm run docs:dev
npm run docs:astro-dev
npm run docs:build
npm run docs:preview
npm run docs:deploy
```

The Cloudflare deployment config is `docs/wrangler.jsonc`.
