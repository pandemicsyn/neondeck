import { describe, expect, it } from 'vitest';
import { parseFlueChatConfig } from './config';

describe('parseFlueChatConfig', () => {
  it('accepts the routed display assistant agent', () => {
    expect(
      parseFlueChatConfig({ agentName: 'display-assistant' }),
    ).toMatchObject({
      config: { agentName: 'display-assistant' },
      issues: [],
    });
  });

  it('rejects agent names that do not share the session and route model', () => {
    expect(parseFlueChatConfig({ agentName: 'other-agent' })).toMatchObject({
      config: { agentName: 'display-assistant' },
      issues: ['agentName must be "display-assistant".'],
    });
  });
});
