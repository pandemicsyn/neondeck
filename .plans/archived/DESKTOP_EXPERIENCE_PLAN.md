# Desktop Experience Plan: service install, PWA, `neondeck open`

Status: **active** — planning doc for making Neondeck feel like an installed app without adopting a
desktop shell: a first-class background service, a PWA manifest for window identity, and a
`neondeck open` launcher with window geometry profiles. Written 2026-07-04 for implementation
agents; sibling to the other `.plans/` docs and following their conventions. Tauri is the
documented future escalation, not part of this plan.

## Purpose

Neon is an always-ready agent, but today it feels like a dev server: you start it by hand, and the
dashboard lives inside a general-purpose browser window. Two consequences hurt:

- **No window identity.** Open the dashboard in Safari, resize it into a vertical sidebar, and
  Safari now opens _all_ new tabs/windows in that geometry — the dashboard shares the browser's
  window management instead of owning its own.
- **No lifecycle.** Nothing keeps the server running across logins/reboots, so "always-ready" is
  really "ready since you last remembered to start it".

Electron would fix both, but it inverts the product's shape (the server must outlive any window)
and adds a second distribution channel next to `npm install neondeck`. This plan delivers the same
felt experience with the architecture we already have:

1. **`neondeck service install`** — the server as a real login service (launchd/systemd).
2. **PWA manifest** — the dashboard installs as its own app with its own dock icon and its own
   remembered window size/position (Safari "Add to Dock", Chrome/Edge install).
3. **`neondeck open [profile]`** — one command that ensures the server is up and opens the
   dashboard in a dedicated app-mode window, optionally at named geometry (sidebar, kiosk on the
   Xeneon).

## Ground Rules (verified against the codebase, 2026-07-04)

- **The API server defaults to `127.0.0.1:3583`** (`web/vite.config.ts` proxies to
  `NEONDECK_API_PROXY ?? 'http://127.0.0.1:3583'`); the production server serves the built
  dashboard itself (`serveStatic` from `web/dist` in `src/server/app.ts`), so the PWA and `open`
  target the same origin as the API. `GET /api/health` exists and is the readiness probe.
- **The refactor landed**: the server lives in `src/server/` and the CLI in `src/cli/`
  (commander program in `src/cli/index.ts` with per-area modules). New commands follow that
  module pattern. There is currently **no `neondeck serve`** production-start command — `npm start`
  runs `node dist/server.mjs` from a checkout/tarball. This plan adds `serve` as the primitive
  the service wraps.
- **The UI is already sidebar-ready.** `web/src/lib/deck-profile.ts` measures the shell and flows
  between `ultrawide | wide | portrait | compact` arrangements. A narrow vertical window already
  renders a proper column layout. The missing piece is purely window identity/geometry.
- **Env loading exists** (`loadNeondeckEnv` in `src/env.ts`, runtime-home `.env`), and
  runtime-home owns paths for logs/data. Native notifications
  (`src/native-notifications.ts`) and the Raycast extension already cover the other common
  "desktop integration" wants.
- **Local trust posture**: the server binds localhost and guards mutations with local-origin
  checks. Nothing in this plan exposes it more broadly.

## Non-Goals

- **No Electron.** Decision recorded: the window-identity requirement is met by PWA install;
  the lifecycle requirement by the service. See "Future: Tauri" for the only sanctioned shell path.
- **No service worker / offline support** in the PWA. The app is a window onto a local server; if
  the server is down, a clear "Neon is not running — run `neondeck open`" page beats a stale
  cache. Skipping the service worker also avoids the classic stale-asset-cache failure mode.
- **No Windows service support in v1.** macOS (launchd) and Linux (systemd user unit) first;
  Windows users get `neondeck serve` + instructions. Add a Windows implementation when there is a
  Windows user to test it.
- **No auto-update, tray icon, or global hotkeys.** Those are shell features; see Tauri triggers.

## Design

### 1. `neondeck serve` (the primitive)

