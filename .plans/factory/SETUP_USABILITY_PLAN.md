# Factory setup usability follow-up

Status: implementation and independent static reviews complete, September 7, 2026. Follows the merged
operations stack (#412, #413, #415–#418). Live acceptance remains separate.

## Operator-reported problems

Setup requires both an executable and a runtime search PATH, accepts only free-text
coding models, adds one GitHub connection per run, and asks manual-intake users
for a repository it never saves. Existing Codex login is not offered. Selecting a
CLI also leaves coding disabled without an enablement step. The dashboard calls
an unperformed version probe “not detected,” contradicting setup's successful
probe.

## Intended behavior

- Detect installed Codex, OpenCode and Kilo executables and a usable explicit PATH.
  Show the discovered choice; manual executable/PATH entry remains an advanced
  fallback. Keep an operator's existing configuration on repeat setup. Persist
  only explicit paths, never the entire environment.
- Offer searchable Codex models using the maintained model list, including Astra,
  Sol, Terra, Luna, GPT-5.5, Mini and Spark. Preserve the existing default and allow
  manual IDs for future releases.
- Reuse Kilo gateway discovery with the deck's configured key and organization.
  Translate catalog IDs into the Kilo CLI namespace. Default to Auto Frontier
  without a key or when discovery fails; this is a model choice, not proof of
  authentication. Keep search bounded and errors free of secret values.
- Offer an explicit existing local Codex login reference. Resolve a bounded,
  validated file-backed auth cache at execution time into the established private
  attempt credential handoff. Do not share the user's home/config with agents.
  Existing environment-reference credentials stay supported. The web editor must
  preserve the new reference when editing other coding settings.
- Manual intake chooses a repository when a task is created. GitHub setup selects
  multiple repositories and stages one disabled connection per selected repository.
  Retain existing connections and apply the entire reviewed proposal atomically.
  Check the remaining connection capacity before collecting metadata or details;
  an oversized selection must not fail only after the final Apply confirmation.
- Ask explicitly whether to enable coding for human-released tasks. Keep this
  choice distinct from intake enablement and the final Apply confirmation. Existing
  released work may dispatch once enabled; no releases or publication grants are
  created by setup. The mutation boundary requires the explicit enablement choice.
- Distinguish disabled, credential unavailable, and version not checked states.

The coding enable switch is a runtime gate. An existing release remains eligible
when only that switch changes; adapter, model, auth reference, execution paths and
resource limits remain bound to the human-reviewed selection. Preserve existing
stored fingerprints and full-config checks for new release/configuration requests.
Disabling coding must still prevent dispatch and invalidate live execution authority.

## Delivery and ownership

Use a new two-layer official GitHub stack: local credential support and compatible
web rendering first, then guided setup and documentation. Astra-low implementers
own production edits. Two independent Astra-low static reviewers must report clean
before any PR is created. The manager performs final plan/architecture review and
records regressions and screenshots with synthetic data.

## Verification and limits

Check schema/backward compatibility, bounded credential reading and private-copy
cleanup; discovery with symlinks, Node wrappers and missing executables; model
search, namespace translation and gateway failures; multi-repository atomicity and
stale proposals; and explicit coding authorization. Run relevant tests/types plus
repository verification. Exercise terminal prompts and changed dashboard states.

File-backed Codex login reuse does not imply keyring-only sessions can be exported.
The wizard must explain unavailable local-cache recovery without requesting secret
values in chat. Per-attempt OAuth credential snapshots retain existing cleanup;
copying refreshed tokens back to the user's login store is outside this change and
must not happen implicitly. Real provider execution, refresh longevity and remote
host setup remain live acceptance work, not synthetic-test claims.

Sources: [Codex login storage](https://learn.chatgpt.com/docs/auth) and
[Kilo gateway models](https://kilo.ai/docs/gateway/models-and-providers).

The required import-layer check exposed a pre-existing frontend diagnostic test
importing a backend exporter from the prior stack. This follow-up replaces that
test dependency with a schema-valid public fixture while preserving client
binding rejection cases; production diagnostic behavior is unchanged.

## Local verification and independent review

The two implementation layers are complete. Two independent Astra-low static
reviews found and then cleared rerun issues involving a missing selected auth file
and legacy `adapter: null` Codex configuration. The manager checked plan adherence,
credential isolation, explicit authority and conditional credential fields.

The initial repository verification passed lint, import layers, database checks
and types. Unit testing reported 2,980 passing tests and one stale catalog-list
assertion; that assertion was updated for the seven requested Codex choices.
The final focused run passed 193 tests across ten files, followed by app/dashboard
types and repository formatting. These counts overlap and are not additive.

Real terminal prompts were exercised against a synthetic runtime and a version-only
mock CLI: detected executable/PATH, default Codex model, selected local login,
explicit coding opt-in and final Apply succeeded. Separate real terminal checks
searched for Astra and selected it, and accepted Kilo Auto Frontier with no key.
No provider execution or remote credentials were used.

Browser checks exercised the actual coding setup components with production
Factory styles and synthetic API data at 1360px and 390px. They verified the
not-checked status, relevant credential fields, source switching, preserved local
reference on save, and no horizontal overflow. Screenshots use synthetic paths;
operator screenshots containing private setup details are not published.

The Kilo loading indicator subsequently passed 62 focused CLI tests and two
independent static rechecks. The Git suite passed 47 tests; the separately selected
integration groups passed 100 tests across eight files. App/docs builds, package
validation (1,253 files) and packed CLI smoke passed, including managed runtime
entry, IPv6 private health and public isolation checks.

The all-in-one macOS integration attempt was stopped after approximately ten
minutes without reported results. It is incomplete, not a pass. Host/coding/
adapter/delivery integration groups were not completed in that broad run; the
changed credential boundary has focused coverage and the established private-copy
redaction/cleanup test passed separately. No single successful all-inclusive
`npm run verify` is claimed. Existing live provider and refresh acceptance remains
open.

PR #421 feedback identified queued releases invalidated by the enable switch and
oversized repository selections failing after Apply. Both are corrected: persisted
release matching permits only an enable-only difference, and setup checks remaining
connection capacity before collecting details. The fixes passed 39 onboarding
tests, 13 new release regressions and 50 existing service/bridge tests, followed by
app/dashboard types, import-layer checks and changed-file formatting. Two independent
Astra-low static reviewers cleared the fixes; no live acceptance claim changes.
