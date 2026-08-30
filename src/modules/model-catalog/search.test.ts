import { describe, expect, it } from 'vitest';
import type { DiscoveredModel } from './model-discovery';
import { searchDiscoveredModels } from './search';

function model(
  id: string,
  createdAt: number | null,
  name = id,
): DiscoveredModel {
  return {
    id: `openrouter/${id}`,
    provider: 'openrouter',
    model: id,
    name,
    api: 'openai-completions',
    contextLength: null,
    reasoning: false,
    isFree: null,
    createdAt,
    recommendedIndex: null,
    source: 'provider-live',
  };
}

describe('searchDiscoveredModels', () => {
  it('ranks relevance first and recency within equally relevant matches', () => {
    const results = searchDiscoveredModels(
      [
        model('z-ai/glm-4.5', 300),
        model('z-ai/glm-5.3-flash', 500),
        model('z-ai/glm-5', 400),
        model('vendor/not-glm', 600, 'GLM helper'),
      ],
      'glm',
    );

    expect(results.map((result) => result.model)).toEqual([
      'z-ai/glm-5.3-flash',
      'z-ai/glm-5',
      'z-ai/glm-4.5',
      'vendor/not-glm',
    ]);
  });

  it('puts exact matches ahead of newer partial matches', () => {
    const results = searchDiscoveredModels(
      [model('vendor/glm-5.3-flash-preview', 500), model('z-ai/glm-5.3', 100)],
      'glm-5.3',
    );

    expect(results.map((result) => result.model)).toEqual([
      'z-ai/glm-5.3',
      'vendor/glm-5.3-flash-preview',
    ]);
  });
});
