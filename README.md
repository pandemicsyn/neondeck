# neondeck

Local companion-display dashboard and Flue agent server for the Corsair Xeneon Edge.

neondeck is a local-first Node 26 app with a Hono/Flue backend and a Vite/React/Tailwind dashboard optimized for a 2560 x 720 display. It provides a compact GitHub PR queue, active PR watches, runtime state panels, persistent Flue chat sessions, and a terminal-style host status line.

The repository also includes an Astro marketing/docs site under `webapp/`, deployed to Cloudflare for `neondeck.dev`.

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
npm run cli -- repo add ~/dev/neondeck
npm run cli -- watch-pr pandemicsyn/neondeck#123 --until prod
npm run cli -- schedule --morning-briefing
npm run cli -- tui
```

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

The runtime home contains `.env`, `config.json`, `repos.json`, `dashboard.json`, `schedules.json`, `SOUL.md`, `skills/`, and separate `data/neondeck.db` and `data/flue.db` databases. The repo-local `config/dashboard.json` and `SOUL.md` files are defaults for new homes; edit the runtime-home copies for local customization.

You can initialize or validate the runtime home explicitly without starting the server:

```sh
npm run setup
npm run setup -- --home ./data/dev-home
```

For new installs, prefer `npm run init`; `npm run setup` is the lower-level non-interactive runtime-home initializer.

The built-in Neondeck guidance is an application-owned Flue skill at `src/skills/neondeck/SKILL.md`. User runtime skills live under `skills/<skill-id>/SKILL.md`; valid user skills from that root, plus external skill roots from `config.json`, are registered as Flue skills when the agent initializes. Start a new session or restart the server after changing runtime skills. Treat runtime skill directories as trusted input; do not put secrets in skill resources.

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

The Neondeck chat agent can update those model and thinking settings through the typed `neondeck_config_update_agent_models` action when asked. Model strings must use allowlisted provider-qualified names such as `kilocode/...`, `openai/...`, or `anthropic/...`. `models.utility` is optional; if skipped, Neondeck falls back to the display assistant and recommends configuring a cheaper model for short titles, summaries, notification text, and compact classification. Provider config stores environment variable names only; raw secrets stay in `.env`.

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
      "apiTokenEnv": "EXE_API_TOKEN"
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

Kilo tasks are stored in `data/neondeck.db` as `kilo_tasks` and `kilo_task_events`. The runner starts `kilo run <prompt> --dir <workspace> --title <title> --format json` in a configured repo or Neondeck-managed worktree, captures JSONL stdout/stderr and session ids, and exposes task/session read/search actions plus `/api/kilo/*` routes. `--auto` requires explicit confirmation and is limited by policy; prefer managed worktrees for code-changing handoffs.

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

Supported commands include `/repo-status`, `/review-queue`, `/briefing`, `/reasoning [level]`, `/dev-doctor`, `/watch-pr <ref>`, and `/watch-release <repo>`. A `/reasoning` command shows the current display-assistant reasoning level; `/reasoning high` changes it to a level supported by the selected model and starts a fresh Neon session. A `/watch-pr` command creates a persistent PR watch, polls for merge/check changes, and shows it in the active watches panel. `/watch-release` tracks default-branch GitHub checks until green; `/watch-pr ... until prod` waits for the source PR to merge, then tracks the source PR merge SHA until checks are green. `/dev-doctor` checks local repo health, package scripts, Node version, env keys, dev ports, API health, and runtime databases. Runtime home, repository, scheduler job, and skill state are shown in the runtime overview panel. Results are stored in `workflow_summaries` and exposed at `/api/workflows/summaries`.

Dashboard panels subscribe to `/api/events/config` for local config action and reload events, so model/provider/repo/schedule/dashboard changes refresh affected surfaces without a browser reload.

Dashboard layout is configured by `dashboard.json` and validated by `dashboard.schema.json`. The statusline is a single top or bottom strip; main regions are tab stacks. Neon can apply known layouts through `neondeck_config_apply_dashboard_preset` (`classic` or `cockpit`) or replace the full validated layout through `neondeck_config_update_dashboard_layout`.

## Build

```sh
npm run typecheck
npm run build
npm start
```

## Marketing/docs site

```sh
npm run webapp:dev
npm run webapp:astro-dev
npm run webapp:build
npm run webapp:preview
npm run webapp:deploy
```

The Cloudflare deployment config is `webapp/wrangler.jsonc`.
