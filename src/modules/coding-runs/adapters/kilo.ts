import { join } from 'node:path';
import * as v from 'valibot';
import { manifestSchema } from '../host-contract.ts';
import type { CodingAdapter } from './contract.ts';
import { KiloEvents } from './kilo-events.ts';
import { kiloModelSchema as modelSchema } from './kilo-model.ts';
import {
  kiloCredentialPath,
  kiloCredentials,
  kiloCredentialSecrets,
} from './kilo-auth.ts';

const kiloFlags = {
  KILO_NO_DAEMON: '1',
  KILO_DISABLE_PROJECT_CONFIG: '1',
  KILO_DISABLE_DEFAULT_PLUGINS: '1',
  KILO_DISABLE_CLAUDE_CODE: '1',
  KILO_DISABLE_EXTERNAL_SKILLS: '1',
  KILO_DISABLE_AUTOUPDATE: '1',
  KILO_DISABLE_MODELS_FETCH: '1',
  KILO_DISABLE_LSP_DOWNLOAD: '1',
  KILO_TELEMETRY_LEVEL: 'off',
} as const;
const configContentSchema = v.strictObject({
  model: modelSchema,
  enabled_providers: v.strictTuple([v.literal('kilo')]),
  share: v.literal('disabled'),
  autoupdate: v.literal(false),
  snapshot: v.literal(false),
  plugin: v.strictTuple([]),
  mcp: v.strictObject({}),
  lsp: v.literal(false),
  formatter: v.literal(false),
  permission: v.union([
    v.strictObject({
      '*': v.literal('deny'),
      read: v.literal('allow'),
      glob: v.literal('allow'),
      grep: v.literal('allow'),
      list: v.literal('allow'),
    }),
    v.strictObject({
      '*': v.literal('allow'),
      question: v.literal('deny'),
      suggest: v.literal('deny'),
      interactive_terminal: v.literal('deny'),
      plan_enter: v.literal('deny'),
      plan_exit: v.literal('deny'),
    }),
  ]),
});

// Every legacy project source in the tagged 7.4.23 migrators. The host rejects
// presence (including dangling links); the adapter never deletes project data.
export const kiloForbiddenWorkspacePaths = [
  '.kilo/mcp.json',
  '.kilocode/mcp.json',
  '.kilo/workflows',
  '.kilocode/workflows',
  '.kilo/rules',
  '.kilocode/rules',
  '.kilo/rules-code',
  '.kilocode/rules-code',
  '.kilo/rules-architect',
  '.kilocode/rules-architect',
  '.kilo/rules-ask',
  '.kilocode/rules-ask',
  '.kilo/rules-debug',
  '.kilocode/rules-debug',
  '.kilo/rules-orchestrator',
  '.kilocode/rules-orchestrator',
  '.kilocodemodes',
  '.kilocodeignore',
  '.kilocoderules',
  '.kilocoderules-code',
  '.kilocoderules-architect',
  '.kilocoderules-ask',
  '.kilocoderules-debug',
  '.kilocoderules-orchestrator',
] as const;

export const kiloAdapter: CodingAdapter = {
  id: 'kilo',
  contractVersion: 1,
  label: 'Kilo Code',
  supportedVersion: '7.4.23',
  supportedPlatforms: ['linux'],
  forbiddenWorkspacePaths: kiloForbiddenWorkspacePaths,
  credentialKinds: ['api-key', 'auth-json'],
  versionArgs: ['--version'],
  environmentRules: [
    ...Object.entries(kiloFlags).map(([key, value]) => ({
      key,
      kind: 'literal' as const,
      value,
    })),
    {
      key: 'KILO_TEST_MANAGED_CONFIG_DIR',
      kind: 'private-path',
      path: 'home/.config/factory-managed',
    },
    { key: 'KILO_CONFIG_CONTENT', kind: 'json', schema: configContentSchema },
    { key: 'MOCK_KILO_FACTORY_SCENARIO', kind: 'test-scenario' },
  ],
  acceptsVersion(version, config) {
    return (
      version ===
        (config.mockScenario ? 'mock-kilo-factory 7.4.23' : '7.4.23') &&
      v.is(modelSchema, config.model)
    );
  },
  capabilities: {
    privateState: {
      status: 'supported',
      reason:
        'Linux only: private HOME/XDG, managed-config override, disabled project config and host rejection of legacy Kilo config paths.',
    },
    nonInteractive: {
      status: 'supported',
      reason:
        'Pinned run --format json --auto --pure, stdin prompt; interactive questions denied. Kilo Gateway API key only.',
    },
    cancellation: {
      status: 'supported',
      reason:
        'Daemon attachment disabled; shared host owns bounded process group and actual death proof.',
    },
    osSandbox: {
      status: 'unsupported',
      reason:
        'Kilo permissions are application policy. This adapter provides no OS filesystem sandbox.',
    },
    childSessions: {
      status: 'unknown',
      reason:
        'Only root sessionID is normalized from Kilo run JSONL; no global session discovery or child provenance claim.',
    },
  },
  launch(input) {
    const manifest = v.parse(manifestSchema, input);
    if (
      manifest.config.adapter?.id !== 'kilo' ||
      manifest.config.adapter.cliVersion !== manifest.cliVersion ||
      !kiloAdapter.acceptsVersion(manifest.cliVersion, manifest.config)
    )
      throw new Error('Unsupported Kilo launch identity or model');
    const home = join(manifest.directory, 'home');
    const scratch = join(manifest.directory, 'scratch');
    const permission =
      manifest.config.sandbox === 'read-only'
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
        '--auto',
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
        ...kiloFlags,
        KILO_TEST_MANAGED_CONFIG_DIR: join(home, '.config', 'factory-managed'),
        KILO_CONFIG_CONTENT: JSON.stringify({
          model: manifest.config.model,
          enabled_providers: ['kilo'],
          share: 'disabled',
          autoupdate: false,
          snapshot: false,
          plugin: [],
          mcp: {},
          lsp: false,
          formatter: false,
          permission,
        }),
        ...(manifest.config.mockScenario
          ? { MOCK_KILO_FACTORY_SCENARIO: manifest.config.mockScenario }
          : {}),
      },
    };
  },
  credentialPaths: [kiloCredentialPath],
  credentials: kiloCredentials,
  credentialSecrets: kiloCredentialSecrets,
  createEvents: () => new KiloEvents(),
};
