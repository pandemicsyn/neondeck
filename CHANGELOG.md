# Changelog

## Unreleased

- feat(scheduler): add durable scheduled jobs, notifications, and blueprint automations
- feat(watches): add persistent PR watch actions with quiet refresh semantics
- feat(repos): add repo registry API and registry-aware GitHub PR queries
- fix(config): reject empty self-configuration action inputs
- fix(config): audit self-configuration mutations and require confirmation for destructive actions
- feat(config): add Valibot-backed Neondeck self-configuration actions for repos and schedules
- feat(runtime): add validated Neondeck runtime home bootstrap with seeded config, runtime skill, and separate app/Flue SQLite state
