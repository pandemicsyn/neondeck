# Optional factory setup

`neondeck init` offers factory setup after repository registration. Skip leaves
factory configuration untouched. Resume against an existing installation with:

```sh
neondeck --home /path/to/runtime-home factory setup
```

The wizard reuses registered repositories, planning/utility model references and
factory configuration. It shows the proposed local configuration before asking to
apply; declining leaves configuration unchanged. Concurrent configuration or
repository changes require a fresh review. Manual intake uses `/factory`; select
the repository again when creating each task (there is no global default repo).
Existing GitHub connections and coding enablement remain intact. Enabling intake
allows a running server to triage admitted work using its configured utility model.
Setup does not submit tasks or contact model providers. If coding was already
enabled, enabling factory intake may let a running server dispatch existing
released work under existing grants; the preview warns about this.

A new GitHub connection is saved disabled. The wizard looks up its numeric repository ID through the existing cached GitHub
read client using the selected token reference; lookup failure offers an explicit
manual fallback. Supply an admission label (or explicitly choose all issues), and environment variable names
for the webhook secret and read credential. Put values only in the private runtime
home `.env` or service environment. Setup never asks for or writes secret values.
Restart after changing the environment. In `/factory`, check the mapping and enable
the connection deliberately. Existing enabled connections continue operating.

Keep the private dashboard listener on loopback. Configure a separate
`NEONDECK_INGRESS_PORT` for webhook ingress, different from the private
`NEONDECK_PORT` (default 3583). The webhook URL is
`/hooks/github/<connection-id>` on that ingress listener. Configure the GitHub
webhook separately with the same local secret and `issues` / `issue_comment`
events. Never expose the dashboard port as webhook ingress. See
[GitHub intake](INCREMENT_4_OPERATOR.md) for listener and routing details.

Optionally select installed Codex, OpenCode or Kilo, its absolute executable,
adapter-specific model and isolated credential environment reference. The wizard
uses the runtime adapter registry's supported versions and model validation. It
runs only the bounded version probe in a temporary isolated home without provider
credentials, and validates the selected credential locally in memory. It does not
install a CLI, sign in, import ambient CLI auth or verify live provider access.
Missing credentials and unsupported versions appear as readiness blockers; settings
can be saved for later completion. A malformed model/adapter configuration must be
corrected before saving.

Coding stays disabled on a new installation; existing coding enablement is retained.
Changing an existing coding selection may invalidate outstanding grants through the
normal configuration service. Review readiness and grants in `/factory`. Human
release and publication approvals remain separate; setup never grants them. Existing grants may resume as described above. Planning and utility models use the existing configuration; invalid
provider references must be repaired with the regular model/provider setup before
enabling intake. Credential presence is not evidence of live access.

Factory configuration writes from the CLI and factory API share a cross-process
lock. The preview fingerprint is checked inside that lock before replacing
configuration. Contention fails without writing; retry when the other writer
finishes. After a crash, stop all Neondeck processes before removing
`config.json.factory-write.lock` in the runtime home. Locks are never stolen based
on age. This serializes factory service mutations only: older unrelated
whole-config writers, repository-registry writers and manual file edits do not participate. Avoid simultaneous
model/provider/general configuration edits while applying factory setup. This is
not a claim of transactions across SQLite and JSON files.

## Local synthetic acceptance — September 7, 2026

Executed the source CLI with Node 26.4.0 against a fresh isolated runtime home,
with inherited credentials removed and no server or workers running:

- `factory --help` listed setup, doctor, timeline and diagnostics commands.
- `factory setup` was exercised through a real PTY. Choosing the default **No**
  printed the resume command and `/factory` link; configuration bytes were unchanged.
- `--json factory doctor` returned valid JSON with all workers `not-running`.
- A synthetic manual task was created locally solely to exercise diagnostics.
  `factory diagnostics preview <synthetic-work-id>` produced a redacted snapshot;
  `factory diagnostics export <preview-file> <output-file>` returned
  `{"written":true}`. Export bytes exactly matched the inspected preview and the
  output file mode was `0600`.
- Local database reads confirmed zero releases and zero coding runs; coding
  remained disabled. No real credentials, provider requests, webhook setup,
  publication or external mutation were used.

Focused verification passed 27 tests across `src/cli/onboarding-factory.test.ts`,
`src/cli/onboarding.test.ts`, and
`src/modules/config/factory-mutation-lock.test.ts`. Coverage includes skip,
preview cancellation, retained configuration/authority, metadata lookup with
synthetic responses, stale previews checked inside the shared mutation service,
live two-process lock contention, abandoned locks, and preservation of the original
mutation error when cleanup fails. Scoped lint and formatting checks passed.
These checks establish local behavior only; real provider/GitHub access and live
coding acceptance remain untested here.
