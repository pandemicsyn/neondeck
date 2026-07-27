import type { ProviderRegistration } from '@flue/runtime';
import {
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type AppConfig,
  type RuntimePaths,
} from '../../runtime-home';

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
  registration: ProviderRegistration;
};

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
  config?: Pick<AppConfig, 'providers'>,
): ProviderRuntimeRegistration[] {
  const registrations: ProviderRuntimeRegistration[] = [];
  const kilocode = resolveKilocodeProviderStatus(config, env);
  if (kilocode.enabled) {
    const organizationId = kilocode.organizationIdEnv
      ? env[kilocode.organizationIdEnv]
      : undefined;
    registrations.push({
      id: 'kilocode',
      registration: {
        api: 'openai-completions',
        baseUrl: kilocodeGatewayBaseUrl,
        maxTokens: kilocodeGatewayMaxTokens,
        apiKey: env[kilocode.apiKeyEnv] ?? '',
        headers: organizationId
          ? { 'X-KiloCode-OrganizationId': organizationId }
          : undefined,
      },
    });
  }

  registrations.push(
    apiKeyProviderRuntimeRegistration(
      resolveOpenAiProviderStatus(config, env),
      env,
    ),
    apiKeyProviderRuntimeRegistration(
      resolveAnthropicProviderStatus(config, env),
      env,
    ),
  );

  for (const provider of resolveOpenAiCompatibleProviderStatuses(config, env)) {
    if (!provider.enabled) continue;
    registrations.push({
      id: provider.id,
      registration: {
        api: provider.api,
        baseUrl: provider.baseUrl,
        // Pi's OpenAI transports require a truthy auth value even for local
        // or otherwise unauthenticated compatible endpoints.
        apiKey: provider.apiKeyEnv ? (env[provider.apiKeyEnv] ?? '') : 'unused',
        contextWindow: provider.contextWindow ?? undefined,
        maxTokens: provider.maxTokens ?? undefined,
      },
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

function apiKeyProviderRuntimeRegistration(
  status: ApiKeyProviderStatus,
  env: NodeJS.ProcessEnv,
): ProviderRuntimeRegistration {
  return {
    id: status.id,
    registration: {
      apiKey: status.enabled ? (env[status.apiKeyEnv] ?? '') : '',
    },
  };
}
