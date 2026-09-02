import { openAiCodexModels } from '../../model-defaults';
import { googleVertexProvider } from '@earendil-works/pi-ai/providers/google-vertex';
import {
  gatewayRecommendationModels,
  suggestedGatewayModels,
  type GatewayModelRole,
} from '../../lib/gateway-model-policy';
import {
  registeredProviderIds,
  type RegisteredProviderId,
} from '../../../shared/provider-policy';

export type DiscoveredModel = {
  id: string;
  provider: RegisteredProviderId;
  model: string;
  name: string;
  api: string | null;
  contextLength: number | null;
  reasoning: boolean;
  isFree: boolean | null;
  createdAt: number | null;
  recommendedIndex: number | null;
  source: 'provider-live' | 'pi-bundled' | 'suggested';
};

export type ModelDiscoveryDiagnostics = {
  source: DiscoveredModel['source'];
  stale: boolean;
  fetchedCount: number;
  selectableCount: number;
  excluded: {
    invalid: number;
    unsupported: number;
    unavailableInRuntime: number;
  };
};

export type ModelDiscoveryResult = {
  ok: boolean;
  provider: RegisteredProviderId;
  models: DiscoveredModel[];
  diagnostics: ModelDiscoveryDiagnostics;
  warning?: string;
  error?: string;
};

type KiloRawModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: {
    output_modalities?: unknown;
  };
  supported_parameters?: unknown;
  preferredIndex?: unknown;
  isFree?: unknown;
};

const kiloApiBase = 'https://api.kilo.ai';
const kiloFetchTimeoutMs = 10_000;
const googleVertexRecommendations = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
] as const;
const googleVertexRoleRecommendations: Record<
  GatewayModelRole,
  readonly (typeof googleVertexRecommendations)[number][]
> = {
  displayAssistant: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro'],
  utility: [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
  ],
  explore: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
};

export async function discoverModels(input: {
  provider: RegisteredProviderId;
  apiKey?: string;
  organizationId?: string;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  if (input.provider === 'kilocode') {
    return discoverKilocodeModels({ ...input, provider: 'kilocode' });
  }

  if (input.provider === 'openrouter' || input.provider === 'opencode') {
    const { discoverGatewayModels } = await import('./gateway-model-discovery');
    return discoverGatewayModels({
      provider: input.provider,
      apiKey: input.apiKey,
      signal: input.signal,
    });
  }

  if (input.provider === 'google-vertex') {
    const models = bundledGoogleVertexModels();
    return {
      ok: true,
      provider: 'google-vertex',
      models,
      diagnostics: discoveryDiagnostics('pi-bundled', false, models.length),
    };
  }

  const models = suggestedModels(input.provider);
  return {
    ok: true,
    provider: input.provider,
    models,
    diagnostics: discoveryDiagnostics('suggested', false, models.length),
  };
}

export function suggestedModels(
  provider: RegisteredProviderId,
): DiscoveredModel[] {
  if (provider === 'openai') {
    return [
      suggestedModel('openai', 'gpt-5.5', 'GPT-5.5', true, 0),
      suggestedModel('openai', 'gpt-5', 'GPT-5', true, 1),
      suggestedModel('openai', 'gpt-5-mini', 'GPT-5 Mini', true, 2),
    ];
  }

  if (provider === 'anthropic') {
    return [
      suggestedModel(
        'anthropic',
        'claude-sonnet-4-6',
        'Claude Sonnet 4.6',
        true,
        0,
      ),
      suggestedModel(
        'anthropic',
        'claude-opus-4-1',
        'Claude Opus 4.1',
        true,
        1,
      ),
    ];
  }

  if (provider === 'openai-codex') {
    return openAiCodexModels.map((model, recommendedIndex) =>
      suggestedModel(
        'openai-codex',
        model.id,
        model.name,
        true,
        recommendedIndex,
      ),
    );
  }

  if (provider === 'openrouter' || provider === 'opencode') {
    return suggestedGatewayModels(provider).map(({ model, name }) =>
      suggestedModel(provider, model, name, true, null),
    );
  }

  if (provider === 'google-vertex') return bundledGoogleVertexModels();

  return [
    suggestedModel(
      'kilocode',
      'kilo-auto/balanced',
      'Kilo Auto Balanced',
      true,
      0,
    ),
    suggestedModel('kilocode', 'kilo-auto/free', 'Kilo Auto Free', true, 1),
  ];
}

export function bundledGoogleVertexModels(): DiscoveredModel[] {
  return googleVertexProvider()
    .getModels()
    .map((model) => ({
      id: `google-vertex/${model.id}`,
      provider: 'google-vertex' as const,
      model: model.id,
      name: model.name,
      api: model.api,
      contextLength: model.contextWindow || null,
      reasoning: model.reasoning,
      isFree: false,
      createdAt: null,
      recommendedIndex: googleVertexRecommendationIndex(model.id),
      source: 'pi-bundled' as const,
    }))
    .sort(compareModels);
}

function googleVertexRecommendationIndex(model: string) {
  const index = googleVertexRecommendations.indexOf(
    model as (typeof googleVertexRecommendations)[number],
  );
  return index >= 0 ? index : null;
}

export function recommendedCatalogModel(
  provider: string,
  role: GatewayModelRole,
  models: readonly DiscoveredModel[],
) {
  if (provider === 'google-vertex') {
    for (const modelId of googleVertexRoleRecommendations[role]) {
      const match = models.find((model) => model.model === modelId);
      if (match) return match.id;
    }
    return undefined;
  }
  if (provider !== 'openrouter' && provider !== 'opencode') return undefined;
  for (const modelId of gatewayRecommendationModels(provider, role)) {
    const match = models.find((model) => model.model === modelId);
    if (match) return match.id;
  }
  return undefined;
}

export function isDiscoverableProvider(
  provider: string,
): provider is RegisteredProviderId {
  return registeredProviderIds.includes(provider as RegisteredProviderId);
}

async function discoverKilocodeModels(input: {
  provider: 'kilocode';
  apiKey?: string;
  organizationId?: string;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  const organizationId = input.organizationId?.trim();
  const baseUrl = organizationId
    ? `${kiloApiBase}/api/organizations/${encodeURIComponent(organizationId)}`
    : `${kiloApiBase}/api/openrouter`;
  const response: Response | Error = await fetch(`${baseUrl}/models`, {
    headers: {
      'Content-Type': 'application/json',
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      ...(organizationId
        ? { 'X-KiloCode-OrganizationId': organizationId }
        : {}),
    },
    signal: combinedSignal(input.signal),
  }).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );

  if (response instanceof Error) {
    return {
      ok: false,
      provider: 'kilocode',
      models: suggestedModels('kilocode'),
      diagnostics: discoveryDiagnostics('suggested', true, 0),
      error: response.message,
    };
  }

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && input.apiKey) {
      return discoverKilocodeModels({ provider: 'kilocode' });
    }

    return {
      ok: false,
      provider: 'kilocode',
      models: suggestedModels('kilocode'),
      diagnostics: discoveryDiagnostics('suggested', true, 0),
      error: `Kilo model discovery returned HTTP ${response.status}.`,
    };
  }

  const data = (await response.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  const rows = Array.isArray(data?.data) ? data.data : null;
  if (!rows) {
    return {
      ok: false,
      provider: 'kilocode',
      models: suggestedModels('kilocode'),
      diagnostics: discoveryDiagnostics('suggested', true, 0),
      error: 'Kilo model discovery returned an unexpected response.',
    };
  }

  const models = rows
    .map((row) => kiloModel(row))
    .filter((model): model is DiscoveredModel => Boolean(model))
    .sort(compareModels);

  return {
    ok: true,
    provider: 'kilocode',
    models: models.length > 0 ? models : suggestedModels('kilocode'),
    diagnostics: discoveryDiagnostics(
      models.length > 0 ? 'provider-live' : 'suggested',
      models.length === 0,
      rows.length,
      models.length,
    ),
  };
}

