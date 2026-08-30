# Open Gateway Model Discovery And Onboarding Plan

Status: **implemented in worktree** — first-class OpenRouter and OpenCode Zen provider
configuration, live model discovery, and searchable first-run model selection.

Date: 2026-08-29

## Objective

Give OpenRouter and OpenCode Zen the same first-run experience that KiloCode has today:

1. Select the provider directly during `neondeck init`.
2. Configure its API key through a named environment-variable reference.
3. Fetch a live catalog without exposing the secret anywhere else.
4. Search the catalog or enter a model manually; add a recommended choice after its separate
   product decision is approved.
5. Preserve correct Pi model metadata and wire protocol when the selected model runs through Flue.

This is not only an onboarding prompt change. OpenRouter and OpenCode must become first-class
Neondeck providers so config validation, runtime registration, readiness, dashboard controls, and
documentation all agree with the model strings written by onboarding.

Provider-role model candidates are centralized for offline discovery, but they are not exposed as
recommended defaults until the pending pricing and capability discussion is resolved.

## Terminology And Model Specifiers

- **OpenRouter**: provider id `openrouter`, API key environment variable
  `OPENROUTER_API_KEY`, inference base URL `https://openrouter.ai/api/v1`, and model strings such as
  `openrouter/openai/gpt-5.5`.
- **OpenCode Zen**: provider id `opencode`, API key environment variable `OPENCODE_API_KEY`,
  provider root `https://opencode.ai/zen`, and model strings such as `opencode/gpt-5.6-sol`.
- **OpenAI-compatible endpoint** remains the user-defined generic provider feature. It is not the
  implementation path for either gateway after this work.

## Verified Contracts

Research was performed against the repository at `@flue/*` 2.0.3 and
`@earendil-works/pi-ai` 0.83.0, plus the public provider endpoints on 2026-08-29.

### Flue And Pi

- Flue's model layer is Pi's provider protocol without a second provider abstraction. A Flue
  `setProvider()` call registers one Pi `Provider`, keyed by provider id; a later registration
  replaces the earlier provider under that id.
- Model resolution requires both a registered provider id and a model declared by
  `provider.getModels()`. Discovering an id in onboarding is insufficient if the runtime provider
  cannot resolve it.
- Pi supports provider-level and model-level API implementations. The installed OpenRouter
  provider uses OpenAI Chat Completions with OpenRouter-specific compatibility metadata. The
  installed OpenCode provider uses four model-level APIs: OpenAI Responses, Anthropic Messages,
  Google Generative AI, and OpenAI Chat Completions.
- Pi supports dynamic provider catalogs through `createProvider({ fetchModels })`. The provider
  owns restored/cached models and publishes refreshed models; callers return fully formed Pi
  `Model` objects.
- Material Flue documentation: `reference/provider-api` and `guide/models` from the project-local
  Flue 2.0.3 CLI. Material Pi documentation: `providers`, `custom-provider`, and `models` under
  `https://pi.dev/docs/latest/`, reconciled against the installed 0.83.0 source.

### OpenRouter

- Public catalog: `GET https://openrouter.ai/api/v1/models`.
- Authenticated, user-filtered catalog: `GET https://openrouter.ai/api/v1/models/user`. This
  reflects the API key's provider preferences, privacy settings, regional restrictions, and
  guardrails.
- The catalog returns ids, names, context limits, output limits, modalities, pricing,
  `supported_parameters`, and reasoning metadata.
- The public endpoint supports filters including `supported_parameters=tools`,
  `output_modalities=text`, free-text `q`, category, context, price, and sorting.
- A live filtered request returned 315 tool-capable text-output models during research. The count
  is expected to change.

### OpenCode Zen

- Live catalog: `GET https://opencode.ai/zen/v1/models`.
- A live anonymous request returned 64 ids during research. The response used the standard OpenAI
  list envelope but each row only contained `id`, `object`, `created`, and `owned_by`; it did not
  contain context, tool, reasoning, price, or protocol metadata.
- OpenCode's documented inference route is model-dependent:
  - GPT, Grok, Muse, and some free models use OpenAI Responses.
  - Claude and some Qwen models use Anthropic Messages.
  - Gemini models use Google Generative AI.
  - DeepSeek, MiniMax, GLM, Kimi, and several free models use OpenAI Chat Completions.
