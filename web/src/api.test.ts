import { describe, expect, it } from 'vitest';
import { learningOperatorStateUrl } from './api';

describe('dashboard API helpers', () => {
  it('builds learning operator candidate filters before limit', () => {
    expect(
      learningOperatorStateUrl({
        candidateStatus: 'proposed',
        candidateTarget: 'skill',
        limit: 3,
      }),
    ).toBe(
      '/api/learning/state?candidateStatus=proposed&candidateTarget=skill&limit=3',
    );
  });
});
