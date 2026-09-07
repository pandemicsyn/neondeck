import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  validateAdapterEnvironment,
  validateBoundedAdapterJson,
} from './adapter-environment.ts';
import { codexAdapter } from './adapters/codex.ts';
import type { LocalManifest } from './host-contract.ts';
import { manifestSchema } from './host-contract.ts';
const manifest: LocalManifest = v.parse(manifestSchema, {
  version: 1,
  attemptId: 'a',
  cliVersion: 'codex-cli 0.150.1',
  directory: '/private/tmp/adapter',
  nonce: 'a'.repeat(32),
  ownedWorktree: {
    id: 'w',
    repoId: 'r',
    root: '/private/tmp/work',
    storageRoot: '/private/tmp',
    sourceRoot: '/private/tmp/source',
    branch: 'agent/factory-test',
    baseSha: 'b'.repeat(40),
  },
  config: {
    executable: '/usr/bin/false',
    model: 'fixture',
    sandbox: 'workspace-write',
    path: '/usr/bin:/bin',
    wallTimeMs: 1000,
    maxOutputBytes: 4096,
    maxLineBytes: 1024,
    termGraceMs: 50,
  },
});
describe('declarative environment validation', () => {
  it('accepts bounded literal and schema-backed JSON rules without provider branches', () => {
    const adapter = {
      ...codexAdapter,
      environmentRules: [
        {
          key: 'FIXTURE_CONFIG',
          kind: 'json' as const,
          schema: v.strictObject({ plugins: v.strictTuple([]) }),
        },
        {
          key: 'FIXTURE_DISABLE_PLUGINS',
          kind: 'literal' as const,
          value: 'true',
        },
      ],
    };
    const env = {
      FIXTURE_CONFIG: '{"plugins":[]}',
      FIXTURE_DISABLE_PLUGINS: 'true',
    };
    expect(() =>
      validateAdapterEnvironment(manifest, adapter, {}, env),
    ).not.toThrow();
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        adapter,
        {},
        { ...env, FIXTURE_CONFIG: '{"plugins":["external"]}' },
      ),
    ).toThrow();
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        adapter,
        {},
        { ...env, FIXTURE_DISABLE_PLUGINS: 'false' },
      ),
    ).toThrow();
  });
  it('rejects declared secret keys and base environment overrides', () => {
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        {
          ...codexAdapter,
          environmentRules: [
            { key: 'API_KEY', kind: 'literal', value: 'secret' },
          ],
        },
        {},
        { API_KEY: 'secret' },
      ),
    ).toThrow();
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        {
          ...codexAdapter,
          environmentRules: [
            { key: 'HOME', kind: 'literal', value: '/private/tmp/other' },
          ],
        },
        { HOME: '/private/tmp/adapter/home' },
        { HOME: '/private/tmp/other' },
      ),
    ).toThrow();
  });
  it('rejects missing isolation flags and private path traversal', () => {
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        {
          ...codexAdapter,
          environmentRules: [
            { key: 'ISOLATED', kind: 'literal', value: 'true' },
          ],
        },
        {},
        {},
      ),
    ).toThrow('missing');
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        {
          ...codexAdapter,
          environmentRules: [
            {
              key: 'PROVIDER_HOME',
              kind: 'private-path',
              path: 'home/../operator',
            },
          ],
        },
        {},
        { PROVIDER_HOME: '/private/tmp/adapter/operator' },
      ),
    ).toThrow();
  });
  it('rejects deeply nested and oversized JSON trees', () => {
    let raw: unknown = 'leaf';
    for (let i = 0; i < 34; i++) raw = { nested: raw };
    expect(() => validateBoundedAdapterJson(raw)).toThrow();
    expect(() =>
      validateBoundedAdapterJson(Array.from({ length: 10001 }, () => 0)),
    ).toThrow();
  });
  it('requires an explicit host fixture scenario for test environment', () => {
    expect(() =>
      validateAdapterEnvironment(
        manifest,
        {
          ...codexAdapter,
          environmentRules: [
            { key: 'FIXTURE_SCENARIO', kind: 'test-scenario' },
          ],
        },
        {},
        { FIXTURE_SCENARIO: 'success' },
      ),
    ).toThrow();
  });
});
