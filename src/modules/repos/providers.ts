import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type Model,
  type ModelAuth,
  type Provider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type AppConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { resolveAgentModelSelection } from '../runtime/agent-config';

export const registeredProviderIds = [
  'kilocode',
  'openai',
  'anthropic',
  'openai-codex',
] as const;

export type RegisteredProviderId = (typeof registeredProviderIds)[number];
export type ProviderId = RegisteredProviderId | string;

export type KilocodeProviderStatus = {
  id: 'kilocode';
  allowed: true;
  enabled: boolean;
  apiKeyEnv: string;
  organizationIdEnv: string | null;
  apiKeyPresent: boolean;
  organizationIdPresent: boolean;
};

export type ApiKeyProviderStatus = {
  id: 'openai' | 'anthropic';
  allowed: true;
  enabled: boolean;
  apiKeyEnv: string;
  apiKeyPresent: boolean;
};

export type OpenAiCodexProviderStatus = {
  id: 'openai-codex';
  allowed: true;
  enabled: boolean;
};

export type OpenAiCompatibleProviderStatus = {
  id: string;
  allowed: true;
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string | null;
  apiKeyPresent: boolean;
  api: 'openai-completions' | 'openai-responses';
  contextWindow: number | null;
  maxTokens: number | null;
};

export type ProviderRuntimeRegistration = {
  id: ProviderId;
  provider: Provider;
};

export type ProviderModelSpecifierSource = () => readonly string[];

const defaultKilocodeApiKeyEnv = 'KILOCODE_API_KEY';
const defaultKilocodeOrganizationIdEnv = 'KILOCODE_ORGANIZATION_ID';
const defaultOpenAiApiKeyEnv = 'OPENAI_API_KEY';
const defaultAnthropicApiKeyEnv = 'ANTHROPIC_API_KEY';
const kilocodeGatewayBaseUrl = 'https://api.kilo.ai/api/gateway';
const kilocodeGatewayMaxTokens = 16_384;

export function readKilocodeProviderCredentials(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<AppConfig, 'providers'>,
) {
  const status = resolveKilocodeProviderStatus(config, env);
  if (!status.enabled) {
    return {
      apiKey: undefined,
      organizationId: undefined,
    };
  }

  return {
    apiKey: env[status.apiKeyEnv],
    organizationId: status.organizationIdEnv
      ? env[status.organizationIdEnv]
      : undefined,
  };
}

export function readProviderConfigSync(paths: RuntimePaths = runtimePaths()) {
  ensureRuntimeHomeSync(paths);
  return readRuntimeJsonSync(paths.config, parseAppConfig);
}

