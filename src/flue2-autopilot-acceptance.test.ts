import { describe, expect, it } from 'vitest';
import { addAcceptanceValues } from './flue2-autopilot-acceptance';

describe('Flue 2 Autopilot acceptance fixture', () => {
  it('adds both values', () => {
    expect(addAcceptanceValues(2, 5)).toBe(7);
  });
});
