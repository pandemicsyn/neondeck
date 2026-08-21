import { openAiCodexModels } from '../../model-defaults';
import { registeredProviderIds, type RegisteredProviderId } from './providers';
import * as v from 'valibot';

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

const kiloRawModelSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.unknown()),
  context_length: v.optional(v.unknown()),
  architecture: v.optional(v.unknown()),
  supported_parameters: v.array(v.unknown()),
  preferredIndex: v.optional(v.unknown()),
  isFree: v.optional(v.unknown()),
});
const kiloModelsResponseSchema = v.looseObject({
  data: v.array(v.unknown()),
});
const kiloArchitectureSchema = v.looseObject({
  output_modalities: v.optional(v.array(v.unknown()), []),
});

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
  return registeredProviderIds.some((id) => id === provider);
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
    headers: kiloHeaders(input.apiKey, organizationId),
    signal: combinedSignal(input.signal),
  }).catch((error) =>
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

  const parsedResponse = v.safeParse(
    kiloModelsResponseSchema,
    await response.json().catch(() => null),
  );
  if (!parsedResponse.success) {
    return {
      ok: false,
      provider: 'kilocode',
      models: suggestedModels('kilocode'),
      error: 'Kilo model discovery returned an unexpected response.',
    };
  }

  const models = parsedResponse.output.data
    .map((row) => kiloModel(row))
    .filter((model): model is DiscoveredModel => Boolean(model))
    .sort(compareModels);

  return {
    ok: true,
    provider: 'kilocode',
    models: models.length > 0 ? models : suggestedModels('kilocode'),
  };
}

function kiloModel<TModel>(row: TModel): DiscoveredModel | null {
  const parsed = v.safeParse(kiloRawModelSchema, row);
  if (!parsed.success || parsed.output.id.trim().length === 0) {
    return null;
  }

  const model = parsed.output;
  const architecture = v.safeParse(kiloArchitectureSchema, model.architecture);
  const outputModalities = architecture.success
    ? architecture.output.output_modalities
    : [];
  if (outputModalities.includes('image')) {
    return null;
  }

  const supportedParameters = model.supported_parameters;
  if (!supportedParameters.includes('tools')) {
    return null;
  }

  return {
    id: `kilocode/${model.id}`,
    provider: 'kilocode',
    model: model.id,
    name: metadataValue(v.string(), model.name) ?? model.id,
    contextLength: metadataValue(v.number(), model.context_length),
    reasoning: supportedParameters.includes('reasoning'),
    isFree: metadataValue(v.boolean(), model.isFree),
    recommendedIndex: metadataValue(v.number(), model.preferredIndex),
  };
}

function metadataValue<TOutput>(
  schema: v.GenericSchema<unknown, TOutput>,
  value: Parameters<typeof v.safeParse>[1],
) {
  const parsed = v.safeParse(schema, value);
  return parsed.success ? parsed.output : null;
}

function kiloHeaders(
  apiKey: string | undefined,
  organizationId: string | undefined,
) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
  if (organizationId) headers.set('X-KiloCode-OrganizationId', organizationId);
  return headers;
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
