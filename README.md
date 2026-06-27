# neondeck

Local companion-display dashboard and Flue agent server for the Corsair Xeneon Edge.

neondeck is a local-first Node 26 app with a Hono/Flue backend and a Vite/React/Tailwind dashboard optimized for a 2560 x 720 display. It provides a compact GitHub PR queue, persistent Flue chat sessions, and a terminal-style host status line.

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

Runtime skills live under `skills/<skill-id>/SKILL.md`. Neondeck seeds `skills/neondeck/SKILL.md`, loads valid user skills from the same root, and can read additional skill roots from `config.json`:

```json
{
  "version": 1,
  "skillRoots": ["/absolute/path/to/skills"]
}
```

## Run

```sh
npm run dev
```

Open `http://127.0.0.1:5173/`.

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