- OpenCode maintains the richer metadata in Models.dev. Its provider catalog includes model name,
  tool support, reasoning, modalities, limits, cost, status, and a provider-specific AI SDK
  adapter. The installed Pi OpenCode catalog is generated from the same family of metadata and
  adds Pi-specific compatibility fields.
- The live Zen list and installed Pi catalog already drift: 64 live ids versus 59 bundled ids;
  eight live ids were absent from the bundle and three bundled ids were absent from the live
  endpoint. Therefore neither source is sufficient alone.

## Current Neondeck Behavior

- `src/modules/model-catalog/model-discovery.ts` performs live discovery only for `kilocode`; other
  registered providers receive a short static suggestion list.
- `src/cli/onboarding.ts` only opens the searchable chooser for `kilocode`. Every other provider
  uses free-text model entry.
- OpenRouter is currently suggested as an example generic OpenAI-compatible endpoint rather than
  a first-class provider.
- A generic compatible provider creates only the models already selected in Neondeck config and
  assigns conservative metadata: `reasoning: false`, unknown context, unknown maximum output, and
  a single provider-wide protocol. This loses Pi's native OpenRouter behavior and cannot represent
  OpenCode's model-level protocol split.
- `registeredProviderIds`, provider config schemas, runtime status, dashboard API types, and the
  runtime provider installer currently know only KiloCode, OpenAI, Anthropic, and ChatGPT
  subscription as first-class choices.

## Product Decisions

### 1. Both gateways are first-class allowlisted providers

Extend the explicit provider boundary with `openrouter` and `opencode`. Store only `enabled` and
`apiKeyEnv` in ordinary config. Preserve the existing uppercase environment-variable-name
validation and never persist raw keys in `config.json`.

Provider changes remain restart-required, while model changes apply to new sessions or after a
restart under the existing stale-context policy.

### 2. Discovery and runtime resolution share one normalized catalog contract

Do not build an onboarding-only list of strings. Add a provider catalog module whose normalized
chooser projection retains the runtime identity and the metadata the onboarding UI uses:

```ts
type DiscoveredModel = {
  id: string; // provider-qualified id
  name: string;
  provider: 'openrouter' | 'opencode' | 'kilocode';
  model: string; // upstream id
  api:
    | 'openai-completions'
    | 'openai-responses'
    | 'anthropic-messages'
    | 'google-generative-ai';
  contextLength: number | null;
  reasoning: boolean;
  isFree: boolean | null;
  recommendedIndex: number | null;
  source: 'provider-live' | 'pi-bundled' | 'suggested';
};
```

Runtime materialization starts from Pi's native provider and full `Model` entries. Discovery must
keep provider/model identity and `api` aligned with the runtime catalog. OpenRouter is the one safe
dynamic exception: because its text gateway has one provider-wide Chat Completions protocol, a
selected live id absent from bundled Pi is added to the native provider with conservative limits
and OpenRouter compatibility behavior. Bundled ids retain Pi's richer metadata unchanged.

### 3. Availability and metadata have separate authority

- OpenRouter's own response is authoritative for both current availability and core metadata.
- OpenCode's `/models` response is authoritative for current availability.
- Pi's bundled `opencodeProvider().getModels()` is the first metadata source for matching OpenCode
  ids because it includes Pi-specific API and compatibility behavior.
- OpenCode live ids absent from the installed Pi catalog fail closed: they are not selectable and
  diagnostics count them as unavailable in the runtime. Models.dev enrichment remains a deferred
  follow-up until a validated Models.dev-to-Pi adapter mapping can preserve Pi's protocol and
  compatibility behavior. Never guess a provider-wide OpenCode protocol.
- A bundled OpenCode id absent from the live Zen list is not selectable, even if it remains usable
  in an offline cached session.

### 4. Discovery is resilient but never creates an unrunnable selection

- Discovery uses a ten-second timeout and honors caller cancellation.
- An authenticated OpenRouter request tries `/models/user` first. Authentication or endpoint
  failure falls back to the public catalog with a warning; it must not silently claim the public
  list reflects account guardrails.
- OpenCode discovery does not need to send the API key to the public catalog. The key is reserved
  for inference unless upstream behavior later requires authenticated discovery.
- On network failure, use bundled Pi models plus the approved provider suggestions, clearly
  labeled as offline/stale. Manual entry remains available.
