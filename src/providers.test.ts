import { describe, expect, it } from 'vitest';
import {
  providerRuntimeRegistrations,
  resolveKilocodeProviderStatus,
} from './modules/repos';

describe('provider runtime registrations', () => {
  it('sets an explicit KiloCode gateway output-token budget', () => {
    const registrations = providerRuntimeRegistrations({
      KILOCODE_API_KEY: 'kilo-key',
    } as NodeJS.ProcessEnv);

    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kilocode',
          registration: expect.objectContaining({
            api: 'openai-completions',
            maxTokens: 16_384,
          }),
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

  it('uses configured OpenAI and Anthropic environment references for Flue', () => {
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

    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          registration: expect.objectContaining({
            apiKey: 'configured-openai-key',
          }),
        }),
        expect.objectContaining({
          id: 'anthropic',
          registration: expect.objectContaining({
            apiKey: 'configured-anthropic-key',
          }),
        }),
      ]),
    );
  });

  it('does not fall back to default built-in provider env vars when disabled', () => {
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

    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          registration: expect.objectContaining({ apiKey: '' }),
        }),
        expect.objectContaining({
          id: 'anthropic',
          registration: expect.objectContaining({ apiKey: '' }),
        }),
      ]),
    );
  });

  it('registers configured OpenAI-compatible endpoints with env-backed keys', () => {
    const registrations = providerRuntimeRegistrations(
      { OPENROUTER_API_KEY: 'router-key' } as NodeJS.ProcessEnv,
      {
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
          registration: expect.objectContaining({
            api: 'openai-completions',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'router-key',
          }),
        },
      ]),
    );
  });

  it('uses a non-secret placeholder for compatible endpoints without auth', () => {
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

    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-models',
          registration: expect.objectContaining({ apiKey: 'unused' }),
        }),
      ]),
    );
  });
});
