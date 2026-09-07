import { join } from 'node:path';
import * as v from 'valibot';
import type { CodingAdapter, LocalConfig } from './contract.ts';
import { OpenCodeEvents } from './opencode-events.ts';

const key = v.pipe(v.string(), v.minLength(1), v.maxLength(16_384));
const providerSchema = v.picklist(['opencode', 'anthropic', 'openai']);
const authSchema = v.pipe(
  v.record(providerSchema, v.strictObject({ type: v.literal('api'), key })),
  v.minEntries(1),
  v.maxEntries(1),
);
const selectedSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('api-key'), value: key }),
  v.strictObject({
    kind: v.literal('auth-json'),
    value: v.pipe(v.string(), v.maxLength(128 * 1024)),
  }),
]);
const authPath = 'home/.local/share/opencode/auth.json';
const modelSchema = v.pipe(
  v.string(),
  v.regex(/^(opencode|anthropic|openai)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/),
);
const permissionSchema = v.strictObject({
  '*': v.literal('deny'),
  read: v.literal('allow'),
  glob: v.literal('allow'),
  grep: v.literal('allow'),
  edit: v.optional(v.literal('allow')),
  bash: v.optional(v.literal('allow')),
  external_directory: v.literal('deny'),
  task: v.literal('deny'),
  question: v.literal('deny'),
});
const configurationSchema = v.strictObject({
  enabled_providers: v.strictTuple([providerSchema]),
  share: v.literal('disabled'),
  autoupdate: v.literal(false),
  plugin: v.strictTuple([]),
  mcp: v.strictObject({}),
  lsp: v.literal(false),
  formatter: v.literal(false),
  permission: permissionSchema,
  agent: v.strictObject({
    build: v.strictObject({ permission: permissionSchema }),
  }),
});

function selectedProvider(config: LocalConfig) {
  if (!v.safeParse(modelSchema, config.model).success)
    throw new Error('Unsupported OpenCode provider/model');
  return v.parse(providerSchema, config.model.split('/')[0]);
}

function parseAuth(content: string, config: LocalConfig) {
  try {
    v.parse(v.pipe(v.string(), v.maxLength(128 * 1024)), content);
    const raw: unknown = JSON.parse(content);
    const auth = v.parse(authSchema, raw);
    const provider = selectedProvider(config);
    const selected = auth[provider];
    if (!selected) throw new Error('Provider mismatch');
    return { auth, key: selected.key };
  } catch {
    throw new Error('OpenCode requires a selected provider API credential');
  }
}

function acceptsVersion(version: string, config: LocalConfig): boolean {
  return (
    v.safeParse(modelSchema, config.model).success &&
    (config.mockScenario
      ? version === 'mock-opencode 1.18.29'
      : version === '1.18.29')
  );
}

export const opencodeAdapter: CodingAdapter = {
  id: 'opencode',
  contractVersion: 1,
  label: 'OpenCode',
  supportedVersion: '1.18.29',
  supportedPlatforms: ['linux'],
  credentialKinds: ['api-key', 'auth-json'],
  versionArgs: ['--version'],
  environmentRules: [
    {
      key: 'OPENCODE_TEST_MANAGED_CONFIG_DIR',
      kind: 'private-path',
      path: 'home/.config/opencode-managed',
    },
    { key: 'OPENCODE_DISABLE_PROJECT_CONFIG', kind: 'literal', value: 'true' },
    { key: 'OPENCODE_DISABLE_EXTERNAL_SKILLS', kind: 'literal', value: 'true' },
    { key: 'OPENCODE_DISABLE_CLAUDE_CODE', kind: 'literal', value: 'true' },
    { key: 'OPENCODE_DISABLE_DEFAULT_PLUGINS', kind: 'literal', value: 'true' },
    { key: 'OPENCODE_DISABLE_MODELS_FETCH', kind: 'literal', value: 'true' },
    { key: 'OPENCODE_DISABLE_LSP_DOWNLOAD', kind: 'literal', value: 'true' },
    { key: 'OPENCODE_DISABLE_AUTOUPDATE', kind: 'literal', value: 'true' },
    {
      key: 'OPENCODE_CONFIG_CONTENT',
      kind: 'json',
      schema: configurationSchema,
    },
    { key: 'OPENCODE_PERMISSION', kind: 'json', schema: permissionSchema },
    { key: 'MOCK_OPENCODE_SCENARIO', kind: 'test-scenario' },
  ],
  acceptsVersion,
  capabilities: {
    privateState: {
      status: 'supported',
      reason:
        'Linux only: private HOME/XDG and redirected managed configuration; project config and external plugins disabled. Darwin managed preferences cannot be isolated.',
    },
    nonInteractive: {
      status: 'supported',
      reason:
        'Pinned run JSONL command reads one stdin prompt; explicit permissions deny interactive questions.',
    },
    cancellation: {
      status: 'supported',
      reason:
        'Shared host owns deadlines, process-group termination and death proof.',
    },
    osSandbox: {
      status: 'unsupported',
      reason: 'OpenCode tool permissions are not an OS sandbox.',
    },
    childSessions: {
      status: 'unsupported',
      reason:
        'run JSONL exposes root parts only; child-session delegation is disabled.',
    },
  },
  launch(manifest) {
    if (!acceptsVersion(manifest.cliVersion, manifest.config))
      throw new Error('Unsupported OpenCode version, platform or model');
    const home = join(manifest.directory, 'home');
    const scratch = join(manifest.directory, 'scratch');
    const permissions = {
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      ...(manifest.config.sandbox === 'workspace-write'
        ? { edit: 'allow', bash: 'allow' }
        : {}),
      external_directory: 'deny',
      task: 'deny',
      question: 'deny',
    };
    return {
      args: [
        'run',
        '--format',
        'json',
        '--model',
        manifest.config.model,
        '--agent',
        'build',
        '--pure',
      ],
      env: {
        PATH: manifest.config.path,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        XDG_CACHE_HOME: join(home, '.cache'),
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        OPENCODE_TEST_MANAGED_CONFIG_DIR: join(
          home,
          '.config',
          'opencode-managed',
        ),
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          enabled_providers: [selectedProvider(manifest.config)],
          share: 'disabled',
          autoupdate: false,
          plugin: [],
          mcp: {},
          lsp: false,
          formatter: false,
          permission: permissions,
          agent: { build: { permission: permissions } },
        }),
        OPENCODE_PERMISSION: JSON.stringify(permissions),
        ...(manifest.config.mockScenario
          ? { MOCK_OPENCODE_SCENARIO: manifest.config.mockScenario }
          : {}),
      },
    };
  },
  credentialPaths: [authPath],
  credentials(input, config) {
    if (!input)
      throw new Error('OpenCode requires a selected provider API credential');
    // Keep validation failures from reflecting credential input to callers.
    const result = v.safeParse(selectedSchema, input);
    if (!result.success)
      throw new Error('Invalid selected OpenCode credential');
    const selected = result.output;
    const auth =
      selected.kind === 'api-key'
        ? parseAuth(
            JSON.stringify({
              [selectedProvider(config)]: { type: 'api', key: selected.value },
            }),
            config,
          )
        : parseAuth(selected.value, config);
    return {
      files: [{ path: authPath, content: JSON.stringify(auth.auth) }],
      secrets: [auth.key],
    };
  },
  credentialSecrets(contents, config) {
    if (contents.length > 1)
      throw new Error('Unexpected OpenCode credential files');
    return contents.map((content) => parseAuth(content, config).key);
  },
  createEvents: () => new OpenCodeEvents(),
};