- Before accepting any selected or manually entered model, resolve it against the provider's
  effective catalog. A manual id may bypass search ranking but may not bypass runtime
  resolvability. For OpenRouter, the effective catalog includes eligible live ids that the runtime
  can materialize through its uniform Chat Completions provider.

### 5. Search is provider-neutral

Replace `provider === 'kilocode'` onboarding branches with a catalog-provider capability check.
KiloCode, OpenRouter, and OpenCode use one chooser flow:

1. Recommended default, only when the provider-role decision is approved.
2. Search models, initially selected while no gateway default is approved.
3. Manual entry.

A no-match search stays in the search prompt. Search results include explicit `Search again` and
`Back to model choices` actions so a user is never trapped in a one-shot query.

Search matches qualified id and display name. Matches are relevance-ranked, then ordered newest
first when the provider supplies a meaningful creation timestamp. Results are shown 12 per page,
with the total count and previous/next controls keeping every match reachable. Each page shows
available hints: name, context, reasoning, free status, and protocol only when protocol clarity
helps avoid confusion. The same chooser is reused for manually selecting the utility and Explore
models; the current Kilo-only special cases must not remain.

OpenRouter may additionally use upstream `q` for large catalogs, but local filtering over one
bounded fetched catalog should remain available so retries and tests are deterministic.

## Decision Gate: Model Recommendations

Status: **pending user decision**. The implementation keeps recommendation selection data-driven,
but onboarding does not label or preselect any OpenRouter/OpenCode model as recommended yet.

Fill this table before enabling recommended defaults. Recommendations must be model-qualified,
currently available through the corresponding live provider catalog, tool-capable, and
resolvable by the effective runtime provider.

| Provider     | Display assistant | Utility | Explore | Rationale |
| ------------ | ----------------- | ------- | ------- | --------- |
| OpenRouter   | Pending           | Pending | Pending | Pending   |
| OpenCode Zen | Pending           | Pending | Pending | Pending   |

Implementation should encode recommendations as data, not conditionals scattered through
onboarding. Each role recommendation should include a fallback chain so a removed model does not
break setup. Discovery selects the first available supported recommendation and explains when it
used a fallback.

Do not adopt these existing incidental values without an explicit decision:

- `openrouter/openai/gpt-5.5` from `defaultProviderModel()`.
- `opencode/gpt-5.5` from the generic `${provider}/gpt-5.5` branch.

## Implementation Phases

### Phase 1 — First-class config and native Pi providers

1. Add `openrouter` and `opencode` to `registeredProviderIds` and all derived TypeScript unions.
2. Extend runtime-home and config-action schemas with allowlisted `enabled` and `apiKeyEnv`
   records using `OPENROUTER_API_KEY` and `OPENCODE_API_KEY` defaults.
3. Add provider status resolution, credential presence, doctor/readiness checks, and safe config
   serialization for both providers.
4. Register configured providers by starting from Pi's `openrouterProvider()` and
   `opencodeProvider()` factories and replacing only Neondeck-owned authentication/enablement
   behavior. Preserve their model-level APIs, compatibility fields, input modalities, thinking
   maps, and costs.
5. Ensure disabling either provider shadows the Flue/Pi built-in with unavailable auth under the
   same policy used for the existing built-ins; an ambient environment variable must not bypass
   a disabled Neondeck provider.
6. Remove the onboarding implication that OpenRouter should normally be created as a generic
   compatible endpoint. Keep generic endpoints for genuinely custom services.

Primary files:

- `src/runtime-home/schemas.ts`
- `src/modules/config/schemas.ts`
- `src/modules/config/mutations/providers.ts`
- `src/modules/repos/providers.ts`
- `src/modules/repos/runtime-providers.ts`
- `src/modules/runtime/status.ts`
- `src/modules/runtime/status-schema.ts`
- `src/modules/runtime/doctor.ts`
- `web/src/api/types.ts`

### Phase 2 — Provider catalog strategies

1. Refactor `src/modules/model-catalog/model-discovery.ts` into shared orchestration plus provider-specific
   parsers. Keep pure parsing functions independently testable.
