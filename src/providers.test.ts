import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  type ApiKeyCredential,
  type CredentialStore,
} from '@earendil-works/pi-ai';
import { googleVertexProvider } from '@earendil-works/pi-ai/providers/google-vertex';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  providerRuntimeRegistrations,
  googleVertexProviderRuntimeRegistration,
  resolveGoogleVertexProviderStatus,
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

  it('registers native Google Vertex models and supports API-key or ADC auth', async () => {
    expect(
      resolveGoogleVertexProviderStatus(
        undefined,
        { GOOGLE_CLOUD_API_KEY: 'vertex-key' },
        () => false,
      ),
    ).toMatchObject({
      enabled: true,
      usable: true,
      authMode: 'api-key',
      apiKeyPresent: true,
    });
    let checkedCredentialsPath = '';
    expect(
      resolveGoogleVertexProviderStatus(
        undefined,
        {
          GOOGLE_APPLICATION_CREDENTIALS: '~/vertex-service-account.json',
          GOOGLE_CLOUD_PROJECT: 'neondeck-project',
          GOOGLE_CLOUD_LOCATION: 'us-central1',
        },
        (path) => {
          checkedCredentialsPath = path;
          return true;
        },
      ),
    ).toMatchObject({
      usable: true,
      authMode: 'adc',
      adcCredentialsPresent: true,
      projectPresent: true,
      locationPresent: true,
    });
    expect(checkedCredentialsPath).toBe(
      join(homedir(), 'vertex-service-account.json'),
    );

    for (const blankPath of ['', '   ']) {
      checkedCredentialsPath = '';
      expect(
        resolveGoogleVertexProviderStatus(
          undefined,
          {
            GOOGLE_APPLICATION_CREDENTIALS: blankPath,
            GOOGLE_CLOUD_PROJECT: 'neondeck-project',
            GOOGLE_CLOUD_LOCATION: 'us-central1',
          },
          (path) => {
            checkedCredentialsPath = path;
            return true;
          },
        ),
      ).toMatchObject({
        usable: true,
        authMode: 'adc',
        adcCredentialsPresent: true,
      });
      expect(checkedCredentialsPath).toBe(
        join(homedir(), '.config/gcloud/application_default_credentials.json'),
      );
    }

    const apiKeyRegistration = providerRuntimeRegistrations({
      GOOGLE_CLOUD_API_KEY: 'vertex-key',
    } as NodeJS.ProcessEnv).find(
      (registration) => registration.id === 'google-vertex',
    );
    expect(apiKeyRegistration?.provider.getModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gemini-2.5-pro',
          api: 'google-vertex',
          reasoning: true,
          input: expect.arrayContaining(['text', 'image']),
        }),
      ]),
    );
    await expect(
      apiKeyRegistration?.provider.auth.apiKey?.resolve({
        ctx: {
          env: async () => undefined,
          fileExists: async () => false,
        },
      }),
    ).resolves.toMatchObject({
      auth: { apiKey: 'vertex-key' },
      source: 'GOOGLE_CLOUD_API_KEY',
    });

    const adcRegistration = providerRuntimeRegistrations({
      GOOGLE_APPLICATION_CREDENTIALS: '~/vertex-service-account.json',
      GOOGLE_CLOUD_PROJECT: 'neondeck-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    } as NodeJS.ProcessEnv).find(
      (registration) => registration.id === 'google-vertex',
    );
    await expect(
      adcRegistration?.provider.auth.apiKey?.resolve({
        ctx: {
          env: async () => undefined,
          fileExists: async () => true,
        },
      }),
    ).resolves.toMatchObject({
      auth: {},
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: join(
          homedir(),
          'vertex-service-account.json',
        ),
        GOOGLE_CLOUD_PROJECT: 'neondeck-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    });

    let resolvedDefaultAdcPath = '';
    const defaultAdcRegistration = providerRuntimeRegistrations({
      GOOGLE_APPLICATION_CREDENTIALS: '   ',
      GOOGLE_CLOUD_PROJECT: 'neondeck-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    } as NodeJS.ProcessEnv).find(
      (registration) => registration.id === 'google-vertex',
    );
    await expect(
      defaultAdcRegistration?.provider.auth.apiKey?.resolve({
        ctx: {
          env: async () => undefined,
          fileExists: async (path) => {
            resolvedDefaultAdcPath = path;
            return true;
          },
        },
      }),
    ).resolves.toMatchObject({
      auth: {},
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: join(
          homedir(),
          '.config/gcloud/application_default_credentials.json',
        ),
        GOOGLE_CLOUD_PROJECT: 'neondeck-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    });
    expect(resolvedDefaultAdcPath).toBe(
      '~/.config/gcloud/application_default_credentials.json',
    );
  });

  it('shadows ambient Google Vertex credentials when disabled', async () => {
    const registrations = providerRuntimeRegistrations(
      { GOOGLE_CLOUD_API_KEY: 'ambient-vertex-key' } as NodeJS.ProcessEnv,
      { providers: { googleVertex: { enabled: false } } },
    );
    await expect(
      resolveApiKey(registrations, 'google-vertex'),
    ).resolves.toBeUndefined();
  });

  it('keeps stored Google Vertex ADC fields ahead of conflicting ambient values', async () => {
    const registration = providerRuntimeRegistrations({
      GOOGLE_APPLICATION_CREDENTIALS: '/ambient/service-account.json',
      GOOGLE_CLOUD_PROJECT: 'ambient-project',
      GOOGLE_CLOUD_LOCATION: 'ambient-location',
    } as NodeJS.ProcessEnv).find(
      (candidate) => candidate.id === 'google-vertex',
    );

    await expect(
      registration?.provider.auth.apiKey?.resolve({
        credential: {
          type: 'api_key',
          env: {
            GOOGLE_APPLICATION_CREDENTIALS: '~/stored-service-account.json',
            GOOGLE_CLOUD_PROJECT: 'stored-project',
            GOOGLE_CLOUD_LOCATION: 'stored-location',
          },
        },
        ctx: {
          env: async () => undefined,
          fileExists: async () => true,
        },
      }),
    ).resolves.toMatchObject({
      auth: {},
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: join(
          homedir(),
          'stored-service-account.json',
        ),
        GOOGLE_CLOUD_PROJECT: 'stored-project',
        GOOGLE_CLOUD_LOCATION: 'stored-location',
      },
      source: 'stored credential',
    });
  });

  it('keeps explicit Pi request env ahead of captured ambient Vertex values', async () => {
    const registration = providerRuntimeRegistrations({
      GOOGLE_APPLICATION_CREDENTIALS: '/ambient/service-account.json',
      GOOGLE_CLOUD_PROJECT: 'ambient-project',
      GOOGLE_CLOUD_LOCATION: 'ambient-location',
    } as NodeJS.ProcessEnv).find(
      (candidate) => candidate.id === 'google-vertex',
    );
    const models = createModels({
      authContext: {
        env: async () => undefined,
        fileExists: async () => true,
      },
    });
    models.setProvider(registration!.provider);

    await expect(
      models.getAuth('google-vertex', {
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: '~/request-service-account.json',
          GOOGLE_CLOUD_PROJECT: 'request-project',
          GOOGLE_CLOUD_LOCATION: 'request-location',
        },
      }),
    ).resolves.toMatchObject({
      auth: {},
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: join(
          homedir(),
          'request-service-account.json',
        ),
        GOOGLE_CLOUD_PROJECT: 'request-project',
        GOOGLE_CLOUD_LOCATION: 'request-location',
      },
    });
  });

  it('keeps request-scoped credential paths normalized through Pi stream dispatch', async () => {
    const builtIn = googleVertexProvider();
    const stream = vi.fn<typeof builtIn.stream>(() => {
      const result = createAssistantMessageEventStream();
      result.end();
      return result;
    });
    const capturedEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: '/ambient/service-account.json',
      GOOGLE_CLOUD_PROJECT: 'ambient-project',
      GOOGLE_CLOUD_LOCATION: 'ambient-location',
    } as NodeJS.ProcessEnv;
    const registration = googleVertexProviderRuntimeRegistration(
      resolveGoogleVertexProviderStatus(undefined, capturedEnv),
      capturedEnv,
      { ...builtIn, stream },
    );
    const models = createModels({
      authContext: {
        env: async () => undefined,
        fileExists: async () => true,
      },
    });
    models.setProvider(registration.provider);
    const model = registration.provider.getModels()[0]!;

    models.stream(
      model,
      { messages: [] },
      {
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: '~/request-service-account.json',
          GOOGLE_CLOUD_PROJECT: 'request-project',
          GOOGLE_CLOUD_LOCATION: 'request-location',
        },
      },
    );
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
    expect(stream.mock.calls[0]?.[2]).toMatchObject({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: join(
          homedir(),
          'request-service-account.json',
        ),
        GOOGLE_CLOUD_PROJECT: 'request-project',
        GOOGLE_CLOUD_LOCATION: 'request-location',
      },
    });
  });

  it("keeps Vertex output tokens below Pi's exclusive catalog ceiling", () => {
    const builtIn = googleVertexProvider();
    const streamSimple = vi.fn<typeof builtIn.streamSimple>(() => {
      const result = createAssistantMessageEventStream();
      result.end();
      return result;
    });
    const registration = googleVertexProviderRuntimeRegistration(
      resolveGoogleVertexProviderStatus(undefined, {}),
      {},
      { ...builtIn, streamSimple },
    );
    const builtInModel = builtIn
      .getModels()
      .find((model) => model.id === 'gemini-3.6-flash')!;
    const runtimeModel = registration.provider
      .getModels()
      .find((model) => model.id === builtInModel.id)!;

    expect(runtimeModel.maxTokens).toBe(builtInModel.maxTokens - 1);

    registration.provider.streamSimple(
      runtimeModel,
      { messages: [] },
      { maxTokens: builtInModel.maxTokens },
    );

    expect(streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: builtInModel.maxTokens - 1 }),
      { messages: [] },
      expect.objectContaining({ maxTokens: builtInModel.maxTokens - 1 }),
    );
  });

  it('routes global-only Vertex models through the global endpoint', () => {
    const builtIn = googleVertexProvider();
    const stream = vi.fn<typeof builtIn.stream>(() => {
      const result = createAssistantMessageEventStream();
      result.end();
      return result;
    });
    const streamSimple = vi.fn<typeof builtIn.streamSimple>(() => {
      const result = createAssistantMessageEventStream();
      result.end();
      return result;
    });
    const registration = googleVertexProviderRuntimeRegistration(
      resolveGoogleVertexProviderStatus(undefined, {}),
      {},
      { ...builtIn, stream, streamSimple },
    );
    const globalOnlyModel = registration.provider
      .getModels()
      .find((model) => model.id === 'gemini-3.6-flash')!;
    const regionalModel = registration.provider
      .getModels()
      .find((model) => model.id === 'gemini-3.5-flash')!;

    registration.provider.stream(globalOnlyModel, { messages: [] }, {
      location: 'us-central1',
      env: { GOOGLE_CLOUD_LOCATION: 'us-central1' },
    } as Parameters<typeof builtIn.stream>[2]);
    registration.provider.streamSimple(
      globalOnlyModel,
      { messages: [] },
      { env: { GOOGLE_CLOUD_LOCATION: 'us-central1' } },
    );
    registration.provider.streamSimple(
      regionalModel,
      { messages: [] },
      { env: { GOOGLE_CLOUD_LOCATION: 'us-central1' } },
    );

    expect(stream.mock.calls[0]?.[2]).toMatchObject({
      location: 'global',
      env: { GOOGLE_CLOUD_LOCATION: 'global' },
    });
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({
      env: { GOOGLE_CLOUD_LOCATION: 'global' },
    });
    expect(streamSimple.mock.calls[1]?.[2]).toMatchObject({
      env: { GOOGLE_CLOUD_LOCATION: 'us-central1' },
    });
  });

  it('sanitizes stored blank Vertex credentials through Pi stream dispatch', async () => {
    const builtIn = googleVertexProvider();
    const stream = vi.fn<typeof builtIn.stream>(() => {
      const result = createAssistantMessageEventStream();
      result.end();
      return result;
    });
    const storedCredential: ApiKeyCredential = {
      type: 'api_key',
      key: '   ',
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: '   ',
        GOOGLE_CLOUD_PROJECT: 'stored-project',
        GOOGLE_CLOUD_LOCATION: 'stored-location',
      },
    };
    const credentials: CredentialStore = {
      read: async () => storedCredential,
      list: async () => [],
      modify: async (_providerId, update) =>
        (await update(storedCredential)) ?? storedCredential,
      delete: async () => undefined,
    };
    const capturedEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: '   ',
    } as NodeJS.ProcessEnv;
    const registration = googleVertexProviderRuntimeRegistration(
      resolveGoogleVertexProviderStatus(undefined, capturedEnv, () => true),
      capturedEnv,
      { ...builtIn, stream },
    );
    let resolvedDefaultAdcPath = '';
    const models = createModels({
      credentials,
      authContext: {
        env: async () => undefined,
        fileExists: async (path) => {
          resolvedDefaultAdcPath = path;
          return true;
        },
      },
    });
    models.setProvider(registration.provider);

    models.stream(registration.provider.getModels()[0]!, { messages: [] });
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
    expect(resolvedDefaultAdcPath).toBe(
      '~/.config/gcloud/application_default_credentials.json',
    );
    expect(stream.mock.calls[0]?.[2]).toMatchObject({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: join(
          homedir(),
          '.config/gcloud/application_default_credentials.json',
        ),
        GOOGLE_CLOUD_PROJECT: 'stored-project',
        GOOGLE_CLOUD_LOCATION: 'stored-location',
      },
    });
    expect(stream.mock.calls[0]?.[2]?.apiKey).toBeUndefined();
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
