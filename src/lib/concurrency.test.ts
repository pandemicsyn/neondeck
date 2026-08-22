import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('bounds concurrent work and preserves input order', async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });

    expect(result).toEqual([2, 4, 6, 8]);
    expect(maximumActive).toBe(2);
  });

  it('rejects when a mapper fails', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (item) => {
        if (item === 2) throw new Error('failed item');
        return item;
      }),
    ).rejects.toThrow('failed item');
  });
});
