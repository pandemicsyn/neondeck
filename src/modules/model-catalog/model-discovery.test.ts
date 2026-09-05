import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultOpenAiCodexModel } from '../../model-defaults';
import { suggestedGatewayModels } from '../../lib/gateway-model-policy';
import {
  discoverModels,
  recommendedCatalogModel,
  suggestedModels,
} from './model-discovery';
import {
  parseOpenCodeModels,
  parseOpenRouterModels,
} from './gateway-model-discovery';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('suggestedModels', () => {
  it('recommends the current ChatGPT subscription model family', () => {
    const models = suggestedModels('openai-codex');

    expect(models.map((model) => model.id)).toEqual([
      defaultOpenAiCodexModel,
      'openai-codex/gpt-5.6-terra',
      'openai-codex/gpt-5.6-luna',
    ]);
    expect(models[0]?.recommendedIndex).toBe(0);
  });

  it('uses Pi bundled Google Vertex metadata for searchable Gemini models', async () => {
    const result = await discoverModels({ provider: 'google-vertex' });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject({
      source: 'pi-bundled',
      stale: false,
    });
    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'google-vertex/gemini-2.5-flash',
          api: 'google-vertex',
          contextLength: 1_048_576,
          reasoning: true,
          recommendedIndex: 0,
        }),
      ]),
    );
    expect(
      recommendedCatalogModel(
        'google-vertex',
        'displayAssistant',
        result.models,
      ),
    ).toBe('google-vertex/gemini-2.5-flash');
    expect(
      recommendedCatalogModel('google-vertex', 'utility', result.models),
    ).toBe('google-vertex/gemini-2.5-flash-lite');
    expect(
      recommendedCatalogModel('google-vertex', 'explore', result.models),
    ).toBe('google-vertex/gemini-2.5-flash');
  });
});

