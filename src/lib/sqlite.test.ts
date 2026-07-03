import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  isUniqueConstraintError,
  parseRow,
  readJsonColumn,
  writeJsonColumn,
  writeNullableJsonColumn,
} from './sqlite';

describe('sqlite helpers', () => {
  it('parses rows with context-rich failures', () => {
    const schema = v.object({ id: v.string() });

    expect(parseRow({ id: 'one' }, schema, 'read demo')).toEqual({
      id: 'one',
    });
    expect(() => parseRow({ id: 1 }, schema, 'read demo')).toThrow(
      /read demo:/,
    );
  });

  it('reads and writes JSON columns', () => {
    expect(readJsonColumn('{"id":"one"}')).toEqual({ id: 'one' });
    expect(readJsonColumn(null)).toBeNull();
    expect(writeJsonColumn({ id: 'one', drop: undefined })).toBe(
      '{"id":"one"}',
    );
    expect(writeNullableJsonColumn(undefined)).toBeNull();
  });

  it('detects SQLite unique constraint failures', () => {
    expect(
      isUniqueConstraintError(new Error('UNIQUE constraint failed: table.id')),
    ).toBe(true);
    expect(isUniqueConstraintError(new Error('other failure'))).toBe(false);
  });
});
