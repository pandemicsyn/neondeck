import { describe, expect, it } from 'vitest';
import { dataRecord, objectRecord } from './pr-context';

describe('learning review PR context records', () => {
  it('does not reinterpret arrays as numeric-keyed objects', () => {
    expect(objectRecord(['unexpected'])).toBeNull();
    expect(dataRecord(['unexpected'])).toEqual({});
  });
});
