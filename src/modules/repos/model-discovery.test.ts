import { describe, expect, it } from 'vitest';
import { defaultOpenAiCodexModel } from '../../model-defaults';
import { suggestedModels } from './model-discovery';

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
});
