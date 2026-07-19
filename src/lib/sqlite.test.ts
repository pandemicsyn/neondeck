import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  isUniqueConstraintError,
  parseRow,
  readJsonColumn,
  rollbackQuietly,
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

  it('preserves a lock error when BEGIN fails before a transaction opens', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-sqlite-'));
    const databasePath = join(home, 'neondeck.db');
    const owner = new DatabaseSync(databasePath);
    const contender = new DatabaseSync(databasePath);
    try {
      owner.exec('CREATE TABLE lock_test (id INTEGER PRIMARY KEY);');
      owner.exec('BEGIN IMMEDIATE;');
      contender.exec('PRAGMA busy_timeout = 0;');

      expect(() => {
        try {
          contender.exec('BEGIN IMMEDIATE;');
        } catch (error) {
          rollbackQuietly(contender);
          throw error;
        }
      }).toThrow(/database is locked/i);
    } finally {
      rollbackQuietly(owner);
      contender.close();
      owner.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
