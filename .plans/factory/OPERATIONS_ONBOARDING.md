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
the repository when creating each task (there is no global default repo).
Existing GitHub connections and coding enablement remain intact. Enabling intake
allows a running server to triage admitted work using its configured utility model.
Setup does not submit tasks or run model inference. Selecting Kilo may fetch its
model catalog using the deck's configured key and organization. If coding was already
enabled, enabling factory intake may let a running server dispatch existing
released work under existing grants; the preview warns about this.

Select multiple registered repositories to add GitHub intake connections in one
run. Existing connections are retained without duplication. Each new connection
is saved disabled. The wizard looks up its numeric repository ID through the existing cached GitHub
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

Optionally select installed Codex, OpenCode or Kilo. Setup detects the executable
and derives an explicit runtime PATH, including Node for npm wrappers; choose
manual settings if detection is insufficient. Existing explicit paths are retained
on repeat setup. Codex has a searchable maintained model list. Kilo uses the deck's
configured gateway key and organization for searchable models, with Auto Frontier
as the default when no key is available or discovery fails. Manual model entry
remains available. The selected model must match the adapter's namespace.

For Codex, select **Use existing local Codex login** when a valid file-backed cache
is available. Setup stores only its absolute `auth.json` reference. The runtime
validates and copies it into each private attempt home; it never shares the user's
whole Codex home, config or sessions. Missing/invalid caches and keyring-only
logins require file-backed storage or an explicit credential environment reference.
Per-attempt token refreshes are not written back to the source login cache; live
refresh longevity remains acceptance work. Kilo can reuse `KILOCODE_API_KEY`.

The wizard uses the runtime adapter registry's supported versions. Its bounded
version probe runs in a temporary private home without provider credentials. It
does not install a CLI, sign in or verify live provider access. Missing credentials
and unsupported versions appear as readiness blockers; settings can be saved for
later completion. “Version not checked” is distinct from a missing executable.

Coding starts disabled. Setup now offers an explicit enablement choice for
human-released tasks, separately from the final Apply confirmation. Existing coding
enablement is retained. Enabling may dispatch already released work once intake is
also enabled. Changing an existing coding selection may invalidate outstanding
grants through the normal configuration service. Review readiness and grants in
`/factory`. Human release and publication approvals remain separate; setup creates
neither. Planning and utility model references must be valid before enabling intake.
Credential presence is not evidence of live access.

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
