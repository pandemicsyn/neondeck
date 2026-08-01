import { describe, expect, it } from 'vitest';
import { multiplyAcceptanceValues } from './flue2-autopilot-safe-acceptance';

describe('multiplyAcceptanceValues', () => {
  it('multiplies both values', () => {
    expect(multiplyAcceptanceValues(3, 4)).toBe(12);
  });
});