Foreground production server start: resolve runtime home, load env, start the built server (same
entry `npm start` uses today), log to stdout. Flags: `--port` (overrides the configured/default
3583). This is what the service definition executes and what Windows users run by hand. It must
work from both a repo checkout and the installed npm package (resolve the server entry relative to
the package, not `cwd` — same rule as the migrations plan's packaged-files resolution).

### 2. `neondeck service install | uninstall | status | start | stop`

- **macOS**: writes `~/Library/LaunchAgents/dev.neondeck.server.plist` with `RunAtLoad` +
  `KeepAlive`, then `launchctl bootstrap gui/$UID`. **Pitfall to handle explicitly**: launchd does
  not inherit a shell PATH, and Node here is fnm-managed — capture the absolute `node` (and
  entry-script) paths at install time and embed them in the plist. Re-running `install` after a
  Node upgrade refreshes them; `status` warns when the embedded node path no longer exists.
- **Linux**: writes `~/.config/systemd/user/neondeck.service` (`WantedBy=default.target`,
  `Restart=on-failure`), `systemctl --user daemon-reload && enable --now`. Same absolute-path
  rule.
- Logs go to runtime-home `data/logs/server.log` (plist `StandardOutPath`/systemd journal note in
  docs). `status` reports: unit installed, running (pid), port, `GET /api/health` result, and the
  embedded node path check.
- Generation is pure functions (`renderLaunchdPlist(opts)`, `renderSystemdUnit(opts)`) so unit
  tests cover the output without touching the host; the imperative install/uninstall wraps them.
- `uninstall` removes only what `install` created; it never touches the runtime home or data.
- Safety: service install/uninstall are host mutations — add `safety.ts` entries; they are
  CLI/user-invoked only, never model-callable.

### 3. PWA manifest (window identity)

- `web/public/manifest.webmanifest`: `name: "Neondeck"`, `display: "standalone"`,
  `start_url: "/"`, `background_color`/`theme_color` from the existing Xeneon/Miami palette,
  icons (192/512 px + maskable — generate from the existing brand mark; add SVG source under
  `web/public/icons/`).
- `web/index.html` gains the manifest link + `theme-color` meta + apple-touch-icon. Vite copies
  `public/` into `web/dist/`, which the server already serves — no server change.
- Result: Safari **File → Add to Dock** or Chrome/Edge **Install** turns the dashboard into its
  own app with its own dock icon and its own persistently remembered window bounds. This is the
  direct fix for the "Safari sidebar hijacks all my tabs" problem: the sidebar window stops being
  a Safari window.
- Docs: a short "Install as an app" section on the dashboard docs page with the two-step Safari
  and Chrome flows.

### 4. `neondeck open [profile]`

One command: probe `GET /api/health`; if down, start the server (via the installed service when
present, otherwise spawn `serve` detached with a note suggesting `neondeck service install`); wait
for readiness (bounded); then open the dashboard:

- **Browser strategy**: launch a Chromium-family binary in app mode
  (`--app=http://127.0.0.1:3583` + `--window-size`/`--window-position`, `--kiosk` when the profile
  says so). Detect Chrome/Edge/Brave/Chromium via the standard install paths per OS; fall back to
  the OS default-browser open (`open`/`xdg-open`) when none found — geometry flags then don't
  apply, and the CLI says so and points at PWA install instead.
- **Window profiles** live in `dashboard.json` (schema added in runtime-home alongside the
  existing dashboard config):

```jsonc
"windows": {
  "sidebar": { "width": 480, "height": 1400, "x": 0, "y": 25 },
  "xeneon":  { "kiosk": true, "x": 3440, "y": 0 }
}
```

`neondeck open sidebar`, `neondeck open xeneon`, plain `neondeck open` uses the default browser
behavior/remembered PWA bounds. Flags override profile values. Profiles are user-edited config
in v1 (validated like all runtime files); a typed config action for chat-driven editing is a
later nicety, not in scope.

- Note the interaction honestly in docs: geometry flags are a _launch-time_ placement tool for
  Chromium app-mode windows; an installed PWA instead _remembers_ its own bounds. Sidebar users
  will usually prefer the PWA; kiosk/Xeneon setups will prefer `open xeneon`.

## Delivery: one PR

Commit order: (1) `serve` command; (2) service module (pure renderers + install/uninstall/status
CLI, safety entries); (3) PWA manifest + icons + docs; (4) `open` command with health-probe/start
logic, browser detection, window profiles schema + validation; (5) docs pages (getting-started
gains `neondeck service install` + `neondeck open` as the happy path; dashboard page gains the
PWA install section) and README touch.

Tests: unit tests for plist/systemd renderers (golden files), profile resolution + flag merging,
browser-binary detection (injected fs/platform), health-probe wait logic (fake server); CLI smoke
`neondeck service status` against a temp home; `npm run verify`. Manual checklist in the PR
description: install service on macOS, reboot-equivalent (`launchctl kickstart`), Add to Dock in
Safari, `open sidebar` geometry, kiosk on a second display.

## Future: Tauri (recorded decision)

If a real shell is ever justified, it is **Tauri with `neondeck serve` as a sidecar**, not
Electron — system webview, ~10MB, and it wraps the same web UI without forking it. Concrete
triggers that would justify it (any one of):

- always-on-top or fully chromeless windows,
- global hotkeys,
- OS-level multi-display placement beyond what Chromium launch flags provide,
- a menubar/tray presence with live status.

Until one of those is actually wanted, this plan's trio covers the felt experience, and every
piece of it (manifest, service, launcher) remains exactly as useful under a future Tauri shell.

## Risks

- **Browser detection variance.** Binary paths differ across installs; keep the detection table
  small, data-driven, and covered by tests; the default-browser fallback means `open` never hard
  fails just because Chrome moved.
- **launchd PATH/node drift** (fnm upgrades break embedded paths): handled by absolute-path
  embedding + `status` warning + re-run `install`; called out in docs.
- **Port drift.** `open`, the manifest `start_url`, and the service must all respect the
  configured port, not hardcode 3583; single source of truth is the runtime config/env the server
  itself uses.
- **PWA scope quirks.** Installed-PWA behavior differs slightly per browser (Safari web apps vs
  Chrome PWAs); the docs section states the two supported flows and the plan avoids anything
  exotic (no service worker, no share targets).

## Definition of Done

- `neondeck service install && neondeck open sidebar` on a fresh machine yields: server running
  as a login service, surviving restarts, and a dedicated vertical dashboard window whose
  geometry doesn't leak into the user's browser.
- Safari Add to Dock / Chrome Install produce a standalone Neondeck app window with the brand
  icon that remembers its own size and position.
- `neondeck open` with the server down starts it and opens the dashboard within the readiness
  timeout; with the server up it just opens the window.
- `neondeck service status` truthfully reports installed/running/health/node-path state;
  uninstall leaves no trace beyond runtime-home data.
- All renderer/detection/profile logic is unit-tested; `npm run verify` passes; docs updated.
