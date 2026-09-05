import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as runtimeFiles from '../../runtime-home/files';
import { updateFactoryConfig } from '../config';
import { connection, fixture, issue } from './testing/github-fixture';
import { dbRun, getFactoryWork, reconcileGitHubSource } from './service';
import { getWritebackState, setWritebackPolicy } from './writeback-store';
import { connectionFingerprint } from './github-config';

let setup: ReturnType<typeof fixture>;
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
});
afterEach(() => {
  vi.restoreAllMocks();
  setup.dispose();
});

it('revokes before file replacement and retains revocation when replacement fails', () => {
  const configBefore = readFileSync(setup.paths.config, 'utf8');
  const versionBefore = getFactoryWork(id, setup.paths).source.version;
  vi.spyOn(runtimeFiles, 'writeJsonAtomicSync').mockImplementation(() => {
    expect(getWritebackState(id, setup.paths).policy.enabled).toBe(false);
    expect(getFactoryWork(id, setup.paths).source.version).toBeGreaterThan(
      versionBefore,
    );
    expect(readFileSync(setup.paths.config, 'utf8')).toBe(configBefore);
    throw new Error('synthetic replacement failure');
  });
  expect(() =>
    updateFactoryConfig(
      { github: [{ ...connection, enabled: false }] },
      setup.paths,
    ),
  ).toThrow('synthetic replacement failure');
  expect(readFileSync(setup.paths.config, 'utf8')).toBe(configBefore);
  expect(getWritebackState(id, setup.paths).policy.enabled).toBe(false);
});

it('leaves source and consent intact for an identical config', () => {
  // Normalize the sparse fixture before enabling consent against the canonical config.
  updateFactoryConfig({}, setup.paths);
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
  const before = getWritebackState(id, setup.paths).policy;
  const source = getFactoryWork(id, setup.paths).source;
  updateFactoryConfig({}, setup.paths);
  expect(getWritebackState(id, setup.paths).policy).toEqual(before);
  expect(getFactoryWork(id, setup.paths).source).toEqual(source);
});
