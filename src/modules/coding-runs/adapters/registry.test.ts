import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  createCodingAdapterRegistry,
  getCodingAdapter,
  listCodingAdapters,
} from './registry.ts';
import { codexAdapter } from './codex.ts';
import type { CodingAdapter } from './contract.ts';
import { manifestSchema } from '../host-contract.ts';
import { adapterLaunch, manifestAdapter } from '../adapter-host.ts';
const legacy = () =>
  v.parse(manifestSchema, {
    version: 1,
    attemptId: 'attempt',
    cliVersion: 'codex-cli 0.150.1',
    directory: '/private/tmp/adapter-contract',
    nonce: 'a'.repeat(32),
    ownedWorktree: {
      id: 'w',
      repoId: 'r',
      root: '/private/tmp/repo/work',
      storageRoot: '/private/tmp/repo',
      sourceRoot: '/private/tmp/source',
      branch: 'agent/factory-test',
      baseSha: 'b'.repeat(40),
    },
    config: {
      executable: '/usr/bin/codex',
      model: 'fixture',
      sandbox: 'workspace-write',
      path: '/usr/bin:/bin',
      wallTimeMs: 1000,
      maxOutputBytes: 4096,
      maxLineBytes: 1024,
      termGraceMs: 50,
    },
  });
describe('compiled coding adapter contract', () => {
  it('keeps Codex available and rejects unknown identities', () => {
    expect(listCodingAdapters().map((x) => x.id)).toContain('codex');
    expect(getCodingAdapter('codex')).toBe(codexAdapter);
    expect(() => getCodingAdapter('unregistered')).toThrow();
    expect(() => getCodingAdapter('codex', 2)).toThrow();
  });
  it('registers a typed test implementation without changing production registration', () => {
    const stub: CodingAdapter = {
      ...codexAdapter,
      id: 'opencode',
      label: 'Test adapter',
      launch: () => ({ args: ['test'], env: {} }),
    };
    const testRegistry = createCodingAdapterRegistry([stub]);
    expect(testRegistry.get('opencode').launch(legacy()).args).toEqual([
      'test',
    ]);
    expect(() => testRegistry.get('codex')).toThrow();
    expect(
      listCodingAdapters().some((adapter) => adapter.label === 'Test adapter'),
    ).toBe(false);
    expect(() => createCodingAdapterRegistry([stub, stub])).toThrow();
  });
  it('preserves legacy manifest dispatch and the exact Codex command/environment', () => {
    const manifest = legacy();
    expect(manifestAdapter(manifest)).toBe(codexAdapter);
    expect(adapterLaunch(manifest)).toEqual(codexAdapter.launch(manifest));
    expect(adapterLaunch(manifest).args).toContain('--ignore-user-config');
    expect(adapterLaunch(manifest).env.HOME).toBe(
      '/private/tmp/adapter-contract/home',
    );
  });
  it('rejects a foreign identity in a version-one manifest', () => {
    const manifest = legacy();
    manifest.config.adapter = {
      id: 'opencode',
      contractVersion: 1,
      cliVersion: 'fixture',
    };
    expect(() => manifestAdapter(manifest)).toThrow();
  });
  it('maps Codex terminal events only after a fresh root and rejects contradictions', () => {
    const events = codexAdapter.createEvents();
    expect(() => events.accept('{"type":"turn.completed"}')).toThrow();
    events.accept('{"type":"thread.started","thread_id":"root"}');
    events.accept('{"type":"turn.started"}');
    events.accept('{"type":"turn.completed"}');
    expect(events.sessionId).toBe('root');
    expect(events.terminal).toBe('completed');
    expect(() => events.accept('{"type":"turn.failed"}')).toThrow();
  });
  it('selects credential fields without persisting arbitrary metadata as secrets', () => {
    const handoff = codexAdapter.credentials(
      {
        kind: 'api-key',
        value: 'selected-secret',
      },
      legacy().config,
    );
    expect(handoff.files.map((f) => f.path)).toEqual(['home/.codex/auth.json']);
    expect(
      codexAdapter.credentialSecrets(
        handoff.files.map((f) => f.content),
        legacy().config,
      ),
    ).toEqual(['selected-secret']);
    expect(() =>
      codexAdapter.credentials(
        { kind: 'auth-json', value: '[]' },
        legacy().config,
      ),
    ).toThrow();
  });
});
