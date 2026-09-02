import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelDiscoveryResult } from '../modules/model-catalog';
import { runtimePaths } from '../runtime-home';

const mocks = vi.hoisted(() => ({
  discoverModels: vi.fn(),
  recommendedCatalogModel: vi.fn(),
  promptPassword: vi.fn(),
  promptSelect: vi.fn(),
  promptText: vi.fn(),
  writeDotEnvFile: vi.fn(),
  updateAgentModels: vi.fn(),
  updateProviderConfig: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  log: { warn: mocks.warn, success: mocks.success },
  spinner: () => mocks.spinner,
}));

vi.mock('./prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompts')>()),
  promptPassword: mocks.promptPassword,
  promptSelect: mocks.promptSelect,
  promptText: mocks.promptText,
  writeDotEnvFile: mocks.writeDotEnvFile,
}));

vi.mock('./modules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules')>()),
  configActionsModule: async () => ({
    updateAgentModels: mocks.updateAgentModels,
    updateProviderConfig: mocks.updateProviderConfig,
  }),
  modelDiscoveryModule: async () => ({
    discoverModels: mocks.discoverModels,
    recommendedCatalogModel: mocks.recommendedCatalogModel,
  }),
}));

import {
  chooseModel,
  configureProviderAndModels,
  configureProviderSecret,
} from './onboarding';

const models = [
  {
    id: 'openrouter/openai/gpt-5.6-terra',
    provider: 'openrouter' as const,
    model: 'openai/gpt-5.6-terra',
    name: 'Terra',
    api: 'openai-completions',
    contextLength: 1_000_000,
    reasoning: true,
    isFree: false,
    createdAt: 1_787_000_000,
    recommendedIndex: null,
    source: 'provider-live' as const,
  },
  {
    id: 'openrouter/openai/gpt-5.6-luna',
    provider: 'openrouter' as const,
    model: 'openai/gpt-5.6-luna',
    name: 'Luna',
    api: 'openai-completions',
    contextLength: 256_000,
    reasoning: true,
    isFree: false,
    createdAt: 1_786_000_000,
    recommendedIndex: null,
    source: 'provider-live' as const,
  },
];

