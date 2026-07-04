import { describe, expect, it } from 'vitest';
import {
  providerRuntimeRegistrations,
  resolveKilocodeProviderStatus,
} from './providers';

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

  it('prefers KILOCODE_API_KEY unless only the legacy Kilo key is present', () => {
    expect(resolveKilocodeProviderStatus(undefined, {})).toMatchObject({
      apiKeyEnv: 'KILOCODE_API_KEY',
      apiKeyPresent: false,
    });
    expect(
      resolveKilocodeProviderStatus(undefined, {
        KILO_API_KEY: 'legacy',
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      apiKeyEnv: 'KILO_API_KEY',
      apiKeyPresent: true,
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
});
