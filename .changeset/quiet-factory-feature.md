---
'neondeck': minor
---

Put software factory behind an opt-in feature flag. Seed features.factory with NEONDECK_FACTORY_ENABLED during runtime-home initialization; use saved config and restart afterward. Disabled homes skip factory onboarding, navigation, APIs, workers, recovery, and the public webhook listener.
