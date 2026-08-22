import { describe, expect, it } from 'vitest';
import { reportSummary } from './ReportsPanel';

describe('reportSummary', () => {
  it('summarizes JSON arrays by their entries rather than as object properties', () => {
    expect(
      reportSummary([
        { summary: 'First finding' },
        { message: 'Second finding' },
      ]),
    ).toBe('First finding · Second finding');
  });
});
