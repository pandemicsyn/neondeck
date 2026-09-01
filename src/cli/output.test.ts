import { describe, expect, it } from 'vitest';
import { formatProviderCredentialLines } from './output';

describe('provider credential output', () => {
  it('includes both first-class gateway credential states for setup and status', () => {
    expect(
      formatProviderCredentialLines({
        github: true,
        kilo: false,
        openai: false,
        openaiCodex: true,
        anthropic: false,
        openrouter: true,
        opencode: false,
      }),
    ).toEqual([
      'github     configured',
      'kilo       missing',
      'openai     missing',
      'chatgpt    configured',
      'anthropic  missing',
      'openrouter configured',
      'opencode   missing',
    ]);
  });
});