function discovery(
  overrides: Partial<ModelDiscoveryResult> = {},
): ModelDiscoveryResult {
  return {
    ok: true,
    provider: 'openrouter',
    models,
    diagnostics: {
      source: 'provider-live',
      stale: false,
      fetchedCount: models.length,
      selectableCount: models.length,
      excluded: { invalid: 0, unsupported: 0, unavailableInRuntime: 0 },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.discoverModels.mockResolvedValue(discovery());
  mocks.recommendedCatalogModel.mockReturnValue(undefined);
  mocks.promptPassword.mockResolvedValue('super-secret-value');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gateway onboarding model chooser', () => {
  it('presents account/public warnings and offline fallback diagnostics', async () => {
    mocks.discoverModels.mockResolvedValueOnce(
      discovery({ warning: 'Using the public catalog.' }),
    );
    mocks.promptSelect
      .mockResolvedValueOnce('search')
      .mockResolvedValueOnce(models[0]?.id);
    mocks.promptText.mockResolvedValueOnce('terra');

    await expect(
      chooseModel('openrouter', new Map([['OPENROUTER_API_KEY', 'secret']])),
    ).resolves.toBe(models[0]?.id);
    expect(mocks.warn).toHaveBeenCalledWith('Using the public catalog.');
    expect(mocks.promptSelect.mock.calls[0]?.[0]).toMatchObject({
      initialValue: 'search',
    });
    expect(mocks.promptSelect.mock.calls[0]?.[0].options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'default' })]),
    );

    mocks.discoverModels.mockResolvedValueOnce(
      discovery({
        ok: false,
        error: 'offline',
        diagnostics: {
          source: 'pi-bundled',
          stale: true,
          fetchedCount: 0,
          selectableCount: models.length,
          excluded: { invalid: 0, unsupported: 0, unavailableInRuntime: 0 },
        },
      }),
    );
    mocks.promptSelect
      .mockResolvedValueOnce('search')
      .mockResolvedValueOnce(models[0]?.id);
    mocks.promptText.mockResolvedValueOnce('terra');

    await expect(chooseModel('openrouter', new Map())).resolves.toBe(
      models[0]?.id,
    );
    expect(mocks.warn).toHaveBeenCalledWith('offline');
    expect(mocks.spinner.stop).toHaveBeenLastCalledWith(
      'OpenRouter live discovery unavailable; using pi-bundled',
    );
  });

  it('reuses one discovery request when approved role defaults are supplied', async () => {
    const cache = new Map();
    mocks.recommendedCatalogModel.mockImplementation(
      (_provider: string, role: string) =>
        role === 'displayAssistant' ? models[0]?.id : models[1]?.id,
    );
    mocks.promptSelect.mockResolvedValue('default');

    await expect(
      Promise.all([
        chooseModel('openrouter', new Map(), cache, 'displayAssistant'),
        chooseModel('openrouter', new Map(), cache, 'utility'),
        chooseModel('openrouter', new Map(), cache, 'explore'),
      ]),
    ).resolves.toEqual([models[0]?.id, models[1]?.id, models[1]?.id]);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(1);
  });

  it('searches the effective catalog and constrains manual entry to it', async () => {
    mocks.promptSelect
      .mockResolvedValueOnce('search')
      .mockResolvedValueOnce(models[1]?.id);
    mocks.promptText.mockResolvedValueOnce('luna');

    await expect(chooseModel('openrouter', new Map())).resolves.toBe(
      models[1]?.id,
    );
    expect(mocks.promptSelect.mock.calls[1]?.[0]).toMatchObject({
      message: 'Select model (1-1 of 1)',
      options: expect.arrayContaining([
        expect.objectContaining({ value: models[1]?.id }),
      ]),
    });

    mocks.promptSelect.mockResolvedValueOnce('manual');
    mocks.promptText
      .mockResolvedValueOnce('openrouter/not-in-catalog')
      .mockResolvedValueOnce(models[0]?.id);

    await expect(chooseModel('openrouter', new Map())).resolves.toBe(
      models[0]?.id,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'is not available in the effective OpenRouter catalog',
      ),
    );
  });

  it('allows repeated searches after no matches or from the result menu', async () => {
    mocks.promptSelect
      .mockResolvedValueOnce('search')
      .mockResolvedValueOnce('__neondeck_search_again__')
      .mockResolvedValueOnce('__neondeck_search_again__')
      .mockResolvedValueOnce(models[1]?.id);
    mocks.promptText
      .mockResolvedValueOnce('does-not-exist')
      .mockResolvedValueOnce('terra')
      .mockResolvedValueOnce('luna');

    await expect(chooseModel('openrouter', new Map())).resolves.toBe(
      models[1]?.id,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'No discovered models matched that search.',
    );
    expect(mocks.promptText).toHaveBeenCalledTimes(3);
    expect(mocks.promptSelect.mock.calls[1]?.[0]).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({
          value: '__neondeck_search_again__',
          label: 'Search again',
        }),
        expect.objectContaining({
          value: '__neondeck_model_choices__',
          label: 'Back to model choices',
        }),
      ]),
    });
  });

  it('pages through every search match instead of silently truncating results', async () => {
    const pagedModels = Array.from({ length: 13 }, (_, index) => ({
      ...models[0]!,
      id: `openrouter/z-ai/glm-${index + 1}`,
      model: `z-ai/glm-${index + 1}`,
      name: `GLM ${index + 1}`,
      createdAt: index + 1,
    }));
    mocks.discoverModels.mockResolvedValueOnce(
      discovery({
        models: pagedModels,
        diagnostics: {
          ...discovery().diagnostics,
          fetchedCount: pagedModels.length,
          selectableCount: pagedModels.length,
        },
      }),
    );
    mocks.promptSelect
      .mockResolvedValueOnce('search')
      .mockResolvedValueOnce('__neondeck_search_next__')
      .mockResolvedValueOnce(pagedModels[0]?.id);
    mocks.promptText.mockResolvedValueOnce('glm');

    await expect(chooseModel('openrouter', new Map())).resolves.toBe(
      pagedModels[0]?.id,
    );
    expect(mocks.promptSelect.mock.calls[1]?.[0]).toMatchObject({
      message: 'Select model (1-12 of 13)',
      options: expect.arrayContaining([
        expect.objectContaining({
          value: '__neondeck_search_next__',
          label: 'More results',
        }),
      ]),
    });
    expect(mocks.promptSelect.mock.calls[2]?.[0]).toMatchObject({
      message: 'Select model (13-13 of 13)',
      options: expect.arrayContaining([
        expect.objectContaining({ value: pagedModels[0]?.id }),
        expect.objectContaining({
          value: '__neondeck_search_previous__',
          label: 'Previous results',
        }),
      ]),
    });
  });

  it('can return directly from a zero-result search to the model choices', async () => {
    mocks.promptSelect
      .mockResolvedValueOnce('search')
      .mockResolvedValueOnce('__neondeck_model_choices__')
      .mockResolvedValueOnce('manual');
    mocks.promptText
      .mockResolvedValueOnce('does-not-exist')
      .mockResolvedValueOnce(models[0]?.id);

    await expect(chooseModel('openrouter', new Map())).resolves.toBe(
      models[0]?.id,
    );
    expect(mocks.promptSelect).toHaveBeenCalledTimes(3);
  });

  it('persists the provider before model selections and reuses discovery during setup', async () => {
    mocks.promptSelect.mockImplementation(
      async (options: { message: string }) => {
        if (options.message === 'Model provider') return 'openrouter';
        if (options.message === 'OpenRouter model') return 'search';
        if (options.message.startsWith('Select model (')) return models[0]?.id;
        if (options.message === 'Utility model') return 'skip';
        if (options.message === 'Explore subagent model') return 'default';
        if (options.message.includes('thinking level')) return 'medium';
        return 'medium';
      },
    );
    mocks.promptText.mockResolvedValueOnce('terra');

    await configureProviderAndModels(
      runtimePaths('/tmp/neondeck-onboarding-test'),
    );

    expect(mocks.updateProviderConfig).toHaveBeenCalledWith(
      {
        provider: 'openrouter',
        enabled: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
      expect.anything(),
    );
    expect(mocks.updateProviderConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateAgentModels.mock.invocationCallOrder[0]!,
    );
    expect(mocks.updateAgentModels).toHaveBeenCalledWith(
      expect.objectContaining({ displayAssistant: models[0]?.id }),
      expect.anything(),
    );
    expect(mocks.discoverModels).toHaveBeenCalledTimes(1);
  });

  it('writes gateway secrets only through the env file and never logs values', async () => {
    const env = new Map<string, string>();
    const paths = runtimePaths('/tmp/neondeck-onboarding-secret-test');

    await configureProviderSecret('openrouter', env, paths);

    expect(env.get('OPENROUTER_API_KEY')).toBe('super-secret-value');
    expect(mocks.writeDotEnvFile).toHaveBeenCalledWith(paths.env, env);
    expect(JSON.stringify(mocks.success.mock.calls)).not.toContain(
      'super-secret-value',
    );
  });

  it('writes Google Vertex API keys only through the env file', async () => {
    const env = new Map<string, string>();
    const paths = runtimePaths('/tmp/neondeck-onboarding-vertex-key-test');
    mocks.promptSelect.mockResolvedValueOnce('api-key');

    await configureProviderSecret('google-vertex', env, paths);

    expect(env.get('GOOGLE_CLOUD_API_KEY')).toBe('super-secret-value');
    expect(mocks.writeDotEnvFile).toHaveBeenCalledWith(paths.env, env);
    expect(JSON.stringify(mocks.success.mock.calls)).not.toContain(
      'super-secret-value',
    );
  });

  it('configures Google Vertex ADC without persisting credential contents', async () => {
    const env = new Map<string, string>([
      ['GOOGLE_CLOUD_API_KEY', 'old-key'],
      ['GCLOUD_PROJECT', 'old-project'],
    ]);
    const paths = runtimePaths('/tmp/neondeck-onboarding-vertex-adc-test');
    mocks.promptSelect.mockResolvedValueOnce('adc');
    mocks.promptText
      .mockResolvedValueOnce('neondeck-project')
      .mockResolvedValueOnce('us-central1')
      .mockResolvedValueOnce('/secure/service-account.json');

    await configureProviderSecret('google-vertex', env, paths);

    expect(Object.fromEntries(env)).toMatchObject({
      GOOGLE_CLOUD_PROJECT: 'neondeck-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
      GOOGLE_APPLICATION_CREDENTIALS: '/secure/service-account.json',
    });
    expect(env.has('GOOGLE_CLOUD_API_KEY')).toBe(false);
    expect(env.has('GCLOUD_PROJECT')).toBe(false);
    expect(mocks.writeDotEnvFile).toHaveBeenCalledWith(paths.env, env);
  });
});
