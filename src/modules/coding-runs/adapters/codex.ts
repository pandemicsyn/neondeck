import * as v from 'valibot';
import {
  codexArguments,
  codexEnvironment,
  CodexEvents,
} from '../codex-adapter.ts';
import type { CodingAdapter } from './contract.ts';
const credential = v.optional(v.nullable(v.string()));
const authSchema = v.object({
  OPENAI_API_KEY: credential,
  tokens: v.optional(
    v.nullable(
      v.object({
        access_token: credential,
        refresh_token: credential,
        id_token: credential,
      }),
    ),
  ),
});
function secrets(contents: readonly string[]) {
  return contents.flatMap((content) => {
    const raw: unknown = JSON.parse(content);
    v.parse(
      v.pipe(
        v.unknown(),
        v.check(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value),
        ),
      ),
      raw,
    );
    const auth = v.parse(authSchema, raw);
    return [
      auth.OPENAI_API_KEY,
      auth.tokens?.access_token,
      auth.tokens?.refresh_token,
      auth.tokens?.id_token,
    ].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
  });
}
export const codexAdapter: CodingAdapter = {
  id: 'codex',
  contractVersion: 1,
  label: 'Codex',
  supportedVersion: 'codex-cli 0.150.1',
  credentialKinds: ['api-key', 'auth-json'],
  versionArgs: ['--version'],
  environmentRules: [
    { key: 'CODEX_HOME', kind: 'private-path', path: 'home/.codex' },
    { key: 'MOCKDEX_SCENARIO', kind: 'test-scenario' },
  ],
  acceptsVersion: (version, config) =>
    version ===
    (config.mockScenario
      ? 'mockdex codex-contract 0.150.1'
      : 'codex-cli 0.150.1'),
  capabilities: {
    privateState: {
      status: 'supported',
      reason: 'Private CODEX_HOME and ignored user configuration.',
    },
    nonInteractive: {
      status: 'supported',
      reason: 'Bounded exec invocation with stdin prompt.',
    },
    cancellation: {
      status: 'supported',
      reason: 'Shared host owns process-group termination.',
    },
    osSandbox: {
      status: 'supported',
      reason:
        'Codex read-only or workspace-write sandbox; host platform capability required.',
    },
    childSessions: {
      status: 'unknown',
      reason: 'Only root thread identity is normalized.',
    },
  },
  launch: (manifest) => ({
    args: codexArguments(manifest),
    env: codexEnvironment(manifest),
  }),
  credentialPaths: ['home/.codex/auth.json'],
  credentials(selected) {
    if (!selected) return { files: [], secrets: [] };
    const content =
      selected.kind === 'api-key'
        ? JSON.stringify({ OPENAI_API_KEY: selected.value })
        : selected.value;
    return {
      files: [{ path: 'home/.codex/auth.json', content }],
      secrets: secrets([content]),
    };
  },
  credentialSecrets: secrets,
  createEvents: () => new CodexEvents(),
};