export function providerRuntimeRegistrations(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<AppConfig, 'models' | 'providers'>,
  modelSpecifiers: ProviderModelSpecifierSource = () =>
    effectiveModelSpecifiers(config, env),
): ProviderRuntimeRegistration[] {
  const registrations: ProviderRuntimeRegistration[] = [];
  const kilocode = resolveKilocodeProviderStatus(config, env);
  const organizationId = kilocode.organizationIdEnv
    ? env[kilocode.organizationIdEnv]
    : undefined;
  const kilocodeHeaders = organizationId
    ? { 'X-KiloCode-OrganizationId': organizationId }
    : undefined;
  const kilocodeProvider = createProvider({
    id: 'kilocode',
    name: 'Kilo Code',
    baseUrl: kilocodeGatewayBaseUrl,
    auth: {
      apiKey: configuredApiKeyAuth({
        name: 'Kilo Code API key',
        enabled: kilocode.enabled,
        apiKey: env[kilocode.apiKeyEnv],
        source: kilocode.apiKeyEnv,
      }),
    },
    models: [],
    fetchModels: async ({ signal }) => {
      const { discoverModels } = await import('./model-discovery');
      const discovered = await discoverModels({
        provider: 'kilocode',
        apiKey: env[kilocode.apiKeyEnv],
        organizationId,
        signal,
      });
      return discovered.models.map((model) =>
        compatibleModel({
          id: model.model,
          name: model.name,
          provider: 'kilocode',
          api: 'openai-completions',
          baseUrl: kilocodeGatewayBaseUrl,
          headers: kilocodeHeaders,
          reasoning: model.reasoning,
          contextWindow: model.contextLength ?? 0,
          maxTokens: kilocodeGatewayMaxTokens,
        }),
      );
    },
    api: openAICompletionsApi(),
  });
  registrations.push({
    id: 'kilocode',
    provider: withSelectedModels(kilocodeProvider, () =>
      modelIdsForProvider('kilocode', modelSpecifiers()).map((id) =>
        compatibleModel({
          id,
          name: id,
          provider: 'kilocode',
          api: 'openai-completions',
          baseUrl: kilocodeGatewayBaseUrl,
          headers: kilocodeHeaders,
          reasoning: true,
          contextWindow: 0,
          maxTokens: kilocodeGatewayMaxTokens,
        }),
      ),
    ),
  });

  registrations.push(
    builtInApiKeyProviderRuntimeRegistration(
      resolveOpenAiProviderStatus(config, env),
      env,
    ),
    builtInApiKeyProviderRuntimeRegistration(
      resolveAnthropicProviderStatus(config, env),
      env,
    ),
  );

  for (const provider of resolveOpenAiCompatibleProviderStatuses(config, env)) {
    if (!provider.enabled) continue;
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : 'unused';
    const modelFactory = () =>
      modelIdsForProvider(provider.id, modelSpecifiers()).map((id) =>
        compatibleModel({
          id,
          provider: provider.id,
          api: provider.api,
          baseUrl: provider.baseUrl,
          reasoning: false,
          contextWindow: provider.contextWindow ?? 0,
          maxTokens: provider.maxTokens ?? 0,
        }),
      );
    const base = createProvider({
      id: provider.id,
      name: provider.id,
      baseUrl: provider.baseUrl,
      auth: {
        apiKey: configuredApiKeyAuth({
          name: `${provider.id} API key`,
          enabled: true,
          apiKey,
          source: provider.apiKeyEnv ?? 'keyless endpoint',
        }),
      },
      models: [],
      api:
        provider.api === 'openai-responses'
          ? openAIResponsesApi()
          : openAICompletionsApi(),
    });
    registrations.push({
      id: provider.id,
      provider: withLiveModels(base, modelFactory),
    });
  }

  return registrations;
}

export function resolveKilocodeProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): KilocodeProviderStatus {
  const kilocode = config?.providers?.kilocode;
  const apiKeyEnv = kilocode?.apiKeyEnv ?? defaultKilocodeApiKeyEnv;
  const organizationIdEnv =
    kilocode?.organizationIdEnv ??
    (env[defaultKilocodeOrganizationIdEnv]
      ? defaultKilocodeOrganizationIdEnv
      : null);

  return {
    id: 'kilocode',
    allowed: true,
    enabled: kilocode?.enabled ?? true,
    apiKeyEnv,
    organizationIdEnv,
    apiKeyPresent: Boolean(env[apiKeyEnv]),
    organizationIdPresent: organizationIdEnv
      ? Boolean(env[organizationIdEnv])
      : false,
  };
}

export function resolveOpenAiProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyProviderStatus {
  return resolveApiKeyProviderStatus(
    'openai',
    config?.providers?.openai,
    defaultOpenAiApiKeyEnv,
    env,
  );
}

export function resolveAnthropicProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyProviderStatus {
  return resolveApiKeyProviderStatus(
    'anthropic',
    config?.providers?.anthropic,
    defaultAnthropicApiKeyEnv,
    env,
  );
}

export function resolveOpenAiCodexProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
): OpenAiCodexProviderStatus {
  return {
    id: 'openai-codex',
    allowed: true,
    enabled: config?.providers?.openaiCodex?.enabled ?? false,
  };
}

