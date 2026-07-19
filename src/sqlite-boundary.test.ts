import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rawConstructorBoundaries = new Set([
  'src/lib/sqlite.ts',
  'src/runtime-home/app-db/migrate.ts',
]);

describe('SQLite access boundary', () => {
  it('routes production database opens through the shared gateway', () => {
    const violations = globSync('src/**/*.ts', {
      exclude: ['src/**/*.test.ts'],
    }).filter(
      (path) =>
        !rawConstructorBoundaries.has(path) &&
        /new\s+DatabaseSync\s*\(/.test(readFileSync(path, 'utf8')),
    );

    expect(violations).toEqual([]);
  });
});
