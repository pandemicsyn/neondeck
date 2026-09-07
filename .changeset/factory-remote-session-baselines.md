---
'neondeck': patch
---

Capture the latest origin default branch for new factory planning and initial coding sessions without changing the user's checkout. Planning captures on the first human planner request after automatic triage and on explicit Refresh; coding captures independently when its initial attempt starts. Existing sessions and repair attempts retain their frozen revisions. Repositories without origin use the configured local default branch with explicit provenance; remote failures never fall back to stale local code.
