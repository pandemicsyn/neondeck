import { registeredProviderIds, type RegisteredProviderId } from './providers';

export type DiscoveredModel = {
  id: string;
  provider: RegisteredProviderId;
  model: string;
  name: string;
  contextLength: number | null;
  reasoning: boolean;
  isFree: boolean | null;
  recommendedIndex: number | null;
};

export type ModelDiscoveryResult = {
  ok: boolean;
  provider: RegisteredProviderId;
  models: DiscoveredModel[];
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

export async function discoverModels(input: {
  provider: RegisteredProviderId;
  apiKey?: string;
  organizationId?: string;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  if (input.provider === 'kilocode') {
    return discoverKilocodeModels({ ...input, provider: 'kilocode' });
  }

  return {
    ok: true,
    provider: input.provider,
    models: suggestedModels(input.provider),
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
    contextLength:
      typeof model.context_length === 'number' ? model.context_length : null,
    reasoning: supportedParameters.includes('reasoning'),
    isFree: typeof model.isFree === 'boolean' ? model.isFree : null,
    recommendedIndex:
      typeof model.preferredIndex === 'number' ? model.preferredIndex : null,
  };
}

function suggestedModel(
  provider: RegisteredProviderId,
  model: string,
  name: string,
  reasoning: boolean,
  recommendedIndex: number,
): DiscoveredModel {
  return {
    id: `${provider}/${model}`,
    provider,
    model,
    name,
    contextLength: null,
    reasoning,
    isFree: null,
    recommendedIndex,
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