function kiloModel(row: unknown): DiscoveredModel | null {
  const model = row as KiloRawModel;
  if (typeof model.id !== 'string' || model.id.trim().length === 0) {
    return null;
  }

  const outputModalities = model.architecture?.output_modalities;
  if (Array.isArray(outputModalities) && outputModalities.includes('image')) {
    return null;
  }

  const supportedParameters = model.supported_parameters;
  if (
    !Array.isArray(supportedParameters) ||
    !supportedParameters.includes('tools')
  ) {
    return null;
  }

  return {
    id: `kilocode/${model.id}`,
    provider: 'kilocode',
    model: model.id,
    name: typeof model.name === 'string' ? model.name : model.id,
    api: 'openai-completions',
    contextLength:
      typeof model.context_length === 'number' ? model.context_length : null,
    reasoning: supportedParameters.includes('reasoning'),
    isFree: typeof model.isFree === 'boolean' ? model.isFree : null,
    createdAt: null,
    recommendedIndex:
      typeof model.preferredIndex === 'number' ? model.preferredIndex : null,
    source: 'provider-live',
  };
}

function suggestedModel(
  provider: RegisteredProviderId,
  model: string,
  name: string,
  reasoning: boolean,
  recommendedIndex: number | null,
): DiscoveredModel {
  return {
    id: `${provider}/${model}`,
    provider,
    model,
    name,
    api: null,
    contextLength: null,
    reasoning,
    isFree: null,
    createdAt: null,
    recommendedIndex,
    source: 'suggested',
  };
}

function discoveryDiagnostics(
  source: DiscoveredModel['source'],
  stale: boolean,
  fetchedCount: number,
  selectableCount = fetchedCount,
): ModelDiscoveryDiagnostics {
  return {
    source,
    stale,
    fetchedCount,
    selectableCount,
    excluded: {
      invalid: 0,
      unsupported: Math.max(0, fetchedCount - selectableCount),
      unavailableInRuntime: 0,
    },
  };
}

function compareModels(left: DiscoveredModel, right: DiscoveredModel) {
  const leftIndex = left.recommendedIndex ?? Number.POSITIVE_INFINITY;
  const rightIndex = right.recommendedIndex ?? Number.POSITIVE_INFINITY;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.id.localeCompare(right.id);
}

function combinedSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(kiloFetchTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
