import { describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import {
  providerRuntimeRegistrations,
  resolveKilocodeProviderStatus,
  resolveOpenCodeProviderStatus,
  resolveOpenRouterProviderStatus,
} from './modules/repos/providers';
import {
  parseOpenCodeModels,
  parseOpenRouterModels,
} from './modules/model-catalog/gateway-model-discovery';

describe('provider runtime registrations', () => {
  it('sets an explicit KiloCode gateway output-token budget', () => {
    const registrations = providerRuntimeRegistrations({
      KILOCODE_API_KEY: 'kilo-key',
    } as NodeJS.ProcessEnv);

    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kilocode',
          provider: expect.objectContaining({ id: 'kilocode' }),
        }),
      ]),
    );
    const kilocode = registrations.find(
      (registration) => registration.id === 'kilocode',
    );
    expect(kilocode?.provider.getModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kilo-auto/balanced',
          api: 'openai-completions',
          reasoning: true,
          maxTokens: 16_384,
        }),
      ]),
    );
  });

  it('uses KILOCODE_API_KEY unless an explicit config overrides it', () => {
    expect(resolveKilocodeProviderStatus(undefined, {})).toMatchObject({
      apiKeyEnv: 'KILOCODE_API_KEY',
      apiKeyPresent: false,
    });
    expect(resolveKilocodeProviderStatus(undefined, {})).toMatchObject({
      apiKeyEnv: 'KILOCODE_API_KEY',
      apiKeyPresent: false,
    });
  });

  it('carries the configured Kilo organization through Pi model auth headers', async () => {
    const registration = providerRuntimeRegistrations({
      KILOCODE_API_KEY: 'kilo-key',
      KILOCODE_ORGANIZATION_ID: 'org-123',
    } as NodeJS.ProcessEnv).find((candidate) => candidate.id === 'kilocode');
    const models = createModels();
    models.setProvider(registration!.provider);
    const model = registration!.provider.getModels()[0];

    await expect(models.getAuth(model)).resolves.toMatchObject({
      auth: {
        apiKey: 'kilo-key',
        headers: { 'X-KiloCode-OrganizationId': 'org-123' },
      },
    });
  });

  it('uses configured OpenAI and Anthropic environment references for Flue', async () => {
    const registrations = providerRuntimeRegistrations(
      {
        OPENAI_API_KEY: 'default-openai-key',
        NEONDECK_OPENAI_KEY: 'configured-openai-key',
        ANTHROPIC_API_KEY: 'default-anthropic-key',
        NEONDECK_ANTHROPIC_KEY: 'configured-anthropic-key',
      } as NodeJS.ProcessEnv,
      {
        providers: {
          openai: {
            enabled: true,
            apiKeyEnv: 'NEONDECK_OPENAI_KEY',
          },
          anthropic: {
            enabled: true,
            apiKeyEnv: 'NEONDECK_ANTHROPIC_KEY',
          },
        },
      },
    );

    await expect(resolveApiKey(registrations, 'openai')).resolves.toMatchObject(
      {
        auth: { apiKey: 'configured-openai-key' },
        source: 'NEONDECK_OPENAI_KEY',
      },
    );
    await expect(
      resolveApiKey(registrations, 'anthropic'),
    ).resolves.toMatchObject({
      auth: { apiKey: 'configured-anthropic-key' },
      source: 'NEONDECK_ANTHROPIC_KEY',
    });
    expect(
      registrations
        .find((registration) => registration.id === 'openai')
        ?.provider.getModels().length,
    ).toBeGreaterThan(0);
    expect(
      registrations
        .find((registration) => registration.id === 'anthropic')
        ?.provider.getModels().length,
    ).toBeGreaterThan(0);
  });

  it('registers native OpenRouter and OpenCode providers with configured auth', async () => {
    const registrations = providerRuntimeRegistrations(
      {
        ROUTER_KEY: 'router-key',
        ZEN_KEY: 'zen-key',
      } as NodeJS.ProcessEnv,
      {
        providers: {
          openrouter: { apiKeyEnv: 'ROUTER_KEY' },
          opencode: { apiKeyEnv: 'ZEN_KEY' },
        },
      },
    );

    await expect(
      resolveApiKey(registrations, 'openrouter'),
    ).resolves.toMatchObject({
      auth: { apiKey: 'router-key' },
      source: 'ROUTER_KEY',
    });
    await expect(
      resolveApiKey(registrations, 'opencode'),
    ).resolves.toMatchObject({
      auth: { apiKey: 'zen-key' },
      source: 'ZEN_KEY',
    });
    expect(
      registrations
        .find((registration) => registration.id === 'opencode')
        ?.provider.getModels(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gpt-5.6-terra',
          api: 'openai-responses',
        }),
        expect.objectContaining({
          id: 'claude-sonnet-4-6',
          api: 'anthropic-messages',
        }),
      ]),
    );
  });

  it('resolves every representative discovered gateway model through Pi with the same API', () => {
    const registrations = providerRuntimeRegistrations(
      {
        OPENROUTER_API_KEY: 'router-key',
        OPENCODE_API_KEY: 'zen-key',
      } as NodeJS.ProcessEnv,
      {
        providers: {
          openrouter: {},
          opencode: {},
        },
      },
    ).filter(
      (registration) =>
        registration.id === 'openrouter' || registration.id === 'opencode',
    );
    const models = createModels();
    for (const registration of registrations) {
      models.setProvider(registration.provider);
    }

    const openRouter = models.getProvider('openrouter')!;
    const openRouterRows = openRouter
      .getModels()
      .slice(0, 3)
      .map((model) => ({
        id: model.id,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      }));
    const discoveredRouter = parseOpenRouterModels(
      openRouterRows,
      openRouter.getModels(),
    ).models;
    expect(discoveredRouter).toHaveLength(openRouterRows.length);

    const openCode = models.getProvider('opencode')!;
    const expectedOpenCodeApis = [
      'anthropic-messages',
      'google-generative-ai',
      'openai-completions',
      'openai-responses',
    ] as const;
    const openCodeRows = expectedOpenCodeApis.map((api) => {
      const model = openCode
        .getModels()
        .find((candidate) => candidate.api === api);
      expect(model).toBeDefined();
      return { id: model!.id };
    });
    const discoveredOpenCode = parseOpenCodeModels(
      openCodeRows,
      openCode.getModels(),
    ).models;
    expect(discoveredOpenCode.map((model) => model.api).sort()).toEqual(
      [...expectedOpenCodeApis].sort(),
    );

    for (const discovered of [...discoveredRouter, ...discoveredOpenCode]) {
      expect(
        models.getModel(discovered.provider, discovered.model),
      ).toMatchObject({
        provider: discovered.provider,
        id: discovered.model,
        api: discovered.api,
      });
    }
  });

  it('materializes a configured OpenRouter model released ahead of Pi', () => {
    const registration = providerRuntimeRegistrations(
      { OPENROUTER_API_KEY: 'router-key' } as NodeJS.ProcessEnv,
      {
        models: {
          displayAssistant: 'openrouter/z-ai/glm-5.3-flash',
        },
        providers: { openrouter: {} },
      },
    ).find((candidate) => candidate.id === 'openrouter');
    const models = createModels();
    models.setProvider(registration!.provider);

    expect(models.getModel('openrouter', 'z-ai/glm-5.3-flash')).toMatchObject({
      id: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      contextWindow: 32_768,
      maxTokens: 4_096,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: 'openrouter',
      },
    });
  });

  it('uses gateway default env names and shadows ambient credentials when disabled', async () => {
    expect(resolveOpenRouterProviderStatus(undefined, {})).toMatchObject({
      apiKeyEnv: 'OPENROUTER_API_KEY',
      apiKeyPresent: false,
    });
    expect(resolveOpenCodeProviderStatus(undefined, {})).toMatchObject({
      apiKeyEnv: 'OPENCODE_API_KEY',
      apiKeyPresent: false,
    });
    const registrations = providerRuntimeRegistrations(
      {
        OPENROUTER_API_KEY: 'ambient-router-key',
        OPENCODE_API_KEY: 'ambient-zen-key',
      } as NodeJS.ProcessEnv,
      {
        providers: {
          openrouter: { enabled: false },
          opencode: { enabled: false },
        },
      },
    );
    await expect(
      resolveApiKey(registrations, 'openrouter'),
    ).resolves.toBeUndefined();
    await expect(
      resolveApiKey(registrations, 'opencode'),
    ).resolves.toBeUndefined();
  });

  it('does not fall back to default built-in provider env vars when disabled', async () => {
    const registrations = providerRuntimeRegistrations(
      {
        OPENAI_API_KEY: 'default-openai-key',
        ANTHROPIC_API_KEY: 'default-anthropic-key',
      } as NodeJS.ProcessEnv,
      {
        providers: {
          openai: {
            enabled: false,
            apiKeyEnv: 'OPENAI_API_KEY',
          },
          anthropic: {
            enabled: false,
            apiKeyEnv: 'ANTHROPIC_API_KEY',
          },
        },
      },
    );

    await expect(
      resolveApiKey(registrations, 'openai'),
    ).resolves.toBeUndefined();
    await expect(
      resolveApiKey(registrations, 'anthropic'),
    ).resolves.toBeUndefined();
  });

  it('registers configured OpenAI-compatible endpoints with env-backed keys', async () => {
    const registrations = providerRuntimeRegistrations(
      { ROUTER_PROXY_API_KEY: 'router-key' } as NodeJS.ProcessEnv,
      {
        models: {
          displayAssistant: 'router-proxy/openai/gpt-5.5',
        },
        providers: {
          openaiCompatible: [
            {
              id: 'router-proxy',
              baseUrl: 'https://openrouter.ai/api/v1/',
              apiKeyEnv: 'ROUTER_PROXY_API_KEY',
            },
          ],
        },
      },
    );

    expect(registrations).toEqual(
      expect.arrayContaining([
        {
          id: 'router-proxy',
          provider: expect.objectContaining({
            baseUrl: 'https://openrouter.ai/api/v1',
          }),
        },
      ]),
    );
    await expect(
      resolveApiKey(registrations, 'router-proxy'),
    ).resolves.toMatchObject({ auth: { apiKey: 'router-key' } });
    expect(
      registrations
        .find((registration) => registration.id === 'router-proxy')
        ?.provider.getModels(),
    ).toEqual([
      expect.objectContaining({
        id: 'openai/gpt-5.5',
        api: 'openai-completions',
        provider: 'router-proxy',
      }),
    ]);
  });

  it('uses a non-secret placeholder for compatible endpoints without auth', async () => {
    const registrations = providerRuntimeRegistrations(
      {} as NodeJS.ProcessEnv,
      {
        providers: {
          openaiCompatible: [
            {
              id: 'local-models',
              baseUrl: 'http://localhost:11434/v1',
            },
          ],
        },
      },
    );

    await expect(
      resolveApiKey(registrations, 'local-models'),
    ).resolves.toMatchObject({ auth: { apiKey: 'unused' } });
  });

  it('reads custom model selections lazily so a new session sees config changes', () => {
    let specifiers = ['local-models/llama-3'];
    const registrations = providerRuntimeRegistrations(
      {} as NodeJS.ProcessEnv,
      {
        providers: {
          openaiCompatible: [
            {
              id: 'local-models',
              baseUrl: 'http://localhost:11434/v1',
              contextWindow: 32_768,
              maxTokens: 4_096,
            },
          ],
        },
      },
      () => specifiers,
    );
    const provider = registrations.find(
      (registration) => registration.id === 'local-models',
    )?.provider;

    expect(provider?.getModels()).toEqual([
      expect.objectContaining({
        id: 'llama-3',
        contextWindow: 32_768,
        maxTokens: 4_096,
      }),
    ]);
    specifiers = ['local-models/qwen-3'];
    expect(provider?.getModels()).toEqual([
      expect.objectContaining({ id: 'qwen-3' }),
    ]);
  });
});

async function resolveApiKey(
  registrations: ReturnType<typeof providerRuntimeRegistrations>,
  id: string,
) {
  const auth = registrations.find((registration) => registration.id === id)
    ?.provider.auth.apiKey;
  if (!auth) return undefined;
  return auth.resolve({
    ctx: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
}
