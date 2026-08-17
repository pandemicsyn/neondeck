import { describe, expect, it } from 'vitest';
import {
  ActionResultError,
  actionResultErrorDetails,
  asJsonValue,
  failedAction,
  invalidInputAction,
  okAction,
} from './action-result';

describe('action-result helpers', () => {
  it('creates the common ok action shape', () => {
    expect(okAction('demo', true, 'Done.', { data: { id: 'one' } })).toEqual({
      ok: true,
      action: 'demo',
      changed: true,
      message: 'Done.',
      data: { id: 'one' },
    });
  });

  it('creates the common failed action shape', () => {
    expect(
      failedAction('demo', 'Nope.', {
        errors: ['Nope.'],
        requires: ['approval'],
      }),
    ).toEqual({
      ok: false,
      action: 'demo',
      changed: false,
      message: 'Nope.',
      errors: ['Nope.'],
      requires: ['approval'],
    });
  });

  it('creates the common invalid input shape', () => {
    expect(invalidInputAction('demo', 'Invalid.')).toEqual({
      ok: false,
      action: 'demo',
      changed: false,
      message: 'Invalid.',
      errors: ['Invalid.'],
      error: { code: 'INVALID_INPUT', message: 'Invalid.' },
    });
  });

  it('preserves structured action failure diagnostics across thrown boundaries', () => {
    const error = new ActionResultError({
      action: 'github_pr_event_state_get',
      message: 'Could not fetch GitHub PR event state.',
      errors: ['GitHub request failed with 403: Resource not accessible.'],
      requires: ['GITHUB_TOKEN repository access'],
    });

    expect(error).toMatchObject({
      name: 'ActionResultError',
      action: 'github_pr_event_state_get',
      message: 'Could not fetch GitHub PR event state.',
    });
    expect(actionResultErrorDetails(error)).toEqual({
      errors: ['GitHub request failed with 403: Resource not accessible.'],
      requires: ['GITHUB_TOKEN repository access'],
    });
    expect(actionResultErrorDetails(new Error('plain failure'))).toEqual({});
  });

  it('serializes values into JSON-compatible data', () => {
    expect(
      asJsonValue({
        keep: true,
        drop: undefined,
        nested: [{ value: 1 }],
      }),
    ).toEqual({ keep: true, nested: [{ value: 1 }] });
  });
});
