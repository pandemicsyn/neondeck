---
'neondeck': minor
---

Separate interactive repo authority from autopilot policy, add typed commit and linked-PR push actions, and share objective repo guardrails across both origins. Existing local config must move any `autopilot.limits` values to the top-level `guardrails` block; the legacy location is no longer read.
