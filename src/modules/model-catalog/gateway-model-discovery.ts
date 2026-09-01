import type { Api, Model } from '@earendil-works/pi-ai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import {
  gatewayRecommendationModels,
  suggestedGatewayModels,
  type GatewayProviderId,
} from '../../lib/gateway-model-policy';
import type {
  DiscoveredModel,
  ModelDiscoveryDiagnostics,
  ModelDiscoveryResult,
} from './model-discovery';

type OpenRouterRawModel = {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
};

const openRouterCatalogUrl =
  'https://openrouter.ai/api/v1/models?supported_parameters=tools&output_modalities=text';
const openRouterUserCatalogUrl = 'https://openrouter.ai/api/v1/models/user';
const openCodeCatalogUrl = 'https://opencode.ai/zen/v1/models';
const maxCatalogPages = 20;
const fetchTimeoutMs = 10_000;

export async function discoverGatewayModels(input: {
  provider: GatewayProviderId;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  const signal = combinedSignal(input.signal);
  if (input.provider === 'opencode') {
    const catalog = await fetchCatalog(openCodeCatalogUrl, {
      signal,
    });
    if (!catalog.ok) return fallbackResult('opencode', catalog.error);
    return parsedResult(
      'opencode',
      catalog.rows,
      parseOpenCodeModels(catalog.rows),
    );
  }

  let warning: string | undefined;
  if (input.apiKey) {
    const authenticated = await fetchCatalog(openRouterUserCatalogUrl, {
      apiKey: input.apiKey,
      signal,
    });
    if (authenticated.ok) {
      return parsedResult(
        'openrouter',
        authenticated.rows,
        parseOpenRouterModels(authenticated.rows),
      );
    }
    warning = `${authenticated.error} Using OpenRouter's public catalog instead; account policy filters may differ.`;
  }

  const publicCatalog = await fetchCatalog(openRouterCatalogUrl, {
    signal,
  });
  if (!publicCatalog.ok) {
    return fallbackResult('openrouter', publicCatalog.error, warning);
  }
  return {
    ...parsedResult(
      'openrouter',
      publicCatalog.rows,
      parseOpenRouterModels(publicCatalog.rows),
    ),
    ...(warning ? { warning } : {}),
  };
}

export function bundledGatewayModels(
  provider: GatewayProviderId,
): DiscoveredModel[] {
  const runtimeById = new Map(
    providerFactory(provider)
      .getModels()
      .map((model) => [model.id, model]),
  );
  const models: DiscoveredModel[] = [];
  for (const recommendation of suggestedGatewayModels(provider)) {
    const model = runtimeById.get(recommendation.model);
    if (model) {
      models.push(discoveredFromRuntime(provider, model, 'pi-bundled'));
    }
  }
  return models.sort(compareModels);
}

export function parseOpenRouterModels(
  rows: unknown[],
  runtimeModels: readonly Model<Api>[] = openrouterProvider().getModels(),
) {
  const runtimeById = new Map(runtimeModels.map((model) => [model.id, model]));
  const excluded = emptyExcluded();
  const models: DiscoveredModel[] = [];

  for (const row of rows) {
    if (!isPlainRecord(row)) {
      excluded.invalid += 1;
      continue;
    }
    const raw = row as OpenRouterRawModel;
    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
      excluded.invalid += 1;
      continue;
    }
    const parameters = Array.isArray(raw.supported_parameters)
      ? raw.supported_parameters
      : [];
    const output = isPlainRecord(raw.architecture)
      ? raw.architecture.output_modalities
      : undefined;
    if (
      !parameters.includes('tools') ||
      !Array.isArray(output) ||
      !output.includes('text')
    ) {
      excluded.unsupported += 1;
      continue;
    }
    const runtimeModel = runtimeById.get(raw.id);
    models.push({
      id: `openrouter/${raw.id}`,
      provider: 'openrouter',
      model: raw.id,
      name:
        typeof raw.name === 'string'
          ? raw.name
          : (runtimeModel?.name ?? raw.id),
      api: runtimeModel?.api ?? 'openai-completions',
      contextLength:
        typeof raw.context_length === 'number'
          ? raw.context_length
          : (runtimeModel?.contextWindow ?? null),
      reasoning:
        parameters.includes('reasoning') || Boolean(runtimeModel?.reasoning),
      isFree: zeroPrice(raw.pricing),
      createdAt: catalogTimestamp(raw.created),
      recommendedIndex: recommendationIndex('openrouter', raw.id),
      source: 'provider-live',
    });
  }

  return { models: models.sort(compareModels), excluded };
}

export function parseOpenCodeModels(
  rows: unknown[],
  runtimeModels: readonly Model<Api>[] = opencodeProvider().getModels(),
) {
  const runtimeById = new Map(runtimeModels.map((model) => [model.id, model]));
  const excluded = emptyExcluded();
  const models: DiscoveredModel[] = [];

  for (const row of rows) {
    if (!isPlainRecord(row)) {
      excluded.invalid += 1;
      continue;
    }
    const id = row.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      excluded.invalid += 1;
      continue;
    }
    const runtimeModel = runtimeById.get(id);
    if (!runtimeModel) {
      excluded.unavailableInRuntime += 1;
      continue;
    }
    models.push(
      discoveredFromRuntime(
        'opencode',
        runtimeModel,
        'provider-live',
        catalogTimestamp(row.created),
      ),
    );
  }

  return { models: models.sort(compareModels), excluded };
}

