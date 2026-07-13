# Changelog

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
