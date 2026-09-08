import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import {
  readValidationAttention,
  saveValidationAttention,
  clearValidationAttention,
} from './validation-attention';
import { openDb } from '../../lib/sqlite';
it('retains public-safe validation attention across reads without mutating terminal coding records', () => {
  const home = mkdtempSync('/private/tmp/validation-attention-');
  const paths = runtimePaths(home);
  try {
    mkdirSync(join(home, 'data'));
    initializeAppDatabase(paths.neondeckDatabase);
    const attention = {
      blocker: 'candidate-unavailable',
      message: 'Reconcile retained evidence and retry validation.',
      observedAt: new Date().toISOString(),
      nextAction: 'retry-validation',
      reasonCode: 'unexpected-admission-failure',
      diagnosticReference: '12345678-1234-4234-8234-123456789012',
      stage: 'preview',
      recovery:
        'Report this run and its stored diagnostic reference for investigation.',
    };
    saveValidationAttention('run', attention, paths);
    expect(readValidationAttention('run', paths)).toEqual(attention);
    expect(readValidationAttention('other', paths)).toBeNull();
    const db = openDb(paths.neondeckDatabase);
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM coding_runs').get()?.n).toBe(
        0,
      );
    } finally {
      db.close();
    }
    expect(() =>
      saveValidationAttention(
        'run',
        { ...attention, blocker: 'arbitrary-error' },
        paths,
      ),
    ).toThrow();
    expect(readValidationAttention('run', paths)).toEqual(attention);
    clearValidationAttention('run', paths);
    expect(readValidationAttention('run', paths)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
