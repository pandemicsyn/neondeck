import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { kiloAdapter, kiloForbiddenWorkspacePaths } from './kilo.ts';
import { KiloEvents } from './kilo-events.ts';
import { manifestSchema } from '../host-contract.ts';
import {
  adapterCredentialRedactor,
  adapterLaunch,
  prepareAdapterCredentials,
  verifyAdapterWorkspace,
} from '../adapter-host.ts';
import * as registry from './registry.ts';

function manifest(root = '/tmp/kilo-fixture/work') {
  return v.parse(manifestSchema, {
    version: 2,
    attemptId: 'attempt',
    cliVersion: '7.4.23',
    executableIdentity: {
      canonical: '/tmp/kilo-fixture/kilo',
      device: 1,
      inode: 1,
      size: 1,
      modified: 1,
    },
    directory: '/tmp/kilo-fixture/attempt',
    nonce: 'a'.repeat(32),
    ownedWorktree: {
      id: 'work',
      repoId: 'repo',
      root,
      storageRoot: '/tmp/kilo-fixture',
      sourceRoot: '/tmp/kilo-fixture/source',
      branch: 'agent/factory-kilo',
      baseSha: 'b'.repeat(40),
    },
    config: {
      adapter: { id: 'kilo', contractVersion: 1, cliVersion: '7.4.23' },
      executable: '/tmp/kilo-fixture/kilo',
      model: 'kilo/example/model',
      sandbox: 'workspace-write',
      path: '/usr/bin:/bin',
      wallTimeMs: 1000,
      maxOutputBytes: 4096,
      maxLineBytes: 1024,
      termGraceMs: 100,
    },
  });
}
const rootSession = 'ses_fixture_kilo';
function event(type: string, part: object, sessionID = rootSession) {
  return JSON.stringify({ type, sessionID, timestamp: 1, part });
}
function part(type: string, id: string, extra: object = {}) {
  return { type, id, sessionID: rootSession, messageID: 'msg_one', ...extra };
}
function stepStart(messageID = 'msg_one', id = 'prt_start') {
  return event('step_start', part('step-start', id, { messageID }));
}
function stepFinish(reason = 'stop', messageID = 'msg_one', id = 'prt_finish') {
  return event(
    'step_finish',
    part('step-finish', id, {
      messageID,
      reason,
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
}

describe('Kilo 7.4.23 adapter contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers through the same typed seam and pins real versus synthetic versions', () => {
    const entry = registry
      .createCodingAdapterRegistry([kiloAdapter])
      .get('kilo');
    const config = manifest().config;
    expect(entry.acceptsVersion('7.4.23', config)).toBe(true);
    for (const version of [
      '7.1.20',
      '7.5.15',
      '7.4.23\n',
      'mock-kilo-factory 7.4.23',
    ])
      expect(entry.acceptsVersion(version, config)).toBe(false);
    expect(
      entry.acceptsVersion('mock-kilo-factory 7.4.23', {
        ...config,
        mockScenario: 'success',
      }),
    ).toBe(true);
    expect(entry.supportedPlatforms).toEqual(['linux']);
    expect(entry.capabilities.osSandbox.status).toBe('unsupported');
    expect(entry.capabilities.childSessions.status).toBe('unknown');
  });

  it('builds a fresh stdin invocation and private environment without inherited keys', () => {
    vi.stubEnv('GITHUB_TOKEN', 'not-selected');
    vi.stubEnv('KILO_AUTH_CONTENT', 'not-selected');
    try {
      const first = kiloAdapter.launch(manifest());
      const next = manifest();
      next.directory += '-repair';
      expect(first.args).toEqual([
        'run',
        '--format',
        'json',
        '--model',
        'kilo/example/model',
        '--agent',
        'build',
        '--auto',
        '--pure',
      ]);
      expect(first.env.HOME).not.toBe(kiloAdapter.launch(next).env.HOME);
      expect(first.env.GITHUB_TOKEN).toBeUndefined();
      expect(first.env.KILO_AUTH_CONTENT).toBeUndefined();
      expect(first.env.KILO_NO_DAEMON).toBe('1');
      expect(first.env.KILO_TEST_MANAGED_CONFIG_DIR).toBe(
        '/tmp/kilo-fixture/attempt/home/.config/factory-managed',
      );
      const config: unknown = JSON.parse(first.env.KILO_CONFIG_CONTENT);
      expect(config).toMatchObject({
        share: 'disabled',
        snapshot: false,
        mcp: {},
        plugin: [],
        enabled_providers: ['kilo'],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects mismatched launch identity and unselected model providers', () => {
    const value = manifest();
    value.cliVersion = '7.5.15';
    expect(() => kiloAdapter.launch(value)).toThrow(
      'Inconsistent versioned adapter manifest',
    );
    const wrong = manifest();
    wrong.config.model = 'openai/model';
    expect(() => kiloAdapter.launch(wrong)).toThrow(
      'Unsupported Kilo launch identity or model',
    );
    const legacy = manifest();
    delete legacy.config.adapter;
    expect(() => kiloAdapter.launch(legacy)).toThrow(
      'Inconsistent versioned adapter manifest',
    );
  });

  it('passes declarative environment enforcement and rejects undeclared or relaxed settings', () => {
    const selected = vi
      .spyOn(registry, 'getCodingAdapter')
      .mockReturnValue(kiloAdapter);
    const value = manifest();
    expect(adapterLaunch(value)).toEqual(kiloAdapter.launch(value));
    const extras: Record<string, string>[] = [
      { KILO_NO_DAEMON: '0' },
      { KILO_AUTH_CONTENT: 'unselected' },
      { KILO_CONFIG_CONTENT: '{"mcp":{"untrusted":{}}}' },
    ];
    for (const extra of extras) {
      const descriptor = kiloAdapter.launch(value);
      selected.mockReturnValue({
        ...kiloAdapter,
        launch: () => ({ ...descriptor, env: { ...descriptor.env, ...extra } }),
      });
      expect(() => adapterLaunch(value)).toThrowError(/adapter|Adapter/);
    }
  });

  it.each([
    ['"plugin":[]', '"plugin":["untrusted-plugin"]'],
    ['".kilo/skills"', '"/outside/skills"'],
    ['".kilo/skills"', '"../skills"'],
    ['"enabled_providers":["kilo"]', '"enabled_providers":["kilo","openai"]'],
  ])('rejects additional configuration entries in %s', (original, injected) => {
    const value = manifest();
    value.config.repositorySkills = 'native-v1';
    const descriptor = kiloAdapter.launch(value);
    expect(descriptor.env.KILO_CONFIG_CONTENT).toContain(original);
    vi.spyOn(registry, 'getCodingAdapter').mockReturnValue({
      ...kiloAdapter,
      launch: () => ({
        ...descriptor,
        env: {
          ...descriptor.env,
          KILO_CONFIG_CONTENT: descriptor.env.KILO_CONFIG_CONTENT.replace(
            original,
            injected,
          ),
        },
      }),
    });
    expect(() => adapterLaunch(value)).toThrowError(/adapter|Adapter|Invalid/);
  });

  it('selects only one bounded Gateway key and rejects ambient-account configuration', () => {
    const config = manifest().config;
    const selected = kiloAdapter.credentials(
      {
        kind: 'api-key',
        value: 'synthetic-key',
      },
      config,
    );
    expect(selected.files).toEqual([
      {
        path: 'home/.local/share/kilo/auth.json',
        content: '{"kilo":{"type":"api","key":"synthetic-key"}}',
      },
    ]);
    expect(
      kiloAdapter.credentialSecrets(
        selected.files.map((file) => file.content),
        config,
      ),
    ).toEqual(['synthetic-key']);
    for (const value of [
      '{}',
      '[]',
      '{"kilo":{"type":"oauth","access":"fixture"}}',
      '{"kilo":{"type":"api","key":"fixture","metadata":{}}}',
      '{"kilo":{"type":"api","key":"fixture"},"other":{"type":"api","key":"fixture"}}',
    ])
      expect(() =>
        kiloAdapter.credentials({ kind: 'auth-json', value }, config),
      ).toThrow('Invalid selected Kilo credentials');
    expect(() => kiloAdapter.credentials(undefined, config)).toThrow(
      'Kilo Gateway API key is required',
    );
    expect(() =>
      kiloAdapter.credentials(
        { kind: 'api-key', value: 'a'.repeat(16385) },
        config,
      ),
    ).toThrow('Invalid selected Kilo credentials');
    expect(() =>
      kiloAdapter.credentials(
        { kind: 'api-key', value: 'fixture' },
        { ...config, model: 'openai/model' },
      ),
    ).toThrow('Unsupported Kilo credential provider');
  });

  it('requires exactly one valid credential snapshot for redaction', () => {
    const config = manifest().config;
    const valid = '{"kilo":{"type":"api","key":"synthetic-key"}}';
    expect(kiloAdapter.credentialSecrets([valid], config)).toEqual([
      'synthetic-key',
    ]);
    for (const contents of [[], [valid, valid]]) {
      expect(() => kiloAdapter.credentialSecrets(contents, config)).toThrow(
        'Expected one Kilo credential file',
      );
    }
    for (const invalid of ['', '{', '{}', '{"kilo":{"type":"api","key":""}}']) {
      expect(() => kiloAdapter.credentialSecrets([invalid], config)).toThrow(
        'Invalid selected Kilo credentials',
      );
    }
  });

  it('rejects a prepared auth snapshot deleted before supervisor redactor preflight', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'kilo-auth-')),
    );
    const value = manifest();
    value.directory = directory;
    try {
      await prepareAdapterCredentials(value, {
        kind: 'api-key',
        value: 'synthetic-key',
      });
      const redact = await adapterCredentialRedactor(value);
      expect(redact('key=synthetic-key')).toBe('key=[REDACTED]');
      const authPath = join(directory, 'home/.local/share/kilo/auth.json');
      await rm(authPath);
      await expect(adapterCredentialRedactor(value)).rejects.toThrow(
        'Invalid selected credential snapshot',
      );
      await writeFile(authPath, '{malformed', { mode: 0o600 });
      await expect(adapterCredentialRedactor(value)).rejects.toThrow(
        'Invalid selected credential snapshot',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts intermediate tool turns only before an ordered final stop', () => {
    const stream = new KiloEvents();
    stream.accept(stepStart());
    stream.accept(
      event(
        'tool_use',
        part('tool', 'prt_tool', {
          callID: 'call_one',
          tool: 'bash',
          state: { status: 'completed' },
        }),
      ),
    );
    stream.accept(stepFinish('tool-calls'));
    expect(stream.terminal).toBeNull();
    stream.accept(stepStart('msg_two', 'prt_start_two'));
    stream.accept(stepFinish('stop', 'msg_two', 'prt_finish_two'));
    expect(stream.sessionId).toBe(rootSession);
    expect(stream.terminal).toBe('completed');
  });

  it.each(['completed', 'error'])(
    'accepts a %s tool settlement after intermediate finish',
    (status) => {
      const stream = new KiloEvents();
      stream.accept(stepStart());
      stream.accept(stepFinish('tool-calls'));
      stream.accept(
        event(
          'tool_use',
          part('tool', 'prt_late_tool', {
            callID: 'call_late',
            tool: 'bash',
            state: { status },
          }),
        ),
      );
      expect(stream.terminal).toBeNull();
      stream.accept(stepStart('msg_two', 'prt_start_two'));
      stream.accept(stepFinish('stop', 'msg_two', 'prt_finish_two'));
      expect(stream.terminal).toBe('completed');
    },
  );

  it.each(['foreign', 'text', 'next-step', 'terminal', 'duplicate'])(
    'rejects %s late tool provenance or ordering',
    (mode) => {
      const stream = new KiloEvents();
      stream.accept(stepStart());
      stream.accept(stepFinish(mode === 'terminal' ? 'stop' : 'tool-calls'));
      const late = event(
        'tool_use',
        part('tool', 'prt_late_tool', {
          callID: 'call_late',
          tool: 'bash',
          state: { status: 'completed' },
          ...(mode === 'foreign' ? { messageID: 'msg_foreign' } : {}),
        }),
      );
      if (mode === 'next-step')
        stream.accept(stepStart('msg_two', 'prt_start_two'));
      if (mode === 'duplicate') stream.accept(late);
      expect(() =>
        stream.accept(
          mode === 'text'
            ? event(
                'text',
                part('text', 'prt_late_text', { text: 'late text' }),
              )
            : late,
        ),
      ).toThrow('Invalid Kilo event stream');
      expect(stream.terminal).toBeNull();
    },
  );

  it.each(['length', 'content-filter', 'error', 'other', 'unknown'])(
    'fails closed on %s finish reason',
    (reason) => {
      const stream = new KiloEvents();
      stream.accept(stepStart());
      stream.accept(stepFinish(reason));
      expect(stream.terminal).toBe('failed');
    },
  );

  it('never treats unknown events or an intermediate step as success', () => {
    const stream = new KiloEvents();
    stream.accept(
      JSON.stringify({
        type: 'session.completed',
        sessionID: rootSession,
        timestamp: 1,
      }),
    );
    expect(stream.sessionId).toBeNull();
    expect(stream.terminal).toBeNull();
    stream.accept(stepStart());
    stream.accept(stepFinish('tool-calls'));
    expect(stream.terminal).toBeNull();
  });

  it.each([
    [stepFinish()],
    [stepStart(), stepStart()],
    [stepStart(), stepFinish(), stepFinish()],
    [
      stepStart(),
      stepFinish(),
      JSON.stringify({
        type: 'error',
        timestamp: 1,
        sessionID: rootSession,
        error: 'contradiction',
      }),
    ],
    [
      stepStart(),
      event(
        'text',
        part('text', 'prt_foreign', { text: 'foreign' }),
        'ses_foreign',
      ),
    ],
    [
      stepStart(),
      event(
        'text',
        part('text', 'prt_foreign', {
          text: 'foreign',
          sessionID: 'ses_foreign',
        }),
      ),
    ],
    [stepStart(), stepFinish('unverified-reason')],
    [stepStart(), '{"type":'],
    [stepStart(), 'x'.repeat(1024 * 1024 + 1)],
    [stepStart(), '['.repeat(33) + '0' + ']'.repeat(33)],
  ])(
    'rejects malformed, foreign, unordered or contradictory event sequence %#',
    (...lines) => {
      const stream = new KiloEvents();
      expect(() => {
        for (const line of lines) stream.accept(line);
      }).toThrow('Invalid Kilo event stream');
      expect(stream.terminal).toBeNull();
      expect(() => stream.accept(stepFinish())).toThrow('already invalid');
    },
  );

  it('bounds event count and aggregate bytes', () => {
    const stream = new KiloEvents();
    const informational = JSON.stringify({
      type: 'info',
      timestamp: 1,
      sessionID: rootSession,
    });
    for (let n = 0; n < 10_000; n++) stream.accept(informational);
    expect(() => stream.accept(informational)).toThrow(
      'Invalid Kilo event stream',
    );
    const large = new KiloEvents();
    const line = JSON.stringify({
      type: 'info',
      timestamp: 1,
      sessionID: rootSession,
      text: 'a'.repeat(900_000),
    });
    expect(() => {
      for (let n = 0; n < 20; n++) large.accept(line);
    }).toThrow('Invalid Kilo event stream');
  });

  it.each(kiloForbiddenWorkspacePaths)(
    'host rejects legacy source %s including dangling links',
    async (path) => {
      vi.spyOn(registry, 'getCodingAdapter').mockReturnValue(kiloAdapter);
      const root = await mkdtemp(join(tmpdir(), 'kilo-guard-'));
      try {
        const target = join(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'synthetic');
        expect(() => verifyAdapterWorkspace(manifest(root))).toThrow(
          'unsupported provider configuration',
        );
        await rm(target);
        await symlink(join(root, 'missing'), target);
        expect(() => verifyAdapterWorkspace(manifest(root))).toThrow(
          'unsupported provider configuration',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('host permits benign .kilo skills, while an unreadable path fails closed', async () => {
    vi.spyOn(registry, 'getCodingAdapter').mockReturnValue(kiloAdapter);
    const root = await mkdtemp(join(tmpdir(), 'kilo-guard-'));
    try {
      await mkdir(join(root, '.kilo/skills/flue'), { recursive: true });
      await writeFile(
        join(root, '.kilo/skills/flue/SKILL.md'),
        'synthetic skill',
      );
      expect(() => verifyAdapterWorkspace(manifest(root))).not.toThrow();
      await rm(join(root, '.kilo'), { recursive: true });
      await writeFile(join(root, '.kilo'), 'not a directory');
      expect(() => verifyAdapterWorkspace(manifest(root))).toThrow(
        'isolation could not be verified',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('enables only native skill roots while retaining project and external config gates', () => {
  const input = manifest();
  input.config.sandbox = 'read-only';
  input.config.repositorySkills = 'native-v1';
  const descriptor = adapterLaunch(input);
  const config = JSON.parse(descriptor.env.KILO_CONFIG_CONTENT);
  expect(config.skills.paths).toEqual([
    '.kilo/skills',
    '.kilo/skill',
    '.kilocode/skills',
    '.kilocode/skill',
    '.agents/skills',
    '.claude/skills',
  ]);
  expect(config.permission).toMatchObject({ '*': 'deny', skill: 'allow' });
  expect(descriptor.env.KILO_DISABLE_PROJECT_CONFIG).toBe('1');
  expect(descriptor.env.KILO_DISABLE_EXTERNAL_SKILLS).toBe('1');
  expect(descriptor.env.KILO_DISABLE_DEFAULT_PLUGINS).toBe('1');
  expect(descriptor.args).toContain('--pure');
});

it.each(['read-only', 'workspace-write'] as const)(
  'preserves unmarked historical Kilo %s manifests and repair descriptors',
  (sandbox) => {
    const historical = manifest();
    historical.config.sandbox = sandbox;
    const saved = v.parse(
      manifestSchema,
      JSON.parse(JSON.stringify(historical)),
    );
    expect(saved.config).not.toHaveProperty('repositorySkills');
    const repair = v.parse(manifestSchema, {
      ...saved,
      directory: `${saved.directory}-repair`,
    });
    const expected = {
      model: saved.config.model,
      enabled_providers: ['kilo'],
      share: 'disabled',
      autoupdate: false,
      snapshot: false,
      plugin: [],
      mcp: {},
      lsp: false,
      formatter: false,
      permission:
        sandbox === 'read-only'
          ? {
              '*': 'deny',
              read: 'allow',
              glob: 'allow',
              grep: 'allow',
              list: 'allow',
            }
          : {
              '*': 'allow',
              question: 'deny',
              suggest: 'deny',
              interactive_terminal: 'deny',
              plan_enter: 'deny',
              plan_exit: 'deny',
            },
    };
    for (const input of [saved, repair]) {
      expect(adapterLaunch(input).env.KILO_CONFIG_CONTENT).toBe(
        JSON.stringify(expected),
      );
    }
  },
);