function parsedResult(
  provider: GatewayProviderId,
  rows: unknown[],
  parsed: ReturnType<typeof parseOpenRouterModels>,
): ModelDiscoveryResult {
  if (parsed.models.length === 0) {
    return fallbackResult(
      provider,
      `${provider} discovery returned no usable models.`,
      undefined,
      { fetchedCount: rows.length, excluded: parsed.excluded },
    );
  }
  return {
    ok: true,
    provider,
    models: parsed.models,
    diagnostics: {
      source: 'provider-live',
      stale: false,
      fetchedCount: rows.length,
      selectableCount: parsed.models.length,
      excluded: parsed.excluded,
    },
  };
}

function fallbackResult(
  provider: GatewayProviderId,
  error: string,
  warning?: string,
  liveAttempt?: {
    fetchedCount: number;
    excluded: ModelDiscoveryDiagnostics['excluded'];
  },
): ModelDiscoveryResult {
  const models = bundledGatewayModels(provider);
  return {
    ok: false,
    provider,
    models,
    diagnostics: {
      source: 'pi-bundled',
      stale: true,
      fetchedCount: liveAttempt?.fetchedCount ?? 0,
      selectableCount: models.length,
      excluded: liveAttempt?.excluded ?? emptyExcluded(),
    },
    ...(warning ? { warning } : {}),
    error,
  };
}

function discoveredFromRuntime(
  provider: GatewayProviderId,
  model: Model<Api>,
  source: DiscoveredModel['source'],
  createdAt: number | null = null,
): DiscoveredModel {
  return {
    id: `${provider}/${model.id}`,
    provider,
    model: model.id,
    name: model.name,
    api: model.api,
    contextLength: model.contextWindow || null,
    reasoning: model.reasoning,
    isFree: model.cost.input === 0 && model.cost.output === 0,
    createdAt,
    recommendedIndex: recommendationIndex(provider, model.id),
    source,
  };
}

async function fetchCatalog(
  url: string,
  options: { apiKey?: string; signal?: AbortSignal },
): Promise<
  { ok: true; rows: unknown[] } | { ok: false; error: string; status?: number }
> {
  const expectedOrigin = new URL(url).origin;
  const visited = new Set<string>();
  const rows: unknown[] = [];
  let currentUrl: string | undefined = url;

  for (let page = 0; currentUrl && page < maxCatalogPages; page += 1) {
    if (visited.has(currentUrl)) {
      return {
        ok: false,
        error: 'Model discovery pagination repeated a page.',
      };
    }
    visited.add(currentUrl);

    const response = await fetch(currentUrl, {
      headers: {
        Accept: 'application/json',
        ...(options.apiKey
          ? { Authorization: `Bearer ${options.apiKey}` }
          : {}),
      },
      signal: options.signal,
    }).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    if (response instanceof Error) {
      return { ok: false, error: response.message };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Model discovery returned HTTP ${response.status}.`,
      };
    }
    const payload = await response.json().catch(() => null);
    if (!isPlainRecord(payload) || !Array.isArray(payload.data)) {
      return {
        ok: false,
        error: 'Model discovery returned an unexpected response.',
      };
    }
    rows.push(...payload.data);

    const continuation = catalogContinuation(payload);
    if (continuation === undefined || continuation === null) {
      currentUrl = undefined;
      continue;
    }
    if (typeof continuation !== 'string' || continuation.trim().length === 0) {
      return {
        ok: false,
        error: 'Model discovery returned an invalid pagination link.',
      };
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(continuation, currentUrl);
    } catch {
      return {
        ok: false,
        error: 'Model discovery returned an invalid pagination link.',
      };
    }
    if (nextUrl.origin !== expectedOrigin) {
      return {
        ok: false,
        error: 'Model discovery rejected a cross-origin pagination link.',
      };
    }
    currentUrl = nextUrl.href;
  }

  if (currentUrl) {
    return {
      ok: false,
      error: `Model discovery exceeded ${maxCatalogPages} pages.`,
    };
  }
  return { ok: true, rows };
}

function catalogContinuation(payload: Record<string, unknown>) {
  if (payload.next !== undefined) return payload.next;
  const pagination = isPlainRecord(payload.pagination)
    ? payload.pagination
    : undefined;
  if (pagination?.next !== undefined) return pagination.next;
  const links = isPlainRecord(payload.links) ? payload.links : undefined;
  return links?.next;
}

function providerFactory(provider: GatewayProviderId) {
  return provider === 'openrouter' ? openrouterProvider() : opencodeProvider();
}

function recommendationIndex(provider: GatewayProviderId, model: string) {
  const index = gatewayRecommendationModels(
    provider,
    'displayAssistant',
  ).indexOf(model);
  return index >= 0 ? index : null;
}

function zeroPrice(pricing: OpenRouterRawModel['pricing']): boolean | null {
  if (!isPlainRecord(pricing)) return null;
  const prompt = finitePrice(pricing.prompt);
  const completion = finitePrice(pricing.completion);
  return prompt !== null && completion !== null
    ? prompt === 0 && completion === 0
    : null;
}

function finitePrice(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function catalogTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function emptyExcluded(): ModelDiscoveryDiagnostics['excluded'] {
  return { invalid: 0, unsupported: 0, unavailableInRuntime: 0 };
}

function compareModels(left: DiscoveredModel, right: DiscoveredModel) {
  const leftIndex = left.recommendedIndex ?? Number.POSITIVE_INFINITY;
  const rightIndex = right.recommendedIndex ?? Number.POSITIVE_INFINITY;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.id.localeCompare(right.id);
}

function combinedSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(fetchTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
