import { describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import {
  providerRuntimeRegistrations,
  resolveKilocodeProviderStatus,
} from './modules/repos/providers';

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
      { OPENROUTER_API_KEY: 'router-key' } as NodeJS.ProcessEnv,
      {
        models: {
          displayAssistant: 'openrouter/openai/gpt-5.5',
        },
        providers: {
          openaiCompatible: [
            {
              id: 'openrouter',
              baseUrl: 'https://openrouter.ai/api/v1/',
              apiKeyEnv: 'OPENROUTER_API_KEY',
            },
          ],
        },
      },
    );

    expect(registrations).toEqual(
      expect.arrayContaining([
        {
          id: 'openrouter',
          provider: expect.objectContaining({
            baseUrl: 'https://openrouter.ai/api/v1',
          }),
        },
      ]),
    );
    await expect(
      resolveApiKey(registrations, 'openrouter'),
    ).resolves.toMatchObject({ auth: { apiKey: 'router-key' } });
    expect(
      registrations
        .find((registration) => registration.id === 'openrouter')
        ?.provider.getModels(),
    ).toEqual([
      expect.objectContaining({
        id: 'openai/gpt-5.5',
        api: 'openai-completions',
        provider: 'openrouter',
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
