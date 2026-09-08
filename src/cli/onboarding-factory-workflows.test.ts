import { log, note } from '@clack/prompts';
import { readLocalApiToken } from '../modules/runtime';
import { requestFactoryWorkflowProposal } from './onboarding-factory-workflow-proposal';
vi.mock('../modules/runtime', () => ({
  readLocalApiToken: vi.fn(),
  localApiAuthHeader: 'x-neondeck-api-token',
}));
vi.mock('./options', () => ({ loadEnvForPaths: vi.fn() }));
vi.mock('./onboarding-factory-workflow-trial', () => ({
  runFactoryWorkflowTrial: vi.fn(),
}));
import * as v from 'valibot';
import { saveRepoWorkflowsInputSchema } from '../../shared/repo-workflows';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureFactoryWorkflows } from './onboarding-factory-workflows';
import { promptConfirm, promptSelect, promptText } from './prompts';
import {
  readRepoWorkflows,
  saveRepoWorkflows,
  proposeRepoWorkflows,
} from '../modules/repo-workflows';
import { readRuntimeJsonSync, runtimePaths } from '../runtime-home';
vi.mock('./prompts', () => ({
  promptConfirm: vi.fn(),
  promptSelect: vi.fn(),
  promptText: vi.fn(),
}));
vi.mock('../modules/repo-workflows', () => ({
  readRepoWorkflows: vi.fn(),
  saveRepoWorkflows: vi.fn(),
  proposeRepoWorkflows: vi.fn(),
}));
vi.mock('../runtime-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime-home')>()),
  readRuntimeJsonSync: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  log: { info: vi.fn(), success: vi.fn() },
  note: vi.fn(),
}));
const paths = runtimePaths('/tmp/workflow-onboarding-unit');
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readLocalApiToken).mockResolvedValue('fixture-local-token');
  vi.mocked(readRuntimeJsonSync).mockReturnValue({ repos: [{ id: 'demo' }] });
  vi.mocked(readRepoWorkflows).mockReturnValue({
    repoId: 'demo',
    fingerprint: 'a'.repeat(64),
    workflows: null,
  });
  vi.mocked(saveRepoWorkflows).mockImplementation((repoId, input) => ({
    repoId,
    fingerprint: 'b'.repeat(64),
    workflows: v.parse(saveRepoWorkflowsInputSchema, input).workflows,
  }));
});
it('skips without reading any runtime configuration or asking Neon', async () => {
  vi.mocked(promptConfirm).mockResolvedValue(false);
  await configureFactoryWorkflows(paths);
  expect(readRuntimeJsonSync).not.toHaveBeenCalled();
  expect(proposeRepoWorkflows).not.toHaveBeenCalled();
  expect(saveRepoWorkflows).not.toHaveBeenCalled();
});
it('saves manually reviewed commands through the shared domain service without intake or credentials', async () => {
  vi.mocked(promptConfirm).mockImplementation(
    async (options) =>
      options.message ===
        'Set up optional repository setup and check workflows?' ||
      options.message === 'Save this repository workflow?' ||
      options.message === 'Add setup command 1?' ||
      options.message === 'Add check command 1?',
  );
  vi.mocked(promptSelect).mockImplementation(async (options) =>
    options.message === 'Repository workflow'
      ? 'demo'
      : options.message === 'Package manager requirement'
        ? 'pnpm'
        : 'profile-1',
  );
  vi.mocked(promptText).mockImplementation(async (options) => {
    if (options.message.startsWith('setup command'))
      return 'pnpm install --frozen-lockfile';
    if (options.message.startsWith('check command')) return 'pnpm test';
    if (options.message.startsWith('Environment variable')) return 'NPM_TOKEN';
    return String(options.initialValue ?? '');
  });
  await configureFactoryWorkflows(paths);
  expect(saveRepoWorkflows).toHaveBeenCalledWith(
    'demo',
    {
      expectedFingerprint: 'a'.repeat(64),
      workflows: expect.objectContaining({
        defaultProfileId: 'profile-1',
        profiles: [
          expect.objectContaining({
            setupCommands: [
              { command: 'pnpm install --frozen-lockfile', cwd: '.' },
            ],
            validationCommands: [{ command: 'pnpm test', cwd: '.' }],
            environmentRefs: ['NPM_TOKEN'],
          }),
        ],
      }),
    },
    paths,
  );
  expect(proposeRepoWorkflows).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(promptText)
      .mock.calls.some(([options]) =>
        /token value|password|auth/i.test(options.message),
      ),
  ).toBe(false);
});
it('leaves configuration unchanged when the user declines save', async () => {
  vi.mocked(promptConfirm).mockImplementation(
    async (options) =>
      options.message ===
      'Set up optional repository setup and check workflows?',
  );
  vi.mocked(promptSelect).mockImplementation(async (options) =>
    options.message === 'Repository workflow'
      ? 'demo'
      : options.message === 'Package manager requirement'
        ? 'none'
        : '__none__',
  );
  vi.mocked(promptText).mockImplementation(async (options) =>
    String(options.initialValue ?? ''),
  );
  await configureFactoryWorkflows(paths);
  expect(saveRepoWorkflows).not.toHaveBeenCalled();
});
it('validates runtime, reference and duplicate profile fields before leaving each prompt', async () => {
  vi.mocked(promptConfirm).mockImplementation(
    async (options) =>
      options.message ===
      'Set up optional repository setup and check workflows?',
  );
  vi.mocked(promptSelect).mockImplementation(async (options) =>
    options.message === 'Repository workflow'
      ? 'demo'
      : options.message === 'Package manager requirement'
        ? 'pnpm'
        : '__none__',
  );
  vi.mocked(promptText).mockImplementation(async (options) => {
    if (
      options.message.startsWith('Node version') ||
      options.message.startsWith('Package manager version')
    ) {
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )('not a version'),
      ).toBeTruthy();
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )('>=26'),
      ).toBeUndefined();
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )(''),
      ).toBeUndefined();
    }
    if (options.message.startsWith('Environment variable')) {
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )('secret=value'),
      ).toBeTruthy();
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )('PATH'),
      ).toBeTruthy();
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )('NPM_TOKEN,NPM_TOKEN'),
      ).toBeTruthy();
      expect(
        await (
          typeof options.validate === 'function'
            ? options.validate
            : () => {
                throw new Error('Expected prompt validator');
              }
        )('NPM_TOKEN'),
      ).toBeUndefined();
    }
    return String(options.initialValue ?? '');
  });
  await configureFactoryWorkflows(paths);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it('routes the actual onboarding Ask Neon action through the configured server without local model dispatch', async () => {
  vi.stubEnv('NEONDECK_PORT', '4567');
  vi.stubEnv('NEONDECK_PRIVATE_HOST', '::1');
  const workflows = {
    defaultProfileId: 'web',
    profiles: [
      {
        id: 'web',
        name: 'Web',
        setupCommands: [],
        validationCommands: [{ command: 'pnpm test', cwd: '.' }],
        setupTimeoutMs: 300000,
        validationTimeoutMs: 300000,
        runtime: {},
        environmentRefs: [],
      },
    ],
  };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        repoId: 'demo',
        fingerprint: 'a'.repeat(64),
        workflows: null,
        proposal: {
          workflows,
          rationale: 'Read pnpm lockfile',
          evidencePaths: ['pnpm-lock.yaml'],
          evidenceRevision: 'b'.repeat(40),
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.mocked(promptConfirm).mockImplementation(
    async (options) =>
      options.message ===
        'Set up optional repository setup and check workflows?' ||
      options.message.startsWith('Ask Neon'),
  );
  vi.mocked(promptSelect).mockImplementation(async (options) =>
    options.message === 'Repository workflow'
      ? 'demo'
      : options.message === 'Package manager requirement'
        ? 'none'
        : '__none__',
  );
  vi.mocked(promptText).mockImplementation(async (options) =>
    String(options.initialValue ?? ''),
  );
  await configureFactoryWorkflows(paths);
  expect(fetch).toHaveBeenCalledWith(
    'http://[::1]:4567/api/repos/demo/factory-workflows/propose',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: {
        'content-type': 'application/json',
        'x-neondeck-api-token': 'fixture-local-token',
      },
      body: JSON.stringify({ expectedFingerprint: 'a'.repeat(64) }),
    }),
  );
  expect(readLocalApiToken).toHaveBeenCalledWith(paths);
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining('Read pnpm lockfile'),
    'Suggested workflows',
  );
  expect(proposeRepoWorkflows).not.toHaveBeenCalled();
  expect(saveRepoWorkflows).not.toHaveBeenCalled();
});
it('explains unavailable server and continues the actual manual onboarding path', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new TypeError('fetch failed'),
  );
  vi.mocked(promptConfirm).mockImplementation(
    async (options) =>
      options.message ===
        'Set up optional repository setup and check workflows?' ||
      options.message.startsWith('Ask Neon'),
  );
  vi.mocked(promptSelect).mockImplementation(async (options) =>
    options.message === 'Repository workflow'
      ? 'demo'
      : options.message === 'Package manager requirement'
        ? 'none'
        : '__none__',
  );
  vi.mocked(promptText).mockImplementation(async (options) =>
    String(options.initialValue ?? ''),
  );
  await configureFactoryWorkflows(paths);
  expect(log.info).toHaveBeenCalledWith(
    expect.stringContaining(
      'Start neondeck serve separately with the same --home',
    ),
  );
  expect(proposeRepoWorkflows).not.toHaveBeenCalled();
});
it('bounds server proposal requests and cleans up signal listeners', async () => {
  vi.useFakeTimers();
  const count = process.listenerCount('SIGINT');
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        ),
      ),
  );
  const result = requestFactoryWorkflowProposal(
    'demo',
    'a'.repeat(64),
    paths,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(60001);
  expect((await result).message).toContain('timed out after 60 seconds');
  expect(process.listenerCount('SIGINT')).toBe(count);
});
it('rejects mismatched or malformed server suggestions without exposing them as a draft', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ unexpected: 'response' }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(
    requestFactoryWorkflowProposal('demo', 'a'.repeat(64), paths),
  ).rejects.toThrow();
});
it('aborts an in-flight server suggestion on Ctrl+C without dispatching locally', async () => {
  const count = process.listenerCount('SIGINT');
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
        requested();
      }),
  );
  const result = requestFactoryWorkflowProposal(
    'demo',
    'a'.repeat(64),
    paths,
  ).catch((error) => error);
  await started;
  process.emit('SIGINT');
  expect((await result).message).toContain('request cancelled');
  expect(process.listenerCount('SIGINT')).toBe(count);
  expect(proposeRepoWorkflows).not.toHaveBeenCalled();
});
