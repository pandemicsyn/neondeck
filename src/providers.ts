import {
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type AppConfig,
  type RuntimePaths,
} from './runtime-home';

export const registeredProviderIds = [
  'kilocode',
  'openai',
  'anthropic',
] as const;

export type RegisteredProviderId = (typeof registeredProviderIds)[number];

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

const defaultKilocodeApiKeyEnv = 'KILOCODE_API_KEY';
const fallbackKilocodeApiKeyEnv = 'KILO_API_KEY';
const defaultKilocodeOrganizationIdEnv = 'KILOCODE_ORGANIZATION_ID';
const fallbackKilocodeOrganizationIdEnv = 'KILO_ORGANIZATION_ID';
const defaultOpenAiApiKeyEnv = 'OPENAI_API_KEY';
const defaultAnthropicApiKeyEnv = 'ANTHROPIC_API_KEY';

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

export function resolveKilocodeProviderStatus(
  config?: Pick<AppConfig, 'providers'>,
  env: NodeJS.ProcessEnv = process.env,
): KilocodeProviderStatus {
  const kilocode = config?.providers?.kilocode;
  const apiKeyEnv =
    kilocode?.apiKeyEnv ??
    (env[defaultKilocodeApiKeyEnv]
      ? defaultKilocodeApiKeyEnv
      : fallbackKilocodeApiKeyEnv);
  const organizationIdEnv =
    kilocode?.organizationIdEnv ??
    (env[defaultKilocodeOrganizationIdEnv]
      ? defaultKilocodeOrganizationIdEnv
      : env[fallbackKilocodeOrganizationIdEnv]
        ? fallbackKilocodeOrganizationIdEnv
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

export function isRegisteredProvider(
  provider: string,
): provider is RegisteredProviderId {
  return registeredProviderIds.includes(provider as RegisteredProviderId);
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
