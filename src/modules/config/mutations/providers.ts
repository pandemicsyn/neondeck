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
  resolveKilocodeProviderStatus,
  resolveOpenAiProviderStatus,
} from '../../../providers';
import { updateProviderInputSchema, type ConfigActionResult } from '../schemas';

export async function readProviderConfig(
  paths = runtimePaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);

  return okResult('config_read_providers', false, paths, [paths.config], {
    message: 'Read allowlisted provider configuration.',
    data: {
      providers: effectiveProviderConfig(config.providers, env),
      policy:
        'Provider config is limited to allowlisted provider ids and environment variable secret references.',
    },
  });
}

export async function updateProviderConfig(
  rawInput: v.InferInput<typeof updateProviderInputSchema>,
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
  if (input.provider !== 'kilocode' && input.organizationIdEnv !== undefined) {
    return failResult('config_update_provider', paths, [paths.config], {
      message: `${input.provider} provider does not support organizationIdEnv.`,
      requires: ['enabled', 'apiKeyEnv'],
    });
  }

  if (
    input.enabled === undefined &&
    input.apiKeyEnv === undefined &&
    input.organizationIdEnv === undefined
  ) {
    return failResult('config_update_provider', paths, [paths.config], {
      message: 'At least one provider setting is required.',
      requires: ['enabled', 'apiKeyEnv', 'organizationIdEnv'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
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
      target: `providers.${input.provider}`,
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
        'Only allowlisted provider ids and environment variable secret references are configurable.',
    },
  });
}

function mergeProviderConfig(
  current: AppConfig['providers'] | undefined,
  input: v.InferOutput<typeof updateProviderInputSchema>,
): ProviderConfig {
  const existing = current?.[input.provider] ?? {};
  const provider = {
    ...existing,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.apiKeyEnv !== undefined
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

  if (input.apiKeyEnv === null) {
    delete provider.apiKeyEnv;
  }
  if (input.provider === 'kilocode' && input.organizationIdEnv === null) {
    delete provider.organizationIdEnv;
  }

  return {
    ...current,
    [input.provider]: provider,
  };
}

export function effectiveProviderConfig(
  current: AppConfig['providers'] | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const kilocode = resolveKilocodeProviderStatus({ providers: current }, env);
  const openai = resolveOpenAiProviderStatus({ providers: current }, env);
  const anthropic = resolveAnthropicProviderStatus({ providers: current }, env);

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
  };
}
