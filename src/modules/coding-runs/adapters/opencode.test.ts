import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { manifestSchema } from '../host-contract.ts';
import { opencodeAdapter } from './opencode.ts';
import { createCodingAdapterRegistry } from './registry.ts';

const fixture = () =>
  v.parse(manifestSchema, {
    version: 2,
    executableIdentity: {
      canonical: '/tmp/mock-opencode',
      device: 1,
      inode: 1,
      size: 1,
      modified: 1,
    },
    attemptId: 'fixture',
    cliVersion: 'mock-opencode 1.18.29',
    directory: '/tmp/opencode-attempt',
    nonce: 'a'.repeat(32),
    ownedWorktree: {
      id: 'wt',
      repoId: 'repo',
      root: '/tmp/worktrees/owned',
      storageRoot: '/tmp/worktrees',
      sourceRoot: '/tmp/source',
      branch: 'agent/factory-test',
      baseSha: 'a'.repeat(40),
    },
    config: {
      executable: '/tmp/mock-opencode',
      model: 'openai/fixture-model',
      sandbox: 'workspace-write',
      path: '/usr/bin:/bin',
      wallTimeMs: 5000,
      maxOutputBytes: 65536,
      maxLineBytes: 16384,
      termGraceMs: 50,
      mockScenario: 'success',
      adapter: {
        id: 'opencode',
        contractVersion: 1,
        cliVersion: 'mock-opencode 1.18.29',
      },
    },
  });
const wire = (type: string, part: unknown, sessionID = 'ses_root') =>
  JSON.stringify({ type, timestamp: 1, sessionID, part });
const start = (id = 'prt_start', messageID = 'msg_one') =>
  wire('step_start', {
    id,
    messageID,
    sessionID: 'ses_root',
    type: 'step-start',
  });
const finish = (reason = 'stop', id = 'prt_finish', messageID = 'msg_one') =>
  wire('step_finish', {
    id,
    messageID,
    sessionID: 'ses_root',
    type: 'step-finish',
    reason,
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });

