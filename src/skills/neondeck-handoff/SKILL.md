---
name: neondeck-handoff
description: Explain how external local agents can register completed work with Neondeck through the CLI or localhost handoff API.
---

# Neondeck Handoff

External local agents can register work with Neondeck without gaining execution, approval, push, or provider-mutation powers.

Use these commands when explaining setup to another agent or a user:

```sh
neondeck register-pr <owner/repo#number> --from <agent-name> --note "<one-line summary>" --json
neondeck note "Finished significant work without a PR." --from <agent-name> --repo <repo-id-or-owner/name> --level ready --json
```

The same-host HTTP mirror is:

```sh
curl -sS -X POST http://127.0.0.1:3583/api/handoff/register-pr \
  -H 'content-type: application/json' \
  --data '{"source":"codex","ref":"owner/repo#123","note":"adds retry logic","review":false}'
```

HTTP handoff requests must include `source`. CLI commands default to `external:cli`, or normalize `--from codex` to `external:codex`. `ci:` and `external:` prefixes are preserved.

`register-pr` creates or confirms a PR watch and optionally creates a note. Duplicate PR watch registration is a successful no-op. `--review` is default-off and only queues the bounded `review-pr-for-human` Flue workflow when `handoff.allowExternalReviewQueue` allows it. That workflow reads PR facts and creates local reports/local draft comments only; it does not submit GitHub reviews.

Notes create Neondeck notifications with levels `info`, `ready`, or `attention`; external callers cannot create `urgent` notes. Linked repo or PR references must match configured repositories.

Use `neondeck_config_update_handoff` to change handoff policy. Do not tell external agents to call execution, approval, push, Kilo, provider, or config mutation APIs through the handoff surface.
