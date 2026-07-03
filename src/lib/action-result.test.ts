import { describe, expect, it } from 'vitest';
import {
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
