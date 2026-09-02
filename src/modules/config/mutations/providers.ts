import * as v from 'valibot';
import { parseActionInput, failResult, okResult } from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import {
  type AppConfig,
  type ProviderConfig,
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import {
  resolveAnthropicProviderStatus,
  resolveGoogleVertexProviderStatus,
  resolveKilocodeProviderStatus,
  resolveOpenAiCodexProviderStatus,
  resolveOpenAiCompatibleProviderStatuses,
  resolveOpenAiProviderStatus,
  resolveOpenCodeProviderStatus,
  resolveOpenRouterProviderStatus,
} from '../../repos';
import { updateProviderInputSchema, type ConfigActionResult } from '../schemas';

export async function readProviderConfig(
  paths = runtimePaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);

  return okResult('config_read_providers', false, paths, [paths.config], {
    message: 'Read validated provider configuration.',
    data: {
      providers: effectiveProviderConfig(config.providers, env),
      policy:
        'Provider config is limited to built-ins and validated OpenAI-compatible definitions with environment variable secret references.',
    },
  });
}

export async function updateProviderConfig(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateProviderInputSchema,
    rawInput,
    'config_update_provider',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (
    input.enabled === undefined &&
    (input.provider === 'openai-codex' ||
      input.provider === 'google-vertex' ||
      input.apiKeyEnv === undefined) &&
    (input.provider !== 'kilocode' || input.organizationIdEnv === undefined) &&
    (input.provider !== 'openai-compatible' ||
      (input.baseUrl === undefined &&
        input.api === undefined &&
        input.contextWindow === undefined &&
        input.maxTokens === undefined &&
        input.remove === undefined))
  ) {
    return failResult('config_update_provider', paths, [paths.config], {
      message: 'At least one provider setting is required.',
      requires: ['enabled', 'apiKeyEnv', 'organizationIdEnv'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  if (
    input.provider === 'openai-compatible' &&
    !input.remove &&
    !input.baseUrl &&
    !config.providers?.openaiCompatible?.some(
      (provider) => provider.id === input.id,
    )
  ) {
    return failResult('config_update_provider', paths, [paths.config], {
      message: `A baseUrl is required when creating custom provider "${input.id}".`,
      requires: ['baseUrl'],
    });
  }
  const nextProviders = mergeProviderConfig(config.providers, input);
  const next = parseAppConfig(
    {
      ...config,
      providers: nextProviders,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.providers ?? {}) !==
    JSON.stringify(next.providers ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_provider',
      file: paths.config,
      target:
        input.provider === 'openai-compatible'
          ? `providers.openaiCompatible.${input.id}`
          : `providers.${input.provider}`,
      before: config,
      after: next,
    });
  }

  return okResult('config_update_provider', changed, paths, [paths.config], {
    message: changed
      ? 'Updated provider configuration. Restart the server for provider registration changes to take effect.'
      : 'Provider configuration already matched the requested values.',
    data: {
      providers: effectiveProviderConfig(next.providers),
      appliesAfter: 'server-restart',
      policy:
        'Only built-in or validated OpenAI-compatible providers and environment variable secret references are configurable.',
    },
  });
}

function mergeProviderConfig(
  current: AppConfig['providers'] | undefined,
  input: v.InferOutput<typeof updateProviderInputSchema>,
): ProviderConfig {
  if (input.provider === 'openai-compatible') {
    const id = input.id;
    const existing = current?.openaiCompatible ?? [];
    if (input.remove) {
      return {
        ...current,
        openaiCompatible: existing.filter((provider) => provider.id !== id),
      };
    }
    const currentProvider = existing.find((provider) => provider.id === id);
    const provider = {
      ...currentProvider,
      id,
      baseUrl: input.baseUrl ?? currentProvider?.baseUrl ?? '',
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
      ...(input.api !== undefined ? { api: input.api } : {}),
      ...(input.contextWindow !== undefined && input.contextWindow !== null
        ? { contextWindow: input.contextWindow }
        : {}),
      ...(input.maxTokens !== undefined && input.maxTokens !== null
        ? { maxTokens: input.maxTokens }
        : {}),
    };
    if (input.apiKeyEnv === null) delete provider.apiKeyEnv;
    if (input.contextWindow === null) delete provider.contextWindow;
    if (input.maxTokens === null) delete provider.maxTokens;
    return {
      ...current,
      openaiCompatible: [
        ...existing.filter((candidate) => candidate.id !== id),
        provider,
      ],
    };
  }

  const configKey =
    input.provider === 'openai-codex'
      ? 'openaiCodex'
      : input.provider === 'google-vertex'
        ? 'googleVertex'
        : input.provider;
  const existing = current?.[configKey] ?? {};
  const provider = {
    ...existing,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.provider !== 'openai-codex' &&
    input.provider !== 'google-vertex' &&
    input.apiKeyEnv !== undefined
      ? input.apiKeyEnv === null
        ? {}
        : { apiKeyEnv: input.apiKeyEnv }
      : {}),
    ...(input.provider === 'kilocode' && input.organizationIdEnv !== undefined
      ? input.organizationIdEnv === null
        ? {}
        : { organizationIdEnv: input.organizationIdEnv }
      : {}),
  };

  if (
    input.provider !== 'openai-codex' &&
    input.provider !== 'google-vertex' &&
    input.apiKeyEnv === null
  ) {
    delete provider.apiKeyEnv;
  }
  if (input.provider === 'kilocode' && input.organizationIdEnv === null) {
    delete provider.organizationIdEnv;
  }

  return {
    ...current,
    [configKey]: provider,
  };
}

export function effectiveProviderConfig(
  current: AppConfig['providers'] | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const kilocode = resolveKilocodeProviderStatus({ providers: current }, env);
  const openai = resolveOpenAiProviderStatus({ providers: current }, env);
  const anthropic = resolveAnthropicProviderStatus({ providers: current }, env);
  const openrouter = resolveOpenRouterProviderStatus(
    { providers: current },
    env,
  );
  const opencode = resolveOpenCodeProviderStatus({ providers: current }, env);
  const googleVertex = resolveGoogleVertexProviderStatus(
    { providers: current },
    env,
  );
  const openaiCodex = resolveOpenAiCodexProviderStatus({
    providers: current,
  });
  const openaiCompatible = resolveOpenAiCompatibleProviderStatuses(
    { providers: current },
    env,
  );

  return {
    kilocode: {
      enabled: kilocode.enabled,
      apiKeyEnv: kilocode.apiKeyEnv,
      organizationIdEnv: kilocode.organizationIdEnv,
    },
    openai: {
      enabled: openai.enabled,
      apiKeyEnv: openai.apiKeyEnv,
    },
    anthropic: {
      enabled: anthropic.enabled,
      apiKeyEnv: anthropic.apiKeyEnv,
    },
    openrouter: {
      enabled: openrouter.enabled,
      apiKeyEnv: openrouter.apiKeyEnv,
    },
    opencode: {
      enabled: opencode.enabled,
      apiKeyEnv: opencode.apiKeyEnv,
    },
    googleVertex: {
      enabled: googleVertex.enabled,
    },
    openaiCodex: {
      enabled: openaiCodex.enabled,
    },
    openaiCompatible: openaiCompatible.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      apiKeyPresent: provider.apiKeyPresent,
      api: provider.api,
      contextWindow: provider.contextWindow,
      maxTokens: provider.maxTokens,
    })),
  };
}
