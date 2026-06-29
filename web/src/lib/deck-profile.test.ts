import { describe, expect, it } from 'vitest';
import { classifyDeckProfile, deckArrangement } from './deck-profile';

describe('classifyDeckProfile', () => {
  it('treats the Xeneon Edge viewport as the ultrawide hero deck', () => {
    expect(classifyDeckProfile({ width: 2560, height: 720 })).toBe('ultrawide');
  });

  it('keeps a scaled-down ultrawide on the ultrawide deck (no false collapse)', () => {
    // Regression: absolute-px breakpoints used to collapse this to a stack.
    expect(classifyDeckProfile({ width: 1280, height: 360 })).toBe('ultrawide');
  });

  it('classifies a standard landscape window as wide', () => {
    expect(classifyDeckProfile({ width: 1440, height: 900 })).toBe('wide');
  });

  it('goes portrait when taller than wide', () => {
    expect(classifyDeckProfile({ width: 800, height: 1200 })).toBe('portrait');
  });

  it('goes compact for narrow viewports regardless of aspect', () => {
    expect(classifyDeckProfile({ width: 420, height: 360 })).toBe('compact');
    expect(classifyDeckProfile({ width: 420, height: 900 })).toBe('compact');
  });

  it('honors the xeneon mode override regardless of measured size', () => {
    expect(
      classifyDeckProfile({ width: 400, height: 1200, mode: 'xeneon' }),
    ).toBe('ultrawide');
  });

  it('honors the stacked mode override regardless of measured size', () => {
    expect(
      classifyDeckProfile({ width: 2560, height: 720, mode: 'stacked' }),
    ).toBe('portrait');
  });

  it('honors mode overrides even before the first measurement', () => {
    // Pinned because useDeckProfile's initial render relies on this: when the
    // shell hasn't been measured yet, a configured mode must still win over
    // the zero-size 'wide' fallback so the first paint matches intent.
    expect(
      classifyDeckProfile({ width: 0, height: 0, mode: 'xeneon' }),
    ).toBe('ultrawide');
    expect(
      classifyDeckProfile({ width: 0, height: 0, mode: 'stacked' }),
    ).toBe('portrait');
  });

  it('falls back to wide before the first measurement', () => {
    expect(classifyDeckProfile({ width: 0, height: 0 })).toBe('wide');
    expect(
      classifyDeckProfile({ width: Number.NaN, height: Number.NaN }),
    ).toBe('wide');
  });
});

describe('deckArrangement', () => {
  it('uses the side-by-side grid for ultrawide and wide', () => {
    expect(deckArrangement('ultrawide')).toBe('grid');
    expect(deckArrangement('wide')).toBe('grid');
  });

  it('uses the vertical column for portrait and compact', () => {
    expect(deckArrangement('portrait')).toBe('column');
    expect(deckArrangement('compact')).toBe('column');
  });
});
