import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { factoryCodingConfigSchema } from '../../../shared/factory-coding';
import * as runtimeFiles from '../../runtime-home/files';
import {
  connection,
  fixture,
  issue,
} from '../../modules/factory/testing/github-fixture';
import {
  dbRun,
  getFactoryWork,
  reconcileGitHubSource,
} from '../../modules/factory/service';
import { connectionFingerprint } from '../../modules/factory/github-config';
import { githubDigest } from '../../modules/factory/github-store';
import { codingDigest } from '../../modules/factory/coding-context';
import {
  getWritebackState,
  setWritebackPolicy,
} from '../../modules/factory/writeback-store';
import { createFactoryRoutes } from './factory';
import { createFactoryCodingRoutes } from './factory-coding';

let setup: ReturnType<typeof fixture>;
let app: Hono;
let id: string;
beforeEach(() => {
  setup = fixture();
  id = dbRun(setup.paths, (db) =>
    reconcileGitHubSource(
      db,
      { ...connection, connectionId: connection.id, issue },
      setup.paths,
    ),
  ).work.id;
  setWritebackPolicy(
    connection.id,
    {
      enabled: true,
      expectedEpoch: getWritebackState(id, setup.paths).policy.epoch,
      expectedFingerprint: connectionFingerprint(connection),
    },
    { kind: 'human', id: 'local-operator' },
    setup.paths,
  );
  app = new Hono();
  app.route('/coding', createFactoryCodingRoutes(setup.paths));
  app.route(
    '/factory',
    createFactoryRoutes(setup.paths, () => {}),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  setup.dispose();
});
const coding = v.parse(factoryCodingConfigSchema, {});
const mutations = [
  { path: '/factory/config', body: { enabled: false } },
  {
    path: '/factory/github/config',
    body: {
      expectedFingerprint: githubDigest([connection]),
      connections: [{ ...connection, enabled: false }],
    },
  },
  {
    path: '/coding/config',
    body: {
      expectedFingerprint: codingDigest(coding),
      config: { ...coding, enabled: true },
    },
  },
];
const request = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
it.each(mutations)(
  'returns actionable 409 with ownership, config and authority intact: $path',
  async ({ path, body }) => {
    const before = readFileSync(setup.paths.config, 'utf8');
    const work = getFactoryWork(id, setup.paths);
    const authority = getWritebackState(id, setup.paths);
    const lock = `${realpathSync(setup.paths.config)}.factory-write.lock`;
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(`${lock}/owner`, 'existing writer');
    const ownership = statSync(lock);

    const response = await request(path, body);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.stringContaining(
        'locked by another writer. Retry after it finishes.',
      ),
    });
    expect(statSync(lock).ino).toBe(ownership.ino);
    expect(statSync(lock).mtimeMs).toBe(ownership.mtimeMs);
    expect(readFileSync(`${lock}/owner`, 'utf8')).toBe('existing writer');
    expect(readFileSync(setup.paths.config, 'utf8')).toBe(before);
    expect(getFactoryWork(id, setup.paths)).toEqual(work);
    expect(getWritebackState(id, setup.paths)).toEqual(authority);
  },
);
it.each(mutations)(
  'keeps genuine write failures at 500 even with an arbitrary status: $path',
  async ({ path, body }) => {
    const failure = Object.assign(
      new Error('synthetic private filesystem failure'),
      { status: 409 },
    );
    const write = vi
      .spyOn(runtimeFiles, 'writeJsonAtomicSync')
      .mockImplementation(() => {
        throw failure;
      });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request(path, body);
    expect(write).toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(
      failure.message,
    );
  },
);
