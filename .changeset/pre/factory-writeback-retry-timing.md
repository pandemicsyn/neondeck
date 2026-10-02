---
'neondeck': patch
---

Show GitHub writeback retry timing only for effects eligible for automatic recovery, preserving pending cooldowns while removing misleading timestamps from manually recovered and completed states. Disable failed-send retries when writeback consent is off, while keeping read-only uncertain receipt checks available.
