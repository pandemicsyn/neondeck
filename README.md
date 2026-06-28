# neondeck

Local companion-display dashboard and Flue agent server for the Corsair Xeneon Edge.

neondeck is a local-first Node 26 app with a Hono/Flue backend and a Vite/React/Tailwind dashboard optimized for a 2560 x 720 display. It provides a compact GitHub PR queue, active PR watches, runtime state panels, persistent Flue chat sessions, and a terminal-style host status line.

The repository also includes an Astro marketing/docs site under `webapp/`, deployed to Cloudflare for `neondeck.dev`.

## Requirements

- Node 26.4.0, managed with `fnm`
- A Kilo API key for the default Flue provider
- A GitHub token for the PR panel

```sh
fnm install 26.4.0
fnm use 26.4.0
npm install
```

## Configure

Copy `.env.example` to `.env` and fill in the local secrets:

```sh
KILOCODE_API_KEY=...
KILOCODE_ORGANIZATION_ID=...
FLUE_AGENT_MODEL=kilocode/kilo/auto
GITHUB_TOKEN=...
GITHUB_LOGIN=...
```

On first run, neondeck creates a local runtime home and seeds it from the repo defaults:

```text
NEONDECK_HOME
XDG_CONFIG_HOME/neondeck
~/.config/neondeck
```

The runtime home contains `config.json`, `repos.json`, `dashboard.json`, `schedules.json`, `SOUL.md`, `skills/`, and separate `data/neondeck.db` and `data/flue.db` databases. The repo-local `config/dashboard.json` and `SOUL.md` files are defaults for new homes; edit the runtime-home copies for local customization.

You can initialize or validate the runtime home explicitly without starting the server:

```sh
npm run setup
npm run setup -- --home ./data/dev-home
```

The built-in Neondeck guidance is an application-owned Flue skill at `src/skills/neondeck/SKILL.md`. User runtime skills live under `skills/<skill-id>/SKILL.md`; valid user skills from that root, plus external skill roots from `config.json`, are registered as Flue skills when the agent initializes. Start a new session or restart the server after changing runtime skills. Treat runtime skill directories as trusted input; do not put secrets in skill resources.

Agent and subagent models are configurable in runtime-home `config.json`. Environment variables remain a fallback, but checked-in defaults should live in config:

```json
{
  "version": 1,
  "skillRoots": ["/absolute/path/to/skills"],
  "models": {
    "displayAssistant": "kilocode/kilo/auto",
    "subagents": {
      "default": "kilocode/kilo/auto",
      "repoResearcher": "kilocode/kilo/auto",
      "ciInvestigator": "kilocode/kilo/auto",
      "releaseReviewer": "kilocode/kilo/auto"
    }
  }
}
```

The Neondeck chat agent can update those model settings through the typed `neondeck_config_update_agent_models` action when asked. Model strings must reference providers already registered by the app or Flue runtime; changing provider credentials or registering arbitrary new providers is not yet a runtime-config action.

Host execution is also configured in runtime-home `config.json`, but Neondeck does not expose an unrestricted shell executor. The policy is an approval gate for current and future execution actions. `local` is the default backend; `exe.dev` is accepted as a planned sandbox backend so config can be shaped before that executor lands.

```json
{
  "version": 1,
  "execution": {
    "defaultBackend": "local",
    "enabledBackends": ["local"],
    "approvalMode": "manual",
    "unattended": "deny",
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

Preapproved commands must be single commands without shell operators such as `&&`, `|`, redirection, subshells, or newlines. Commands outside the preapproval list require interactive approval in future executor actions and are denied in unattended contexts. Hardline destructive commands cannot be preapproved. Neon can inspect or update this policy through `neondeck_execution_policy_lookup`, `neondeck_execution_policy_check`, and `neondeck_config_update_execution_policy`; policy updates are audited in `config_history`.

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

Supported commands are `/repo-status`, `/review-queue`, `/briefing`, `/dev-doctor`, `/watch-pr <ref>`, and `/watch-release <repo>`. A `/watch-pr` command creates a persistent PR watch, polls for merge/check changes, and shows it in the active watches panel. `/watch-release` tracks default-branch GitHub checks until green; `/watch-pr ... until prod` waits for the source PR to merge, then tracks the source PR merge SHA until checks are green. `/dev-doctor` checks local repo health, package scripts, Node version, env keys, dev ports, API health, and runtime databases. Runtime home, repository, scheduler job, and skill state are shown in the runtime overview panel. Results are stored in `workflow_summaries` and exposed at `/api/workflows/summaries`.

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
