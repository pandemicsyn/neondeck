import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type ApiKeyCredential,
  type Model,
  type ModelAuth,
  type Provider,
} from '@earendil-works/pi-ai';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { googleVertexProvider } from '@earendil-works/pi-ai/providers/google-vertex';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import {
  registeredProviderIds,
  type RegisteredProviderId,
} from '../../../shared/provider-policy';
import {
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type AppConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { resolveAgentModelSelection } from '../runtime/agent-config';

export { registeredProviderIds, type RegisteredProviderId };
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
  id: 'openai' | 'anthropic' | 'openrouter' | 'opencode';
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

export type GoogleVertexProviderStatus = {
  id: 'google-vertex';
  allowed: true;
  enabled: boolean;
  usable: boolean;
  authMode: 'api-key' | 'adc' | null;
  apiKeyPresent: boolean;
  adcCredentialsPresent: boolean;
  projectPresent: boolean;
  locationPresent: boolean;
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
const defaultOpenRouterApiKeyEnv = 'OPENROUTER_API_KEY';
const defaultOpenCodeApiKeyEnv = 'OPENCODE_API_KEY';
const googleCloudApiKeyEnv = 'GOOGLE_CLOUD_API_KEY';
const googleCloudProjectEnv = 'GOOGLE_CLOUD_PROJECT';
const googleCloudProjectFallbackEnv = 'GCLOUD_PROJECT';
const googleCloudLocationEnv = 'GOOGLE_CLOUD_LOCATION';
const googleApplicationCredentialsEnv = 'GOOGLE_APPLICATION_CREDENTIALS';
const defaultGoogleApplicationCredentialsPath = join(
  homedir(),
  '.config/gcloud/application_default_credentials.json',
);
const kilocodeGatewayBaseUrl = 'https://api.kilo.ai/api/gateway';
const kilocodeGatewayMaxTokens = 16_384;
const openRouterBaseUrl = 'https://openrouter.ai/api/v1';
const openRouterFallbackContextWindow = 32_768;
const openRouterFallbackMaxTokens = 4_096;

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
      const { discoverModels } = await import('../model-catalog');
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

  const openRouterRegistration = builtInApiKeyProviderRuntimeRegistration(
    resolveOpenRouterProviderStatus(config, env),
    env,
  );
  registrations.push(
    builtInApiKeyProviderRuntimeRegistration(
      resolveOpenAiProviderStatus(config, env),
      env,
    ),
    builtInApiKeyProviderRuntimeRegistration(
      resolveAnthropicProviderStatus(config, env),
      env,
    ),
    {
      ...openRouterRegistration,
      provider: withAdditionalSelectedModels(
        openRouterRegistration.provider,
        () =>
          modelIdsForProvider('openrouter', modelSpecifiers()).map((id) =>
            compatibleModel({
              id,
              provider: 'openrouter',
              api: 'openai-completions',
              baseUrl: openRouterBaseUrl,
              reasoning: false,
              contextWindow: openRouterFallbackContextWindow,
              maxTokens: openRouterFallbackMaxTokens,
              compat: {
                supportsDeveloperRole: false,
                thinkingFormat: 'openrouter',
              },
            }),
          ),
      ),
    },
    builtInApiKeyProviderRuntimeRegistration(
      resolveOpenCodeProviderStatus(config, env),
      env,
    ),
    googleVertexProviderRuntimeRegistration(
      resolveGoogleVertexProviderStatus(config, env),
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

export function resolveOpenRouterProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyProviderStatus {
  return resolveApiKeyProviderStatus(
    'openrouter',
    config?.providers?.openrouter,
    defaultOpenRouterApiKeyEnv,
    env,
  );
}

export function resolveOpenCodeProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyProviderStatus {
  return resolveApiKeyProviderStatus(
    'opencode',
    config?.providers?.opencode,
    defaultOpenCodeApiKeyEnv,
    env,
  );
}

export function resolveGoogleVertexProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): GoogleVertexProviderStatus {
  const enabled = config?.providers?.googleVertex?.enabled ?? true;
  const apiKeyPresent = Boolean(nonBlankEnvValue(env[googleCloudApiKeyEnv]));
  const projectPresent = Boolean(
    nonBlankEnvValue(env[googleCloudProjectEnv]) ??
    nonBlankEnvValue(env[googleCloudProjectFallbackEnv]),
  );
  const locationPresent = Boolean(
    nonBlankEnvValue(env[googleCloudLocationEnv]),
  );
  const configuredCredentialsPath =
    nonBlankEnvValue(env[googleApplicationCredentialsEnv]) ??
    defaultGoogleApplicationCredentialsPath;
  const credentialsPath = normalizeGoogleCredentialsPath(
    configuredCredentialsPath,
  );
  const adcCredentialsPresent = fileExists(credentialsPath);
  const adcReady = adcCredentialsPresent && projectPresent && locationPresent;
  const authMode = apiKeyPresent ? 'api-key' : adcReady ? 'adc' : null;

  return {
    id: 'google-vertex',
    allowed: true,
    enabled,
    usable: enabled && authMode !== null,
    authMode,
    apiKeyPresent,
    adcCredentialsPresent,
    projectPresent,
    locationPresent,
  };
}

export function normalizeGoogleCredentialsPath(path: string) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function nonBlankEnvValue(value: string | undefined) {
  return value?.trim() ? value : undefined;
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
    status.id === 'openai'
      ? openaiProvider()
      : status.id === 'anthropic'
        ? anthropicProvider()
        : status.id === 'openrouter'
          ? openrouterProvider()
          : opencodeProvider();
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

export function googleVertexProviderRuntimeRegistration(
  status: GoogleVertexProviderStatus,
  env: NodeJS.ProcessEnv,
  builtIn: ReturnType<typeof googleVertexProvider> = googleVertexProvider(),
): ProviderRuntimeRegistration {
  const builtInAuth = builtIn.auth.apiKey!;
  // The runtime registry erases the provider API generic after model lookup;
  // this provider's own catalog remains Vertex-only.
  const dispatchProvider = builtIn as Provider;
  const scopedContext = (ctx: Parameters<ApiKeyAuth['resolve']>[0]['ctx']) => ({
    ...ctx,
    env: async (name: string) => {
      const scopedValue = await ctx.env(name);
      return nonBlankEnvValue(
        scopedValue !== undefined ? scopedValue : env[name],
      );
    },
  });
  return {
    id: 'google-vertex',
    provider: {
      ...builtIn,
      stream(model, context, options) {
        return dispatchProvider.stream(
          model,
          context,
          normalizeGoogleVertexRequestOptions(options),
        );
      },
      streamSimple(model, context, options) {
        return dispatchProvider.streamSimple(
          model,
          context,
          normalizeGoogleVertexRequestOptions(options),
        );
      },
      auth: {
        apiKey: {
          ...builtInAuth,
          check: async (input) => {
            if (!status.enabled) return undefined;
            const normalizedInput = normalizeGoogleVertexAuthInput(input);
            return builtInAuth.check
              ? builtInAuth.check({
                  ...normalizedInput,
                  ctx: scopedContext(input.ctx),
                })
              : builtInAuth
                  .resolve({
                    ...normalizedInput,
                    ctx: scopedContext(input.ctx),
                  })
                  .then((result) =>
                    result
                      ? { source: result.source, type: 'api_key' }
                      : undefined,
                  );
          },
          resolve: async (input) => {
            if (!status.enabled) return undefined;
            const ctx = scopedContext(input.ctx);
            const result = await builtInAuth.resolve({
              ...normalizeGoogleVertexAuthInput(input),
              ctx,
            });
            if (!result || result.auth.apiKey) return result;
            const project =
              nonBlankEnvValue(result.env?.[googleCloudProjectEnv]) ??
              nonBlankEnvValue(result.env?.[googleCloudProjectFallbackEnv]) ??
              (await ctx.env(googleCloudProjectEnv)) ??
              (await ctx.env(googleCloudProjectFallbackEnv));
            const location =
              nonBlankEnvValue(result.env?.[googleCloudLocationEnv]) ??
              (await ctx.env(googleCloudLocationEnv));
            const credentialsPath =
              nonBlankEnvValue(result.env?.[googleApplicationCredentialsEnv]) ??
              (await ctx.env(googleApplicationCredentialsEnv)) ??
              defaultGoogleApplicationCredentialsPath;
            return {
              ...result,
              env: {
                ...result.env,
                ...(project ? { [googleCloudProjectEnv]: project } : {}),
                ...(location ? { [googleCloudLocationEnv]: location } : {}),
                [googleApplicationCredentialsEnv]:
                  normalizeGoogleCredentialsPath(credentialsPath),
              },
            };
          },
        },
      },
    },
  };
}

function normalizeGoogleVertexAuthInput(
  input: Parameters<ApiKeyAuth['resolve']>[0],
) {
  return {
    ...input,
    credential: normalizeGoogleVertexCredential(input.credential),
  };
}

function normalizeGoogleVertexCredential(
  credential: ApiKeyCredential | undefined,
): ApiKeyCredential | undefined {
  if (!credential) return undefined;
  const key = nonBlankEnvValue(credential.key);
  const env = credential.env
    ? Object.fromEntries(
        Object.entries(credential.env).filter(([, value]) =>
          nonBlankEnvValue(value),
        ),
      )
    : undefined;
  return {
    type: 'api_key',
    ...(key ? { key } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

function normalizeGoogleVertexRequestOptions<
  T extends { env?: Record<string, string> },
>(options: T | undefined): T | undefined {
  const credentialsPath = options?.env?.[googleApplicationCredentialsEnv];
  if (!options?.env || credentialsPath === undefined) return options;
  const configuredPath = nonBlankEnvValue(credentialsPath);
  const normalizedPath = configuredPath
    ? normalizeGoogleCredentialsPath(configuredPath)
    : defaultGoogleApplicationCredentialsPath;
  if (normalizedPath === credentialsPath) return options;
  return {
    ...options,
    env: {
      ...options.env,
      [googleApplicationCredentialsEnv]: normalizedPath,
    },
  } as T;
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

function withAdditionalSelectedModels<TProvider extends Provider>(
  provider: TProvider,
  fallbackModels: () => readonly Model<Api>[],
): TProvider {
  const bundledModels = provider.getModels.bind(provider);
  return {
    ...provider,
    getModels() {
      const models = [...bundledModels()];
      const knownIds = new Set(models.map((model) => model.id));
      for (const fallback of fallbackModels()) {
        if (!knownIds.has(fallback.id)) models.push(fallback);
      }
      return models;
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
  compat?: Model<TApi>['compat'];
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
    compat: input.compat,
  };
}
