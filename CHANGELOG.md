# Changelog

## 1.0.0-beta.14

### Patch Changes

- [#179](https://github.com/pandemicsyn/neondeck/pull/179) [`a52801e`](https://github.com/pandemicsyn/neondeck/commit/a52801e40fecb53f2451b611a8d376b432d5658e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Give every fixing Autopilot mode a full managed-worktree coding workspace and let autonomous mode deliver through semantic engineering judgment without requiring configured checks, while retaining mechanical mode, head, destination, credential, commit, and non-force push guards.

## 1.0.0-beta.13

### Minor Changes

- [#172](https://github.com/pandemicsyn/neondeck/pull/172) [`a8ee94d`](https://github.com/pandemicsyn/neondeck/commit/a8ee94d3421669d69c18fe47629fe256d1b67925) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Complete the minimal watched-PR Autopilot loop with one continuing owner and managed worktree, mode-bound tools, reviewable held commits, verified safe push, direct human approval turns, visible crash recovery, and terminal cleanup.

- [#165](https://github.com/pandemicsyn/neondeck/pull/165) [`42e309b`](https://github.com/pandemicsyn/neondeck/commit/42e309b69af8fd0ed583bb94c173cdac7303f45b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Retain complete watched-PR feedback and stable fingerprints, add a restart-safe choice for processing current feedback, and preserve exact-head worktree primitives for explicit guarded workflows. PR watches do not automatically prepare worktrees or dispatch an Autopilot owner while the simplified loop is rebuilt.

- [#167](https://github.com/pandemicsyn/neondeck/pull/167) [`11c7e37`](https://github.com/pandemicsyn/neondeck/commit/11c7e3746aa630c8e42a4aefc490708f8bd9a4cf) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add central Autopilot readiness facts across runtime status, doctor, the local API, CLI onboarding, and the dashboard, with bounded noninteractive Git credential and exact-target gates shared by setup and push.

### Patch Changes

- [#174](https://github.com/pandemicsyn/neondeck/pull/174) [`e3e6fab`](https://github.com/pandemicsyn/neondeck/commit/e3e6fab70dbefa22641a2230644855d5081da723) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Restore the conversational Autopilot setup and control surface to the minimal persistent-owner loop, and retire the legacy Autopilot dashboard panel in favor of Active Watches.

- [#175](https://github.com/pandemicsyn/neondeck/pull/175) [`4562dde`](https://github.com/pandemicsyn/neondeck/commit/4562ddef226e1728ed11f53e81a939ecb526a534) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Remove the retired workflow-based Autopilot engine, routes, and dashboard client so watched pull requests use only the continuing owner loop.

- [#162](https://github.com/pandemicsyn/neondeck/pull/162) [`adce961`](https://github.com/pandemicsyn/neondeck/commit/adce96184c3ac52609143e6423724d22f1b58985) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep dashboard startup, PR review popouts, and standalone report windows synchronized with Neondeck's selected light or dark appearance.

## 1.0.0-beta.12

### Patch Changes

- [#157](https://github.com/pandemicsyn/neondeck/pull/157) [`48425a6`](https://github.com/pandemicsyn/neondeck/commit/48425a6d7274931d34b4f4468d1aec5f48ef56b8) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep Phase B review navigation, findings, promotions, refresh, and mounted surface state consistent across slow requests, event-stream outages, and concurrent actions.

- [#159](https://github.com/pandemicsyn/neondeck/pull/159) [`3840128`](https://github.com/pandemicsyn/neondeck/commit/3840128277c83aeb40c8561a6f80b821ca081303) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Run the app database in WAL mode and harden scheduler leases, workflow settlement, recovery, and SQLite diagnostics against lock contention and partial persistence failures.

- [#160](https://github.com/pandemicsyn/neondeck/pull/160) [`2134a32`](https://github.com/pandemicsyn/neondeck/commit/2134a32ee4a8fc5979ab2675692e53971990a901) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Harden SQLite contention handling, Kilo cancellation, exact-commit pushes, idempotent autofix comments, unattended GitHub command policy, and concurrent skill-patch decisions.

- [#161](https://github.com/pandemicsyn/neondeck/pull/161) [`85ab780`](https://github.com/pandemicsyn/neondeck/commit/85ab780411bd105fec8075c8c1a8b931791f1b05) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Prevent duplicate approval dispatches, serialize worktree cleanup with active workflows, and record approval nudges before Flue accepts them.

## 1.0.0-beta.11

### Minor Changes

- [#153](https://github.com/pandemicsyn/neondeck/pull/153) [`8089982`](https://github.com/pandemicsyn/neondeck/commit/8089982bb7bda786b4f7eb91308cdd88fdd45875) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Promote current Neon findings into local GitHub review drafts or confirmed prepared-diff revision requests without bypassing submission, authority, or execution boundaries.

- [#154](https://github.com/pandemicsyn/neondeck/pull/154) [`3bf9f2c`](https://github.com/pandemicsyn/neondeck/commit/3bf9f2c3124416d70927dcf5977d8812efe59869) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep GitHub, prepared-diff, and Kilo review surfaces revision-consistent with guarded live refresh, preserved review orientation, targeted cache invalidation, and truthful stale draft and finding state.

- [#130](https://github.com/pandemicsyn/neondeck/pull/130) [`d5659f5`](https://github.com/pandemicsyn/neondeck/commit/d5659f5636e96b41ac5e6a23e626c34fee4ddd7d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Render generated PR review artifacts as secure, accessible slide decks with a Markdown review brief, clickable safe links, responsive standalone and dashboard views, retained-report compatibility, and bounded agent-authored presentation intent.

### Patch Changes

- [#145](https://github.com/pandemicsyn/neondeck/pull/145) [`b4ffc1d`](https://github.com/pandemicsyn/neondeck/commit/b4ffc1dd32ac4b9d9347e28c494fc800bb148d15) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Show per-file PR review status in the changed-file tree and add a shared cross-file cursor foundation for files, hunks, threads, drafts, findings, and combined attention items.

- [#140](https://github.com/pandemicsyn/neondeck/pull/140) [`fba1de5`](https://github.com/pandemicsyn/neondeck/commit/fba1de5a19316da34322900108cf07ef58569582) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Preserve complete operational values behind on-demand copyable disclosures and clarify linked-chat and execution approval actions.

- [#150](https://github.com/pandemicsyn/neondeck/pull/150) [`fd1b000`](https://github.com/pandemicsyn/neondeck/commit/fd1b000f48872f95719a9225de52c759681635fb) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add focused PR review traversal controls, scoped keyboard shortcuts, accessible help, synchronized target state, and bounded lazy cross-file hunk navigation.

- [#141](https://github.com/pandemicsyn/neondeck/pull/141) [`1bc3626`](https://github.com/pandemicsyn/neondeck/commit/1bc3626260921fbe4c482eff010a4cb72b5c1b3d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Close the frontend review with stable PR-finding provenance, operation-scoped review feedback, stricter Flue chat configuration, and final dashboard polish.

- [#136](https://github.com/pandemicsyn/neondeck/pull/136) [`66f7c4e`](https://github.com/pandemicsyn/neondeck/commit/66f7c4edc0f6aa94bd732d17c7089ecb35dd5557) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Virtualize large Pierre diffs with CodeView while keeping the lower-overhead renderer for ordinary patches.

- [#152](https://github.com/pandemicsyn/neondeck/pull/152) [`1eba740`](https://github.com/pandemicsyn/neondeck/commit/1eba740082f08cc5938e8329230d87dc0fd4d20c) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Render revision-bound Neon findings inline with provenance, local dismissal, finding-aware file filtering, and cross-file review navigation.

- [#131](https://github.com/pandemicsyn/neondeck/pull/131) [`d54fae5`](https://github.com/pandemicsyn/neondeck/commit/d54fae55df55c68797cd52ace0bfaecef0466ca3) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Improve dashboard accessibility, theme contrast, and compact chat and review layouts.

- [#135](https://github.com/pandemicsyn/neondeck/pull/135) [`85bfd30`](https://github.com/pandemicsyn/neondeck/commit/85bfd30ac0e714aa068f30e83bc39585e85792ff) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep chat composer updates isolated from stable Markdown history so typing stays responsive in long sessions.

- [#139](https://github.com/pandemicsyn/neondeck/pull/139) [`e209a3d`](https://github.com/pandemicsyn/neondeck/commit/e209a3d2f2224ba9955cec5cb350e17a69593dc0) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Prioritize the selected pull request patch before loading neighboring, draft-comment, and unresolved-thread diffs.

- [#144](https://github.com/pandemicsyn/neondeck/pull/144) [`5479b58`](https://github.com/pandemicsyn/neondeck/commit/5479b588b8b5875a41250a2f4f9bf6646fd2a279) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Load PR review threads through a lean cancellable GitHub query and a short-lived mutation-aware cache so warm review surfaces open within the performance budget.

- [#128](https://github.com/pandemicsyn/neondeck/pull/128) [`860cccf`](https://github.com/pandemicsyn/neondeck/commit/860cccfec81dac0c9d9b6adb57c6979bffa18d93) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Allow watched pull requests to be stopped from Autopilot and open PR rows, including after a watch has reached a terminal state.

- [#155](https://github.com/pandemicsyn/neondeck/pull/155) [`0a661c9`](https://github.com/pandemicsyn/neondeck/commit/0a661c949f34feb45130f533d02e5c0bfa803fc1) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep an applied prepared-diff review and its approval context visible when a background revision metadata refresh fails.

- [#132](https://github.com/pandemicsyn/neondeck/pull/132) [`f55c598`](https://github.com/pandemicsyn/neondeck/commit/f55c598568a5c200fecb020fb75f59b570c91134) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Keep Flue sessions, command events, and dashboard query caches synchronized across switches and reconnects.

- [#138](https://github.com/pandemicsyn/neondeck/pull/138) [`a71fb3f`](https://github.com/pandemicsyn/neondeck/commit/a71fb3ff8da6e4399acda836da98bba28f9aa963) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Speed up large registered PR reviews by reusing immutable local diff metadata and preventing optimistic review state from duplicating thread and patch requests.

- [#146](https://github.com/pandemicsyn/neondeck/pull/146) [`04a785f`](https://github.com/pandemicsyn/neondeck/commit/04a785f2f85dd269db6c5e60b1fd8da35ea3f65d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add a revision-bound ephemeral Neon finding contract with targeted review-surface APIs, events, and Flue capabilities.

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