export function resolveOpenAiCompatibleProviderStatuses(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleProviderStatus[] {
  return (config?.providers?.openaiCompatible ?? []).map((provider) => ({
    id: provider.id,
    allowed: true,
    enabled: provider.enabled ?? true,
    baseUrl: provider.baseUrl.replace(/\/+$/, ''),
    apiKeyEnv: provider.apiKeyEnv ?? null,
    apiKeyPresent: provider.apiKeyEnv
      ? Boolean(env[provider.apiKeyEnv])
      : false,
    api: provider.api ?? 'openai-completions',
    contextWindow: provider.contextWindow ?? null,
    maxTokens: provider.maxTokens ?? null,
  }));
}

export function isRegisteredProvider(
  provider: string,
  config?: Pick<AppConfig, 'providers'>,
): boolean {
  return (
    registeredProviderIds.includes(provider as RegisteredProviderId) ||
    resolveOpenAiCompatibleProviderStatuses(config).some(
      (candidate) => candidate.id === provider,
    )
  );
}

export function configuredProviderIds(
  config?: Pick<AppConfig, 'providers'>,
): string[] {
  return [
    ...registeredProviderIds,
    ...resolveOpenAiCompatibleProviderStatuses(config).map(
      (provider) => provider.id,
    ),
  ];
}

function resolveApiKeyProviderStatus(
  id: ApiKeyProviderStatus['id'],
  config: { enabled?: boolean; apiKeyEnv?: string } | undefined,
  defaultApiKeyEnv: string,
  env: NodeJS.ProcessEnv,
): ApiKeyProviderStatus {
  const apiKeyEnv = config?.apiKeyEnv ?? defaultApiKeyEnv;

  return {
    id,
    allowed: true,
    enabled: config?.enabled ?? true,
    apiKeyEnv,
    apiKeyPresent: Boolean(env[apiKeyEnv]),
  };
}

function builtInApiKeyProviderRuntimeRegistration(
  status: ApiKeyProviderStatus,
  env: NodeJS.ProcessEnv,
): ProviderRuntimeRegistration {
  const builtIn =
    status.id === 'openai' ? openaiProvider() : anthropicProvider();
  return {
    id: status.id,
    provider: {
      ...builtIn,
      auth: {
        apiKey: configuredApiKeyAuth({
          name: `${builtIn.name} API key`,
          enabled: status.enabled,
          apiKey: env[status.apiKeyEnv],
          source: status.apiKeyEnv,
        }),
      },
    },
  };
}

export function openAiCodexProviderFromModelAuth(
  auth: ModelAuth | undefined,
): Provider {
  const builtIn = openaiCodexProvider();
  return {
    ...builtIn,
    auth: {
      apiKey: {
        name: 'OpenAI Codex subscription',
        resolve: async () =>
          auth
            ? {
                auth,
                source: 'Neondeck ChatGPT subscription',
              }
            : undefined,
      },
    },
  };
}

export function effectiveModelSpecifiers(
  config?: Pick<AppConfig, 'models'>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const models = resolveAgentModelSelection(config, env);
  return Array.from(
    new Set([
      models.displayAssistant,
      models.prReview,
      models.utility,
      models.selfImprovement,
      ...Object.values(models.subagents),
    ]),
  );
}

function configuredApiKeyAuth(input: {
  name: string;
  enabled: boolean;
  apiKey: string | undefined;
  source: string;
}): ApiKeyAuth {
  return {
    name: input.name,
    check: async () =>
      input.enabled && input.apiKey
        ? { source: input.source, type: 'api_key' }
        : undefined,
    resolve: async () =>
      input.enabled && input.apiKey
        ? {
            auth: { apiKey: input.apiKey },
            source: input.source,
          }
        : undefined,
  };
}

function withLiveModels<TProvider extends Provider>(
  provider: TProvider,
  getModels: () => readonly Model<Api>[],
): TProvider {
  return {
    ...provider,
    getModels,
  };
}

function withSelectedModels<TProvider extends Provider>(
  provider: TProvider,
  fallbackModels: () => readonly Model<Api>[],
): TProvider {
  const discoveredModels = provider.getModels.bind(provider);
  return {
    ...provider,
    getModels() {
      const discovered = discoveredModels();
      return fallbackModels().map(
        (fallback) =>
          discovered.find((model) => model.id === fallback.id) ?? fallback,
      );
    },
  };
}

function modelIdsForProvider(
  provider: string,
  specifiers: readonly string[],
): string[] {
  return Array.from(
    new Set(
      specifiers.flatMap((specifier) => {
        const slash = specifier.indexOf('/');
        return slash > 0 && specifier.slice(0, slash) === provider
          ? [specifier.slice(slash + 1)]
          : [];
      }),
    ),
  );
}

function compatibleModel<
  TApi extends 'openai-completions' | 'openai-responses',
>(input: {
  id: string;
  name?: string;
  provider: string;
  api: TApi;
  baseUrl: string;
  headers?: Record<string, string>;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}): Model<TApi> {
  return {
    id: input.id,
    name: input.name ?? input.id,
    api: input.api,
    provider: input.provider,
    baseUrl: input.baseUrl,
    headers: input.headers,
    reasoning: input.reasoning,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
  };
}