2. OpenRouter strategy:
   - Use `/models/user` with the configured key.
   - Fall back to public `/models` with `supported_parameters=tools` and
     `output_modalities=text`.
   - Follow pagination links safely and only on the expected OpenRouter origin.
   - Filter non-text output and non-tool models defensively even when server filters were used.
   - Map name, context length, reasoning metadata, and strict zero-price/free status for the
     chooser.
   - Use unchanged native Pi metadata when available. For a newer live id absent from Pi, retain
     live chooser metadata and let runtime registration add a conservative selected-model overlay
     with the OpenRouter Chat Completions protocol and compatibility mode.
3. OpenCode strategy:
   - Fetch `/zen/v1/models` for the live id set.
   - Join ids to the bundled Pi OpenCode catalog.
   - Record unmatched live ids in diagnostics but do not return them as selectable.
   - Preserve Pi's per-model API and compatibility metadata for every matched model.
   - Exclude bundled entries absent from the live id set.
4. Keep Kilo's current parser behavior while migrating it to the shared normalized result.
5. Add structured discovery diagnostics: source, stale/fallback flag, fetched count, selectable
   count, excluded counts by reason, and a redacted error. Do not include API keys or raw headers.
6. Reuse one fetched catalog within an onboarding run so display, utility, and Explore selection
   do not refetch it. OpenCode excludes live ids absent from Pi; OpenRouter can select them because
   runtime registration materializes configured live ids through its uniform protocol.

Primary files:

- `src/modules/model-catalog/model-discovery.ts`
- `src/modules/model-catalog/model-discovery.test.ts`
- `src/modules/repos/providers.ts`
- new focused catalog parser modules under `src/modules/repos/` if the shared file becomes large

### Phase 3 — Generalized onboarding

1. Add `OpenRouter` and `OpenCode Zen` directly to the model-provider prompt.
2. Prompt for the provider-specific key and persist it to the runtime-home `.env` using existing
   secret prompt/write helpers.
3. Replace the Kilo-only `chooseModel()` branch with a provider-neutral searchable chooser driven
   by the normalized catalog service.
4. Reuse the chooser for manual utility and Explore role selection for all catalog providers.
5. Implement recommendation data and fallback selection after the decision gate is resolved.
6. Preserve manual entry, but validate provider qualification and effective runtime catalog
   resolution before writing config.
7. Correct `providerFromModel()` so existing `openrouter/...` and `opencode/...` configurations
   preselect the appropriate provider rather than falling back to KiloCode.
8. Keep provider config written before model config validation requires the provider. If the
   current action order prevents this, reorder the two writes while preserving failure handling
   and avoiding a partially selected unknown provider.

Primary files:

- `src/cli/onboarding.ts`
- `src/cli/onboarding.test.ts`
- `src/cli/prompts.ts` only if a reusable searchable-select helper is warranted

### Phase 4 — Runtime freshness and resolvability

1. Install Pi's native OpenRouter and OpenCode providers without replacing their model metadata or
   per-model API implementations.
2. Intersect OpenCode live availability with installed Pi metadata. For OpenRouter, use native Pi
   entries when present and append any configured live id missing from Pi to `provider.getModels()`
   with the provider's uniform Chat Completions API and compatibility behavior.
3. Preserve bundled Pi models as offline fallback, but do not describe stale OpenCode ids as live
   availability. OpenCode ids absent from Pi fail closed and are counted in diagnostics.
4. Add an exact invariant test: every selectable discovery result resolves through the
   corresponding runtime provider, including its expected API implementation.
5. Verify discovery failure leaves the bundled catalog usable and produces diagnostics rather
   than an empty chooser. Limit that offline fallback to curated candidate chains so Pi's lack of
   a general tool-capability field cannot expose unverified bundled models.
6. Defer dynamic OpenCode hydration until a validated Models.dev-to-Pi adapter mapping exists.
   OpenRouter dynamic materialization is permitted because its provider protocol is uniform; the
   fallback intentionally avoids claiming authoritative reasoning, context-window, or output-limit
   metadata. It applies conservative operational caps of 32,768 context tokens and 4,096 output
   tokens so Pi requests and Flue compaction remain usable until bundled metadata catches up.
7. Do not change models inside an active Flue conversation. Configured model changes continue to
   require a new session under Neondeck's stale-context contract.

Primary files:

- `src/modules/repos/providers.ts`
- `src/modules/repos/runtime-providers.ts`
- `src/providers.test.ts`
- `src/session-actions.test.ts` if stale-context expectations need explicit provider cases

### Phase 5 — Operator surfaces and documentation

