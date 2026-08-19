import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { actionErrorMessage } from './query';

describe('actionErrorMessage', () => {
  it('includes structured errors and requirements from API failures', () => {
    const error = new ApiError(
      'Could not fetch GitHub PR event state.',
      400,
      '/api/reviews',
      {
        errors: [
          'GitHub request failed with 403: Resource not accessible by integration',
        ],
        requires: ['GITHUB_TOKEN with pull request read access'],
      },
    );

    expect(actionErrorMessage(error)).toBe(
      'Could not fetch GitHub PR event state. GitHub request failed with 403: Resource not accessible by integration Requires: GITHUB_TOKEN with pull request read access',
    );
  });

  it('falls back to the ordinary error message', () => {
    expect(actionErrorMessage(new Error('Request failed.'))).toBe(
      'Request failed.',
    );
  });
});