describe('OpenCode adapter contract', () => {
  it.each([
    { field: 'plugin', value: ['unapproved-plugin'] },
    { field: 'enabled_providers', value: ['openai', 'anthropic'] },
    { field: 'enabled_providers', value: ['openai', 'openai'] },
  ])('rejects extra entries in $field configuration', ({ field, value }) => {
    const rule = opencodeAdapter.environmentRules?.find(
      (candidate) => candidate.key === 'OPENCODE_CONFIG_CONTENT',
    );
    if (!rule || rule.kind !== 'json')
      throw new Error('Missing configuration rule');
    const launch = opencodeAdapter.launch(fixture());
    const raw: unknown = JSON.parse(
      launch.env.OPENCODE_CONFIG_CONTENT ?? 'null',
    );
    const configuration = v.parse(v.record(v.string(), v.unknown()), raw);
    expect(v.safeParse(rule.schema, configuration).success).toBe(true);
    expect(
      v.safeParse(rule.schema, { ...configuration, [field]: value }).success,
    ).toBe(false);
  });
  it.each(['opencode', 'anthropic', 'openai'])(
    'binds %s API auth to its pinned provider/model',
    (provider) => {
      const manifest = fixture();
      const config = { ...manifest.config, model: `${provider}/fixture-model` };
      const credentials = opencodeAdapter.credentials(
        { kind: 'api-key', value: 'fixture-key' },
        config,
      );
      expect(credentials.files[0]?.content).toBe(
        JSON.stringify({ [provider]: { type: 'api', key: 'fixture-key' } }),
      );
      expect(
        opencodeAdapter.credentialSecrets(
          credentials.files.map((file) => file.content),
          config,
        ),
      ).toEqual(['fixture-key']);
      const launch = opencodeAdapter.launch({ ...manifest, config });
      const raw: unknown = JSON.parse(
        launch.env.OPENCODE_CONFIG_CONTENT ?? 'null',
      );
      expect(
        v.parse(v.object({ enabled_providers: v.array(v.string()) }), raw)
          .enabled_providers,
      ).toEqual([provider]);
      const other = {
        ...config,
        model:
          provider === 'openai'
            ? 'opencode/fixture-model'
            : 'openai/fixture-model',
      };
      expect(() =>
        opencodeAdapter.credentialSecrets(
          credentials.files.map((file) => file.content),
          other,
        ),
      ).toThrow('selected provider API credential');
      expect(() =>
        opencodeAdapter.credentials(
          { kind: 'auth-json', value: credentials.files[0]!.content },
          other,
        ),
      ).toThrow('selected provider API credential');
    },
  );
  it('registers through the same typed registry and pins a narrow version/model', () => {
    const registry = createCodingAdapterRegistry([opencodeAdapter]);
    expect(registry.get('opencode')).toBe(opencodeAdapter);
    const { config } = fixture();
    expect(
      opencodeAdapter.acceptsVersion('mock-opencode 1.18.29', config),
    ).toBe(true);
    expect(opencodeAdapter.acceptsVersion('1.18.30', config)).toBe(false);
    expect(
      opencodeAdapter.acceptsVersion('mock-opencode 1.18.29', {
        ...config,
        model: 'custom/model',
      }),
    ).toBe(false);
    expect(
      opencodeAdapter.acceptsVersion('mock-opencode 1.18.29', {
        ...config,
        mockScenario: undefined,
      }),
    ).toBe(false);
    expect(
      opencodeAdapter.acceptsVersion('1.18.29', {
        ...config,
        mockScenario: undefined,
      }),
    ).toBe(true);
  });
  it('uses stdin transport, fresh sessions and private configuration without inherited environment', () => {
    const manifest = fixture();
    const launch = opencodeAdapter.launch(manifest);
    expect(launch.args).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'openai/fixture-model',
      '--agent',
      'build',
      '--pure',
    ]);
    expect(launch.env.HOME).toBe('/tmp/opencode-attempt/home');
    expect(launch.env.XDG_DATA_HOME).toBe(
      '/tmp/opencode-attempt/home/.local/share',
    );
    expect(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(launch.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('true');
    expect(launch.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(launch.env.OPENCODE_TEST_MANAGED_CONFIG_DIR).toBe(
      '/tmp/opencode-attempt/home/.config/opencode-managed',
    );
    expect(launch.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(launch.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(
      opencodeAdapter.launch({ ...manifest, directory: '/tmp/next-attempt' })
        .env.HOME,
    ).not.toBe(launch.env.HOME);
    expect(() =>
      opencodeAdapter.launch({ ...manifest, cliVersion: 'unknown' }),
    ).toThrow('Unsupported OpenCode');
  });
  it('does not claim a read-only OS sandbox and denies bash/edit under that permission profile', () => {
    const manifest = fixture();
    const launch = opencodeAdapter.launch({
      ...manifest,
      config: { ...manifest.config, sandbox: 'read-only' },
    });
    const raw: unknown = JSON.parse(launch.env.OPENCODE_PERMISSION ?? 'null');
    const permission = v.parse(v.record(v.string(), v.string()), raw);
    expect(permission['*']).toBe('deny');
    expect(permission.bash).toBeUndefined();
    expect(permission.edit).toBeUndefined();
    expect(opencodeAdapter.capabilities.osSandbox.status).toBe('unsupported');
  });
  it('hands off only the selected API key and exposes its cleanup/redaction path', () => {
    const result = opencodeAdapter.credentials(
      {
        kind: 'api-key',
        value: 'fixture-key',
      },
      fixture().config,
    );
    expect(result.files).toEqual([
      {
        path: 'home/.local/share/opencode/auth.json',
        content: '{"openai":{"type":"api","key":"fixture-key"}}',
      },
    ]);
    expect(opencodeAdapter.credentialPaths).toEqual(
      result.files.map((file) => file.path),
    );
    expect(
      opencodeAdapter.credentialSecrets(
        result.files.map((file) => file.content),
        fixture().config,
      ),
    ).toEqual(['fixture-key']);
    expect(
      opencodeAdapter.credentials(
        {
          kind: 'auth-json',
          value: result.files[0]!.content,
        },
        fixture().config,
      ),
    ).toEqual(result);
  });
  it.each([
    '{}',
    '{"openai":{"type":"oauth","access":"sensitive"}}',
    '{"openai":{"type":"api","key":"key"},"other":{"type":"api","key":"sensitive"}}',
    '{bad',
    'x'.repeat(140000),
  ])(
    'rejects unsupported credentials without disclosing input (%#)',
    (value) => {
      expect(() =>
        opencodeAdapter.credentials(
          { kind: 'auth-json', value },
          fixture().config,
        ),
      ).toThrow(/OpenCode credential|provider API credential/);
    },
  );
  it('requires selected auth instead of inheriting operator state', () => {
    expect(() =>
      opencodeAdapter.credentials(undefined, fixture().config),
    ).toThrow('OpenCode requires');
    expect(() =>
      opencodeAdapter.credentialSecrets(['{}', '{}'], fixture().config),
    ).toThrow('Unexpected OpenCode');
  });
  it.each(['opencode', 'anthropic', 'openai'])(
    'rejects missing or multiple %s credential snapshots',
    (provider) => {
      const config = {
        ...fixture().config,
        model: `${provider}/fixture-model`,
      };
      const content = JSON.stringify({
        [provider]: { type: 'api', key: 'fixture-snapshot-key' },
      });
      expect(() => opencodeAdapter.credentialSecrets([], config)).toThrow(
        'Unexpected OpenCode credential files',
      );
      expect(() =>
        opencodeAdapter.credentialSecrets([content, content], config),
      ).toThrow('Unexpected OpenCode credential files');
      expect(opencodeAdapter.credentialSecrets([content], config)).toEqual([
        'fixture-snapshot-key',
      ]);
    },
  );
  it.each(['', '{malformed', '{}', '{"openai":{"type":"api","key":""}}'])(
    'rejects a malformed single credential snapshot (%#)',
    (content) => {
      expect(() =>
        opencodeAdapter.credentialSecrets([content], fixture().config),
      ).toThrow('OpenCode requires a selected provider API credential');
    },
  );
});

describe('OpenCode bounded run JSONL', () => {
  it('maps root identity and only final stop to completion across tool turns', () => {
    const events = opencodeAdapter.createEvents();
    events.accept(start());
    events.accept(finish('tool-calls'));
    expect(events.terminal).toBeNull();
    events.accept(
      wire('tool_use', {
        id: 'prt_tool',
        sessionID: 'ses_root',
        messageID: 'msg_one',
        type: 'tool',
        tool: 'edit',
        callID: 'call_1',
        state: {
          status: 'error',
          error: 'recoverable',
          time: { start: 1, end: 2 },
        },
      }),
    );
    events.accept(start('prt_second', 'msg_two'));
    events.accept(
      wire('text', {
        id: 'prt_text',
        sessionID: 'ses_root',
        messageID: 'msg_two',
        type: 'text',
        text: 'Done',
        time: { start: 1, end: 2 },
      }),
    );
    events.accept(finish('stop', 'prt_last', 'msg_two'));
    expect(events.sessionId).toBe('ses_root');
    expect(events.terminal).toBe('completed');
  });
  it.each(['length', 'content-filter', 'error', 'unknown'])(
    'fails closed on finish reason %s',
    (reason) => {
      const events = opencodeAdapter.createEvents();
      events.accept(start());
      events.accept(finish(reason));
      expect(events.terminal).toBe('failed');
    },
  );
  it('does not promote unknown events or absent terminal evidence', () => {
    const events = opencodeAdapter.createEvents();
    events.accept(
      JSON.stringify({
        type: 'session.completed',
        timestamp: 1,
        sessionID: 'ses_root',
      }),
    );
    expect(events.sessionId).toBeNull();
    expect(events.terminal).toBeNull();
    events.accept(start());
    expect(events.terminal).toBeNull();
  });
  it('maps session errors even before the first model step', () => {
    const events = opencodeAdapter.createEvents();
    events.accept(
      JSON.stringify({
        type: 'error',
        timestamp: 1,
        sessionID: 'ses_root',
        error: { name: 'APIError' },
      }),
    );
    expect(events.sessionId).toBe('ses_root');
    expect(events.terminal).toBe('failed');
  });
  it.each(
    [
      [finish()],
      [start(), start()],
      [start(), finish(), finish()],
      [start(), finish('tool-calls'), finish()],
      [
        start(),
        wire('step_finish', {
          id: 'part',
          messageID: 'msg_one',
          sessionID: 'ses_foreign',
          type: 'step-finish',
        }),
      ],
      [start(), wire('text', {}, 'ses_foreign')],
      [
        start(),
        wire('step_finish', {
          id: 'part',
          messageID: 'msg_one',
          sessionID: 'ses_root',
          type: 'step-finish',
          reason: 'stop',
        }),
      ],
      ['{"type":'],
      ['x'.repeat(1024 * 1024 + 1)],
      ['['.repeat(33) + ']'.repeat(33)],
    ].map((lines) => ({ lines })),
  )(
    'rejects malformed, foreign, duplicate, truncated or excessive evidence (%#)',
    ({ lines }) => {
      const events = opencodeAdapter.createEvents();
      expect(() => lines.forEach((line) => events.accept(line))).toThrow(
        'Invalid or contradictory',
      );
      expect(events.terminal).toBe('failed');
      expect(() => events.accept(start())).toThrow('Invalid or contradictory');
    },
  );
});