1. Show OpenRouter and OpenCode in runtime provider status, credential readiness, and doctor
   output with environment-variable names but never secret values.
2. Let Runtime Overview enable/disable and change the key environment reference for the two
   first-class providers. Do not present their base URL or protocol as editable generic fields.
3. Remove any duplicate generic compatible provider with id `openrouter` or `opencode` through
   config validation/migration policy:
   - Reject creation of new generic providers using reserved first-class ids.
   - Run legacy-shape detection before the stricter reserved-id parser can reject an existing
     runtime config; startup must produce either a valid migrated config or an actionable error,
     not an unparseable home.
   - For existing configs, fail with a focused migration message or migrate only when the stored
     endpoint and protocol exactly match the official provider. Prefer an explicit, tested
     migration over silently changing behavior.
4. Update setup and configuration docs with provider ids, environment variables, model specifier
   examples, discovery behavior, restart/new-session semantics, and OpenCode's multi-protocol
   reason for being first-class.
5. Update the runtime Neondeck skill if its provider guidance enumerates supported providers.
6. Update `.plans/ROADMAP.md` Phase 13 status text and `.plans/DEVIATIONS.md` with the intentional
   expansion from generic-compatible OpenRouter to native first-class OpenRouter/OpenCode.
7. Add a minor changeset because this is a user-facing onboarding and provider feature.

Primary files:

- `web/src/features/runtime-overview/components/config-controls.tsx`
- `web/src/features/runtime-overview/components/config-controls.test.tsx`
- `src/cli/output.ts`
- `docs/src/pages/docs/getting-started.astro`
- `docs/src/pages/docs/configuration.astro`
- `src/skills/neondeck/SKILL.md`
- `.plans/ROADMAP.md`
- `.plans/DEVIATIONS.md`
- `.changeset/<generated-name>.md`

## Test Plan

### Catalog parser unit tests

- OpenRouter rich response maps id, name, context, reasoning, and strict free status while retaining
  Pi's model-level API.
- A live OpenRouter id absent from bundled Pi remains selectable and uses Chat Completions.
- OpenRouter pagination follows only same-origin links and stops on cycles or bounds.
- Tool-less and image-output-only OpenRouter models are excluded.
- `/models/user` authentication failure falls back to the public list and records the fallback.
- OpenCode live ids intersect bundled Pi metadata correctly.
- OpenCode live ids absent from Pi are excluded with diagnostics; matched ids retain each of Pi's
  four supported API implementations.
- Malformed OpenCode rows are excluded without making the catalog parser throw.
- Abort and timeout paths return suggested/bundled fallbacks without leaking credentials.

Use mocked `fetch`; routine tests must not call live provider endpoints.

### Provider and config tests

- Default env refs, enablement, status, and missing-key readiness for both providers.
- Raw key-looking values remain rejected where an env-var name is required.
- Reserved first-class ids cannot be created as generic compatible providers.
- Native provider registration preserves OpenRouter compatibility metadata, materializes a
  configured live id absent from bundled Pi, and preserves all four OpenCode API implementations.
- Disabled first-class providers remain unavailable even if the default env variable is present.
- Every selectable discovery model resolves through the runtime provider with the expected
  provider-qualified specifier and model-level API.

### Onboarding tests

- Existing model values preselect OpenRouter/OpenCode correctly.
- Disabled-default, search, no-match/manual, discovery-failure, and opt-in recommendation paths.
- Search results render provider-qualified ids and available hints.
- Utility and Explore manual selection use the catalog chooser rather than free text.
- Provider config and model config are written in a valid order.
- No raw secret appears in config, logs, diagnostic objects, or snapshots.

### Dashboard/status/docs tests

- Runtime Overview treats both providers as first-class and never exposes generic endpoint fields.
- Status API/frontend types include credential and enablement facts.
- Existing generic custom providers continue to work unchanged under non-reserved ids.
- Documentation examples pass format/build checks.

### Commands

Focused loop while implementing:

```sh
npm test -- src/modules/model-catalog/model-discovery.test.ts
npm test -- src/cli/onboarding.test.ts
npm test -- src/providers.test.ts
npm test -- src/config-actions.test.ts
npm test -- src/runtime-status.test.ts
npm run check
```

Final verification:

```sh
npm run verify
```

Optional live smoke, never part of ordinary CI:

```sh
# Uses configured runtime-home keys, prints ids/counts only, and redacts errors.
npm run smoke:model-discovery -- --provider openrouter
npm run smoke:model-discovery -- --provider opencode
```

If a smoke command is added, it must require an explicit opt-in environment flag, apply timeouts,
and never print authorization headers or secrets.

## Migration And Compatibility

- Existing `openrouter` generic-compatible entries are the principal migration risk. They
  currently shadow Pi's native provider with weaker metadata. The implementation must detect this
  before registering the first-class provider.
- Exact official configurations may be migrated to first-class `providers.openrouter` while
  preserving `enabled` and `apiKeyEnv`. Nonstandard OpenRouter proxies must be renamed to a
  non-reserved generic provider id; Neondeck must not silently discard a custom URL.
- An existing generic `opencode` entry cannot be migrated automatically, even at the official
  base URL: its implicit or explicit provider-wide Chat Completions protocol is not equivalent to
  native multi-protocol OpenCode behavior. It receives a focused rename/reconfigure error.
- Existing model strings do not need rewriting because both use the intended provider ids already.
- KiloCode, OpenAI, Anthropic, ChatGPT subscription, and non-reserved compatible providers remain
  behaviorally unchanged.

## Risks And Mitigations

- **Live catalog and runtime drift.** Mitigation: share parsers/materializers and test that every
  selectable result resolves through the runtime provider.
- **OpenCode protocol ambiguity.** Mitigation: join live availability with Pi metadata and fail
  closed on ids absent from Pi. Never assign one provider-wide protocol.
- **Provider catalog instability.** Mitigation: timeout, cancellation, cached/bundled fallback,
  curated offline candidates, and no onboarding hard failure solely because discovery is offline.
- **OpenRouter account restrictions.** Mitigation: prefer authenticated `/models/user`; label a
  public fallback and let the eventual inference error remain explicit if account policy changed.
- **Metadata overclaiming.** OpenRouter's `supported_parameters` can be a union across routed
  endpoints, and Pi's bundled OpenCode metadata can lag a currently deployed backend. Treat
  metadata as selection guidance, not a guarantee; provider errors remain visible.
- **Secret leakage.** Mitigation: provider-scoped fetch helpers, redacted diagnostics, no raw
  request headers in errors, existing env-ref-only config, and explicit tests.
- **Dependency-version coupling.** The implementation targets Flue 2.0.3/Pi 0.83.0. If those pins
  change during delivery, rerun the local Flue documentation search, inspect the target Pi
  provider factories/types, and reconcile refresh/model APIs before merging.

## Delivery Shape

Prefer one feature PR in this order:

1. First-class config and native provider registration.
2. Catalog parsing and runtime resolvability tests.
3. Onboarding chooser and disabled-until-approved recommendation mechanism.
4. Status/dashboard/docs/migration handling and changeset.

If review size requires a split, the safe boundary is:

- **PR 1:** provider config, native runtime registration, catalog services, and invariant tests.
- **PR 2:** onboarding, pending recommendation mechanism, migration UX, dashboard/status/docs,
  and changeset.

PR 1 must not expose live model selections that the runtime cannot yet resolve. PR 2 must not land
with placeholder recommendations presented as approved defaults.

## Definition Of Done

- `neondeck init` offers OpenRouter and OpenCode Zen as direct provider choices.
- Each provider accepts its API key without storing raw secrets in ordinary config.
- Each provider offers Search and Manual model selection; Recommended appears only after the
  separate provider-role default decision is approved.
- Search results come from a live provider catalog when available and fall back safely offline.
- Every selectable result is tool-capable and resolvable by the effective Pi provider.
- OpenRouter retains native Pi metadata for bundled ids; newly listed ids retain live chooser
  metadata and conservative runtime metadata with OpenRouter compatibility behavior.
- OpenCode models run through the correct model-level Pi protocol; no single generic protocol is
  applied to the entire gateway.
- Utility and Explore manual selection can search the same provider catalog.
- Exact official OpenRouter generic configurations have a tested automatic migration path.
  OpenCode legacy entries and custom proxies receive a focused rename/reconfigure error and are
  never silently rewritten.
- Runtime status, doctor output, dashboard config, docs, runtime skill, roadmap/deviation record,
  and changeset agree with the new provider boundary.
- Provider-role default recommendations remain disabled pending explicit approval.
- `npm run verify` passes.
