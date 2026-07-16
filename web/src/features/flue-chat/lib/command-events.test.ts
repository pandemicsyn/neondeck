import { describe, expect, it } from 'vitest';
import { upsertCommandEvent } from './command-events';

describe('upsertCommandEvent', () => {
  it('replaces an event already received through SSE instead of duplicating it', () => {
    const events = [{ id: 'event-1', status: 'pending' }];

    expect(
      upsertCommandEvent(events, { id: 'event-1', status: 'running' }),
    ).toEqual([{ id: 'event-1', status: 'running' }]);
  });

  it('appends new events and preserves the history limit', () => {
    const events = [
      { id: 'event-1', status: 'completed' },
      { id: 'event-2', status: 'completed' },
    ];

    expect(
      upsertCommandEvent(events, { id: 'event-3', status: 'pending' }, 2),
    ).toEqual([
      { id: 'event-2', status: 'completed' },
      { id: 'event-3', status: 'pending' },
    ]);
  });
});
