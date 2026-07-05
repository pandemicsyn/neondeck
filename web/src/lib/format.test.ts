import { afterEach, describe, expect, it, vi } from 'vitest';
import { relativeTime } from './format';

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps future timestamps distinct from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'));

    expect(relativeTime('2026-07-05T12:30:00.000Z')).toBe('30m');
    expect(relativeTime('2026-07-05T12:30:00.000Z', { suffix: true })).toBe(
      'in 30m',
    );
  });
});