describe('gateway model catalog discovery', () => {
  it('materializes live tool-capable OpenRouter models ahead of the bundled Pi catalog', () => {
    const result = parseOpenRouterModels([
      {
        id: 'openai/gpt-5.6-terra',
        name: 'OpenAI GPT-5.6 Terra',
        created: 1_787_000_000,
        context_length: 1_050_000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools', 'reasoning'],
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
      {
        id: 'unknown/new-model',
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'openai/gpt-5.6-luna',
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['temperature'],
      },
    ]);

    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openrouter/openai/gpt-5.6-terra',
          api: 'openai-completions',
          reasoning: true,
          createdAt: 1_787_000_000,
          source: 'provider-live',
        }),
        expect.objectContaining({
          id: 'openrouter/unknown/new-model',
          api: 'openai-completions',
          contextLength: null,
          source: 'provider-live',
        }),
      ]),
    );
    expect(result.excluded).toEqual({
      invalid: 0,
      unsupported: 1,
      unavailableInRuntime: 0,
    });
  });

  it('includes newly cataloged GLM 5.3 Flash from OpenRouter', () => {
    const result = parseOpenRouterModels([
      {
        id: 'z-ai/glm-5.3-flash',
        name: 'Z.ai: GLM 5.3 Flash',
        context_length: 1_310_720,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools', 'reasoning'],
        pricing: { prompt: '0.000000075', completion: '0.00000025' },
      },
    ]);

    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'openrouter/z-ai/glm-5.3-flash',
        model: 'z-ai/glm-5.3-flash',
        api: 'openai-completions',
        contextLength: 1_310_720,
        reasoning: true,
      }),
    ]);
    expect(result.excluded.unavailableInRuntime).toBe(0);
  });

  it('normalizes only meaningful provider catalog timestamps', () => {
    const openRouter = parseOpenRouterModels([
      {
        id: 'provider/new',
        created: 1_787_000_000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'provider/unknown-date',
        created: 0,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ]);

    expect(
      Object.fromEntries(
        openRouter.models.map((model) => [model.model, model.createdAt]),
      ),
    ).toEqual({ 'provider/new': 1_787_000_000, 'provider/unknown-date': null });
  });

  it('only marks OpenRouter models free when both prices are explicit finite zeroes', () => {
    const row = (pricing: { prompt?: unknown; completion?: unknown }) => ({
      id: 'openai/gpt-5.6-terra',
      architecture: { output_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing,
    });

    expect(
      parseOpenRouterModels([row({ prompt: '0', completion: '0.000' })])
        .models[0]?.isFree,
    ).toBe(true);
    expect(
      parseOpenRouterModels([row({ prompt: '0.000001', completion: '0' })])
        .models[0]?.isFree,
    ).toBe(false);
    expect(
      parseOpenRouterModels([row({ prompt: null, completion: '0' })]).models[0]
        ?.isFree,
    ).toBeNull();
    expect(
      parseOpenRouterModels([row({ prompt: '', completion: '0' })]).models[0]
        ?.isFree,
    ).toBeNull();
  });

  it('requires explicit text output metadata from OpenRouter', () => {
    const row = (outputModalities?: unknown, architecture: unknown = {}) => ({
      id: 'provider/model',
      architecture:
        architecture === null
          ? null
          : {
              ...(architecture as object),
              output_modalities: outputModalities,
            },
      supported_parameters: ['tools'],
    });

    const result = parseOpenRouterModels([
      row(undefined),
      row('text'),
      row(['image']),
      row(undefined, null),
      row(['text']),
    ]);

    expect(result.models).toHaveLength(1);
    expect(result.excluded.unsupported).toBe(4);
  });

  it('counts malformed gateway rows instead of throwing', async () => {
    expect(parseOpenRouterModels([null, [], 42]).excluded.invalid).toBe(3);
    expect(parseOpenCodeModels([null, [], 'model']).excluded.invalid).toBe(3);

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [null] })),
    );
    await expect(
      discoverModels({ provider: 'opencode' }),
    ).resolves.toMatchObject({
      ok: false,
      provider: 'opencode',
      diagnostics: { source: 'pi-bundled', stale: true },
    });
  });

  it('preserves OpenCode model-level protocols from Pi', () => {
    const result = parseOpenCodeModels([
      { id: 'gpt-5.6-terra' },
      { id: 'claude-sonnet-4-6' },
      { id: 'gemini-3.6-flash' },
      { id: 'not-in-pi-yet' },
    ]);

    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'opencode/gpt-5.6-terra',
          api: 'openai-responses',
        }),
        expect.objectContaining({
          id: 'opencode/claude-sonnet-4-6',
          api: 'anthropic-messages',
        }),
        expect.objectContaining({
          id: 'opencode/gemini-3.6-flash',
          api: 'google-generative-ai',
        }),
      ]),
    );
    expect(result.excluded.unavailableInRuntime).toBe(1);
    expect(
      recommendedCatalogModel('opencode', 'displayAssistant', result.models),
    ).toBeUndefined();
    expect(
      recommendedCatalogModel('opencode', 'utility', result.models),
    ).toBeUndefined();
  });

  it('falls back from the account-filtered OpenRouter catalog to public discovery', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'openai/gpt-5.6-terra',
              architecture: { output_modalities: ['text'] },
              supported_parameters: ['tools', 'reasoning'],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverModels({
      provider: 'openrouter',
      apiKey: 'secret-key',
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toContain('account policy filters may differ');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).not.toMatchObject({
      headers: expect.objectContaining({ Authorization: expect.anything() }),
    });
  });

  it('uses the bundled Pi catalog when OpenCode discovery is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    );

    const result = await discoverModels({ provider: 'opencode' });

    expect(result).toMatchObject({
      ok: false,
      provider: 'opencode',
      diagnostics: { source: 'pi-bundled', stale: true },
      error: 'offline',
    });
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.map((model) => model.model).sort()).toEqual(
      suggestedGatewayModels('opencode')
        .map((model) => model.model)
        .sort(),
    );
  });

  it('preserves live exclusion diagnostics when a fetched catalog needs fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [{ id: 'not-in-pi-yet' }, null],
        }),
      ),
    );

    const result = await discoverModels({ provider: 'opencode' });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: {
        source: 'pi-bundled',
        stale: true,
        fetchedCount: 2,
        excluded: {
          invalid: 1,
          unsupported: 0,
          unavailableInRuntime: 1,
        },
      },
    });
  });

  it('follows bounded same-origin OpenRouter pagination links', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'openai/gpt-5.6-terra',
              architecture: { output_modalities: ['text'] },
              supported_parameters: ['tools'],
            },
          ],
          pagination: { next: '/api/v1/models?page=2' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'openai/gpt-5.6-luna',
              architecture: { output_modalities: ['text'] },
              supported_parameters: ['tools'],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverModels({ provider: 'openrouter' });

    expect(result.ok).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        'openrouter/openai/gpt-5.6-terra',
        'openrouter/openai/gpt-5.6-luna',
      ]),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://openrouter.ai/api/v1/models?page=2',
    );
  });

  it('shares one ten-second deadline across pagination and account fallback', async () => {
    vi.useFakeTimers();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => {
        setTimeout(
          () => deadline.abort(new Error('discovery deadline expired')),
          ms,
        );
        return deadline.signal;
      });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [],
          next: '/api/v1/models/user?page=2',
        }),
      )
      .mockImplementationOnce((_url, init) => {
        const signal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      })
      .mockImplementationOnce((_url, init) => {
        const signal = init?.signal as AbortSignal;
        return Promise.reject(signal.reason);
      });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = discoverModels({
      provider: 'openrouter',
      apiKey: 'secret-key',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      error: 'discovery deadline expired',
    });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[1]?.signal)).toEqual([
      deadline.signal,
      deadline.signal,
      deadline.signal,
    ]);
  });

  it('fails closed on cross-origin or cyclic catalog continuation links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [],
          next: 'https://attacker.example/models?page=2',
        }),
      ),
    );
    await expect(
      discoverModels({ provider: 'openrouter' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Model discovery rejected a cross-origin pagination link.',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [],
          next: 'https://openrouter.ai/api/v1/models?supported_parameters=tools&output_modalities=text',
        }),
      ),
    );
    await expect(
      discoverModels({ provider: 'openrouter' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Model discovery pagination repeated a page.',
    });
  });
});
