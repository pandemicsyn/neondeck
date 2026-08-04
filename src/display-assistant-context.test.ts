import { describe, expect, it } from 'vitest';
import { displayAssistantContextModelWasAdopted } from './agents/display-assistant';

const models = {
  displayAssistant: 'openai/gpt-5.5',
  displayAssistantThinkingLevel: 'high' as const,
};

describe('display assistant response context adoption', () => {
  it('acknowledges context only when the response started with its model selection', () => {
    expect(
      displayAssistantContextModelWasAdopted(
        {
          neondeckDisplayAssistant: {
            model: models.displayAssistant,
            thinkingLevel: models.displayAssistantThinkingLevel,
          },
        },
        models,
      ),
    ).toBe(true);
  });

  it('keeps context stale when a joined response is still using the prior model', () => {
    expect(
      displayAssistantContextModelWasAdopted(
        {
          neondeckDisplayAssistant: {
            model: 'openai/gpt-5-mini',
            thinkingLevel: 'medium',
          },
        },
        models,
      ),
    ).toBe(false);
    expect(displayAssistantContextModelWasAdopted({}, models)).toBe(false);
  });
});
