import { describe, expect, it } from 'vitest';
import { chatMessagesForRender } from './messages';

describe('chatMessagesForRender', () => {
  it('keeps live streaming messages while a turn is active', () => {
    const live = ['live'];
    const canonical = ['canonical'];

    expect(chatMessagesForRender(live, canonical, 'streaming')).toBe(live);
    expect(chatMessagesForRender(live, canonical, 'submitted')).toBe(live);
  });

  it('uses canonical history after the turn settles idle', () => {
    const live = ['partial'];
    const canonical = ['complete'];

    expect(chatMessagesForRender(live, canonical, 'idle')).toBe(canonical);
  });

  it('falls back to live messages when canonical history is unavailable', () => {
    const live = ['live'];

    expect(chatMessagesForRender(live, undefined, 'idle')).toBe(live);
  });
});
