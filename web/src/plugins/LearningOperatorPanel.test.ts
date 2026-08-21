import { describe, expect, it } from 'vitest';
import { reviewSummary } from './LearningOperatorPanel';

describe('Learning operator review summaries', () => {
  it('preserves array-shaped summaries as arrays', () => {
    expect(reviewSummary(['first', 'second'])).toBe('["first","second"]');
  });
});
