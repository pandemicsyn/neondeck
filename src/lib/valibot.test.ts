import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { parseInput } from './valibot';

describe('valibot helpers', () => {
  it('returns parsed input on success', () => {
    const parsed = parseInput(
      v.object({ id: v.string() }),
      { id: 'one' },
      (message) => ({ message }),
    );

    expect(parsed).toEqual({ ok: true, input: { id: 'one' } });
  });

  it('maps validation issues through the caller result factory', () => {
    const parsed = parseInput(
      v.object({ id: v.string() }),
      { id: 1 },
      (message, issues) => ({ message, issueCount: issues.length }),
      () => 'Invalid input.',
    );

    expect(parsed).toEqual({
      ok: false,
      result: { message: 'Invalid input.', issueCount: 1 },
    });
  });
});
