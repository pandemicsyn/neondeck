import { beforeEach, expect, it, vi } from 'vitest';
import { log } from '@clack/prompts';
import { discoverModels, suggestedModels } from '../modules/model-catalog';
import {
  codingModels,
  defaultKiloCodingModel,
  pickCodingModel,
  validateCodingModel,
} from './coding-model-picker';
import { promptSelect, promptText } from './prompts';
vi.mock('../modules/model-catalog', async (original) => ({
  ...(await original<typeof import('../modules/model-catalog')>()),
  discoverModels: vi.fn<typeof discoverModels>(),
}));
vi.mock('./prompts', () => ({
  promptSelect: vi.fn<typeof promptSelect>(),
  promptText: vi.fn<typeof promptText>(),
}));
vi.mock('@clack/prompts', () => ({ log: { info: vi.fn<typeof log.info>() } }));
beforeEach(() => vi.resetAllMocks());
it('uses offline Frontier without a key and does not claim authentication', async () => {
  const result = await codingModels('kilo', {});
  expect(discoverModels).not.toHaveBeenCalled();
  expect(result.models[0].model).toBe('kilo-auto/frontier');
  expect(result.warning).toContain('authentication is still required');
  vi.mocked(promptSelect).mockResolvedValueOnce(defaultKiloCodingModel);
  expect(await pickCodingModel('kilo', null, {})).toBe(
    'kilo/kilo-auto/frontier',
  );
});
it('guards thrown errors and never displays their contents', async () => {
  vi.mocked(discoverModels).mockRejectedValue(new Error('synthetic-secret'));
  vi.mocked(promptSelect).mockResolvedValueOnce(defaultKiloCodingModel);
  await pickCodingModel('kilo', null, { KILOCODE_API_KEY: 'synthetic-secret' });
  expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(
    'synthetic-secret',
  );
  expect(vi.mocked(log.info).mock.calls[0][0]).toContain('catalog unavailable');
});
it('projects valid catalog rows and forwards key and organization only to discovery', async () => {
  vi.mocked(discoverModels).mockResolvedValue({
    ok: true,
    models: [
      null,
      {
        provider: 'kilocode',
        model: 'anthropic/claude-future',
        name: 'Claude Future',
        secret: 'synthetic',
      },
      { provider: 'kilocode', model: 'bad\nmodel', name: 'bad' },
      { provider: 'kilocode', model: 'kilocode/wrong', name: 'bad' },
      { provider: 'kilocode', model: 'ok', name: '\x1b[31m' },
    ],
    diagnostics: { stale: false },
  } as never);
  const result = await codingModels('kilo', {
    KILOCODE_API_KEY: 'synthetic-key',
    KILOCODE_ORGANIZATION_ID: 'org',
  });
  expect(discoverModels).toHaveBeenCalledWith({
    provider: 'kilocode',
    apiKey: 'synthetic-key',
    organizationId: 'org',
  });
  expect(result.models.map((model) => model.model)).toEqual([
    'kilo-auto/frontier',
    'anthropic/claude-future',
  ]);
  expect(JSON.stringify(result)).not.toContain('synthetic');
});
it('has all seven Codex choices, preserves Sol, and allows future manual models', async () => {
  expect(suggestedModels('openai-codex')).toHaveLength(7);
  vi.mocked(promptSelect).mockResolvedValueOnce(':manual');
  vi.mocked(promptText).mockResolvedValueOnce('gpt-future');
  expect(await pickCodingModel('codex', null, {})).toBe('gpt-future');
  expect(vi.mocked(promptSelect).mock.calls[0][0].initialValue).toBe(
    'gpt-5.6-sol',
  );
  expect(
    validateCodingModel('kilo', 'kilocode/kilo-auto/frontier'),
  ).toBeTruthy();
  expect(validateCodingModel('codex', '--flag')).toBeTruthy();
});
it('searches and pages a bounded catalog with CLI-prefixed results', async () => {
  vi.mocked(discoverModels).mockResolvedValue({
    ok: true,
    diagnostics: { stale: false },
    models: Array.from({ length: 25 }, (_, i) => ({
      provider: 'kilocode',
      model: `provider/model-${i}`,
      name: `Model ${i}`,
    })),
  } as never);
  vi.mocked(promptSelect)
    .mockResolvedValueOnce(':next')
    .mockResolvedValueOnce(':previous')
    .mockResolvedValueOnce(':search')
    .mockResolvedValueOnce('kilo/provider/model-24');
  vi.mocked(promptText).mockResolvedValueOnce('model-24');
  expect(
    await pickCodingModel('kilo', null, { KILOCODE_API_KEY: 'synthetic' }),
  ).toBe('kilo/provider/model-24');
  for (const [prompt] of vi.mocked(promptSelect).mock.calls)
    expect(prompt.options.length).toBeLessThanOrEqual(15);
  const last = vi.mocked(promptSelect).mock.calls.at(-1)![0];
  expect(
    last.options.some((option) => option.value === 'kilo/provider/model-24'),
  ).toBe(true);
});
it('keeps fallback diagnostics generic even when discovery returns unsafe error text', async () => {
  vi.mocked(discoverModels).mockResolvedValue({
    ok: false,
    models: [],
    diagnostics: { stale: true },
    error: 'synthetic-secret',
  } as never);
  const result = await codingModels('kilo', {
    KILOCODE_API_KEY: 'synthetic-secret',
  });
  expect(result.models[0].model).toBe('kilo-auto/frontier');
  expect(result.warning).toContain('catalog unavailable');
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});
