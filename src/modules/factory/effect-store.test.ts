import { ValiError } from 'valibot';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  decodePlanningEffect,
  readPlanningEffects,
  writePlanningEffect,
} from './effect-store';
const hash = 'a'.repeat(64);
const db = new DatabaseSync(':memory:');
db.exec(
  'CREATE TABLE factory_planning_effects (id TEXT PRIMARY KEY, intent_id TEXT, record TEXT)',
);
afterEach(() => db.exec('DELETE FROM factory_planning_effects'));
it('decodes only exact legacy receipts and writes tagged receipts', () => {
  expect(
    decodePlanningEffect(
      JSON.stringify({ inputHash: hash, result: { version: 2, hash } }),
    ),
  ).toEqual({
    kind: 'proposal',
    inputHash: hash,
    result: { version: 2, hash },
  });
  expect(
    decodePlanningEffect(JSON.stringify({ path: 'src/app.ts', commit: hash })),
  ).toEqual({ kind: 'repo-read', path: 'src/app.ts', commit: hash });
  writePlanningEffect(
    db,
    'read',
    'intent',
    { kind: 'repo-read', path: 'src/app.ts', commit: hash },
    true,
  );
  writePlanningEffect(
    db,
    'read',
    'intent',
    { kind: 'repo-read', path: 'src/app.ts', commit: hash },
    true,
  );
  expect(readPlanningEffects(db, 'intent')).toHaveLength(1);
  expect(() =>
    writePlanningEffect(
      db,
      'read',
      'intent',
      { kind: 'repo-read', path: 'src/other.ts', commit: hash },
      true,
    ),
  ).toThrow(/differs/);
});
it.each([
  {},
  { kind: 'triage-usage' },
  { kind: 'triage-usage', tokens: '100' },
  { kind: 'triage-usage', tokens: -1 },
  { kind: 'triage-usage', tokens: null },
  { kind: 'proposal', inputHash: hash, result: { version: '2', hash } },
  {
    inputHash: hash,
    result: { version: 2, hash },
    path: 'src/app.ts',
    commit: hash,
  },
  { kind: 'unknown', path: 'src/app.ts', commit: hash },
])('rejects corrupt or mixed retained effects %#', (record) => {
  expect(() => decodePlanningEffect(JSON.stringify(record))).toThrow(ValiError);
});
it('rejects nonfinite usage before serialization and does not silently skip corruption', () => {
  for (const tokens of [NaN, Infinity, -Infinity, -1]) {
    expect(() =>
      writePlanningEffect(db, 'usage', 'intent', {
        kind: 'triage-usage',
        tokens,
      }),
    ).toThrow(ValiError);
  }
  expect(readPlanningEffects(db, 'intent')).toEqual([]);
  db.prepare('INSERT INTO factory_planning_effects VALUES (?,?,?)').run(
    'bad',
    'intent',
    '{"kind":"triage-usage","tokens":1e999}',
  );
  expect(() => readPlanningEffects(db, 'intent')).toThrow(ValiError);
});
