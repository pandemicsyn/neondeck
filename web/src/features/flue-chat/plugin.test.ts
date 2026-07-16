import { describe, expect, it } from 'vitest';
import { referenceableChatSessions } from './plugin';

describe('referenceableChatSessions', () => {
  it('never offers the active session as its own reference target', () => {
    const sessions = [{ id: 'active' }, { id: 'other' }];

    expect(referenceableChatSessions(sessions, 'active')).toEqual([
      { id: 'other' },
    ]);
  });
});
