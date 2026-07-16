# Changelog

## 1.0.0-beta.10

### Minor Changes

- [#122](https://github.com/pandemicsyn/neondeck/pull/122) [`b7a9b29`](https://github.com/pandemicsyn/neondeck/commit/b7a9b2996f806bc86e2571d5d2f01484612d553b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Play a configurable two-note chime when a new in-app notification arrives.

### Patch Changes

- [#120](https://github.com/pandemicsyn/neondeck/pull/120) [`61bae11`](https://github.com/pandemicsyn/neondeck/commit/61bae114525bda27a5c900c4ecc7282d0bba8c33) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Multiplex dashboard domain events over one shared connection and render PR review reports inline so active streams cannot starve report loading.

## 1.0.0-beta.9

### Patch Changes

- [#118](https://github.com/pandemicsyn/neondeck/pull/118) [`df66b2c`](https://github.com/pandemicsyn/neondeck/commit/df66b2c3b4e1dc75a97534cdc0db99396245062f) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep ready dashboard notifications visible for one hour by default and allow configuring them to remain until dismissed.

- [#115](https://github.com/pandemicsyn/neondeck/pull/115) [`1e692f4`](https://github.com/pandemicsyn/neondeck/commit/1e692f44819715e102135ef2bd896c208786d310) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Correct PR branch freshness findings, replace stale Neon-generated review artifacts on re-review while preserving human edits, and speed up the focused review pop-out loading path.

- [#116](https://github.com/pandemicsyn/neondeck/pull/116) [`8c972c0`](https://github.com/pandemicsyn/neondeck/commit/8c972c0e1898b5e0462d59d69badfc4e08f87dba) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Complete the PR review workbench with in-dashboard artifacts, explicit finding anchors, manual report-only anchoring, workbench-started Neon reviews, reliable behind detection, and reserved whole-review submission.

- [#117](https://github.com/pandemicsyn/neondeck/pull/117) [`fc0618d`](https://github.com/pandemicsyn/neondeck/commit/fc0618dc456c67aa5362baf772ef2499a95d55ad) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the Reviews tab once to existing dashboard work regions while preserving the configured default tab and respecting later user removal.

## 1.0.0-beta.8

### Minor Changes

- [#113](https://github.com/pandemicsyn/neondeck/pull/113) [`8eaa12d`](https://github.com/pandemicsyn/neondeck/commit/8eaa12df1c4b0344f1f7a11f0fbf491d76678be0) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add a durable PR review inbox with live chat and dashboard updates, queue-independent review workbenches, linked local reports, and explicit whole-review GitHub submission.

## 1.0.0-beta.7

### Minor Changes

- [#111](https://github.com/pandemicsyn/neondeck/pull/111) [`bf72138`](https://github.com/pandemicsyn/neondeck/commit/bf7213830b1df5f378913b2857a7781fe97c1187) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Separate interactive repo authority from autopilot policy, add typed commit and linked-PR push actions, and share objective repo guardrails across both origins. Existing local config must move any `autopilot.limits` values to the top-level `guardrails` block; the legacy location is no longer read.

### Patch Changes

- [#108](https://github.com/pandemicsyn/neondeck/pull/108) [`37296be`](https://github.com/pandemicsyn/neondeck/commit/37296beb48ed4c811f775caae5492656b0f422f7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep dashboard slash-command completion synchronized with the backend command registry and restore `/review-pr` completion for existing runtime homes.

- [#109](https://github.com/pandemicsyn/neondeck/pull/109) [`0f7d4b8`](https://github.com/pandemicsyn/neondeck/commit/0f7d4b8770752afb6103939fe11a8d56d788302e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Explain why a pull request watch needs attention, show durable watch activity inline in linked chat sessions, and require fresh deterministic evidence before the agent answers watch-status questions.

## 1.0.0-beta.6

### Patch Changes

- [#105](https://github.com/pandemicsyn/neondeck/pull/105) [`d82f8f2`](https://github.com/pandemicsyn/neondeck/commit/d82f8f28914509c6b6ac9710c0c2b09783538cd4) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep fresh display-assistant sessions active across host timezones and briefing profile updates so manual briefings can run immediately.

## 1.0.0-beta.5

### Minor Changes

- [#103](https://github.com/pandemicsyn/neondeck/pull/103) [`5475ffe`](https://github.com/pandemicsyn/neondeck/commit/5475ffe1689b2bfeba29db87bcc4ced21e0463da) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add configurable in-app toast notifications for durable dashboard events.

- [#98](https://github.com/pandemicsyn/neondeck/pull/98) [`fc2305b`](https://github.com/pandemicsyn/neondeck/commit/fc2305ba4b08d0a15eab3480f9bcd6b3cf950718) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add durable conversational morning briefings with scheduled Flue dispatch, configurable grounding, persistent conversations, and dashboard controls.

## Unreleased

## 1.0.0-beta.4 - 2026-07-12

- fix(runtime): make concurrent runtime-home initialization atomic
- fix(flue): expose command, watch, scheduler, GitHub, and doctor operations through Flue actions/workflows
- feat(release): add release watch command and default-branch check polling
- feat(dev): add local dev doctor command and diagnostics action
- feat(dashboard): add runtime overview panel for home, repos, jobs, and skills
- feat(watches): add automatic PR watch polling and an active watches panel
- feat(commands): add Neon slash command workflows and dashboard buttons
- feat(setup): add explicit runtime home setup command
- feat(skills): add runtime skill discovery, loading, and reload actions
- feat(scheduler): add durable scheduled jobs, notifications, and blueprint automations
- feat(watches): add persistent PR watch actions with quiet refresh semantics
- feat(repos): add repo registry API and registry-aware GitHub PR queries
- fix(config): reject empty self-configuration action inputs
- fix(config): audit self-configuration mutations and require confirmation for destructive actions
- feat(config): add Valibot-backed Neondeck self-configuration actions for repos and schedules
- feat(runtime): add validated Neondeck runtime home bootstrap with seeded config, runtime skill, and separate app/Flue SQLite state
