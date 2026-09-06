import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { reserveCodingRun } from './store';
import {
  getActiveCodingRun,
  getCodingRunForRelease,
  latestCodingRunForWorkItem,
} from './queries';

it('reads real records through indexed helpers under a database path longer than 500 characters', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'coding-long-path-')));
  try {
    // Stay below SQLite's platform path limit while exceeding the ID limit.
    const prefix = join(
      home,
      ...Array.from({ length: 3 }, (_, i) => `${i}-${'x'.repeat(90)}`),
    );
    const directory = join(
      prefix,
      'y'.repeat(501 - prefix.length - '/app.db'.length - 1),
    );
    mkdirSync(directory, { recursive: true });
    const paths = { neondeckDatabase: join(directory, 'app.db') };
    expect(paths.neondeckDatabase.length).toBeGreaterThan(500);
    initializeAppDatabase(paths.neondeckDatabase);
    const run = reserveCodingRun(
      {
        requestId: 'request',
        workItemId: 'work',
        releaseId: 'release',
        specVersion: 1,
        specHash: 'a'.repeat(64),
        specSnapshot: '{}',
        sourceId: 'source',
        sourceSnapshot: '{}',
        repoId: 'repo',
        repoSnapshot: '{}',
        policySnapshot: '{}',
        contextSnapshot: '{}',
        baseSha: 'b'.repeat(40),
        harness: { provider: 'test', version: '1', model: 'test' },
        sessionMode: 'fresh',
      },
      paths,
    );
    expect(getActiveCodingRun(paths)).toEqual(run);
    expect(getCodingRunForRelease('release', paths)).toEqual(run);
    expect(latestCodingRunForWorkItem('work', paths)).toEqual(run);
    expect(getCodingRunForRelease('absent', paths)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
