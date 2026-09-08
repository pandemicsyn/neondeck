import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import {
  reserveDeliveryPipeline,
  deliveryValidationContractDigest,
} from './store';
import { changeDelivery, requireDelivery } from './service-records';
import {
  factoryPublicationReadiness,
  authorizeFactoryPublication,
  setupFactoryPublication,
} from './publication-service';
import { deliveryBudget } from './delivery-aggregate';
const state = vi.hoisted(() => ({
  config: 'f'.repeat(64),
  candidate: 'b'.repeat(64),
  setup: false,
}));
vi.mock('./authority', () => ({
  assertDeliveryAuthority: vi.fn(),
  localValidationContext: () => ({ run: {} }),
}));
vi.mock('../factory', async (original) => ({
  ...(await original<typeof import('../factory')>()),
  codingHandle: vi.fn(),
}));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  captureCandidateEvidence: async () => ({
    evidenceDigest: state.candidate,
    treeSha: 'e'.repeat(40),
  }),
}));
vi.mock('./service-operator', () => ({
  factoryDeliveryDetail: (pipeline: unknown) => ({ pipeline }),
}));
vi.mock('./publication-context', async (original) => {
  const actual = await original<typeof import('./publication-context')>();
  return {
    ...actual,
    resolvePublicationContext: () => {
      if (state.setup)
        throw new actual.PublicationContextError(
          'credential-missing',
          'Configure GITHUB_TOKEN for publication.',
        );
      return {
        configFingerprint: state.config,
        target: { owner: 'test', name: 'repo', baseBranch: 'main' },
      };
    },
  };
});
let home: string;
let paths: ReturnType<typeof runtimePaths>;
let id: string;
const revision = {
  runId: 'run',
  attemptId: 'attempt',
  releaseId: 'release',
  specVersion: 1,
  specHash: 'a'.repeat(64),
  candidateDigest: 'b'.repeat(64),
  baseSha: 'c'.repeat(40),
  headSha: 'd'.repeat(40),
  treeSha: 'e'.repeat(40),
};
beforeEach(() => {
  state.config = 'f'.repeat(64);
  state.candidate = 'b'.repeat(64);
  state.setup = false;
  home = mkdtempSync('/private/tmp/publication-service-');
  paths = runtimePaths(home);
  mkdirSync(join(home, 'data'));
  initializeAppDatabase(paths.neondeckDatabase);
  id = reserveDeliveryPipeline(
    {
      workItemId: 'work',
      repoId: 'repo',
      initialRevision: revision,
      authorization: {
        mode: 'local-validation',
        id: 'validation',
        authorizedBy: 'operator',
        authorizedAt: '2026-09-07T00:00:00.000Z',
        revision,
        repoId: 'repo',
        target: { owner: 'test', name: 'repo', baseBranch: 'main' },
        configFingerprint: 'f'.repeat(64),
        checkCommands: ['npm test'],
        maxRepairAttempts: 2,
        totalExecutionMs: 10800000,
        initialExecutionMs: 100,
      },
    },
    paths,
  ).pipelineId;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function pass() {
  for (const kind of ['verification', 'review'] as const) {
    changeDelivery(
      id,
      { type: 'plan-effect', id: kind, kind, maxExecutionMs: 100 },
      paths,
    );
    changeDelivery(id, { type: 'start-effect', id: kind }, paths);
    changeDelivery(
      id,
      {
        type: 'record-evidence',
        evidence: {
          id: kind,
          kind,
          revision,
          producerId: `independent-${kind}`,
          result: 'passed',
          evidenceRef: kind,
          effectId: kind,
          validationContractDigest: deliveryValidationContractDigest(
            requireDelivery(id, paths),
          ),
          bundleDigest: '1'.repeat(64),
          verificationEvidenceId: kind === 'review' ? 'verification' : null,
          verificationBundleDigest: kind === 'review' ? '1'.repeat(64) : null,
        },
      },
      paths,
    );
    changeDelivery(
      id,
      {
        type: 'settle-effect',
        id: kind,
        state: 'delivered',
        receiptRef: kind,
        executionMs: 10,
      },
      paths,
    );
  }
}
it('blocks publication until independently clean and preserves safe missing-credential readiness', async () => {
  expect(await factoryPublicationReadiness(id, paths)).toMatchObject({
    ready: false,
    blocker: 'validation-required',
  });
  pass();
  state.setup = true;
  expect(await factoryPublicationReadiness(id, paths)).toMatchObject({
    ready: false,
    blocker: 'publication-setup',
    message: 'Configure GITHUB_TOKEN for publication.',
  });
});
it('exact publication replay after advancement reuses grant and budget; changed request version rejects', async () => {
  pass();
  const ready = await factoryPublicationReadiness(id, paths);
  const input = { requestId: 'publish', confirm: true, preview: ready.preview };
  const before = deliveryBudget(requireDelivery(id, paths));
  await authorizeFactoryPublication(id, input, paths);
  const granted = requireDelivery(id, paths);
  expect(granted.publication?.authorizedBy).toBe('local-operator');
  expect(granted.publication?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  await authorizeFactoryPublication(id, input, paths);
  expect(requireDelivery(id, paths)).toEqual(granted);
  expect(deliveryBudget(granted)).toEqual(before);
  await expect(
    authorizeFactoryPublication(
      id,
      {
        ...input,
        preview: { ...ready.preview, expectedVersion: granted.version },
      },
      paths,
    ),
  ).rejects.toThrow(/conflicts/);
  await expect(
    authorizeFactoryPublication(id, { ...input, requestId: 'new' }, paths),
  ).rejects.toThrow(/conflicts/);
});
it('rejects changed candidate and publication settings after preview without recording a grant', async () => {
  pass();
  const ready = await factoryPublicationReadiness(id, paths);
  const input = { requestId: 'publish', confirm: true, preview: ready.preview };
  state.candidate = '0'.repeat(64);
  await expect(authorizeFactoryPublication(id, input, paths)).rejects.toThrow(
    /Candidate changed/,
  );
  state.candidate = 'b'.repeat(64);
  state.config = '0'.repeat(64);
  await expect(authorizeFactoryPublication(id, input, paths)).rejects.toThrow(
    /changed/,
  );
  expect(requireDelivery(id, paths).publication).toBeUndefined();
});
it('rejects caller-supplied actor and malformed publication setup before effects', async () => {
  pass();
  const ready = await factoryPublicationReadiness(id, paths);
  await expect(
    authorizeFactoryPublication(
      id,
      {
        requestId: 'publish',
        confirm: true,
        preview: ready.preview,
        authorizedBy: 'model',
      },
      paths,
    ),
  ).rejects.toThrow();
  await expect(
    setupFactoryPublication('repo', { tokenEnv: 'secret value' }, paths),
  ).rejects.toThrow();
});

it('recovers an exact publication receipt after terminal cancellation without renewing execution authority', async () => {
  pass();
  const ready = await factoryPublicationReadiness(id, paths);
  const input = {
    requestId: 'publish-terminal',
    confirm: true,
    preview: ready.preview,
  };
  await authorizeFactoryPublication(id, input, paths);
  const grant = requireDelivery(id, paths).publication;
  changeDelivery(
    id,
    { type: 'finish', outcome: 'cancelled', evidenceRef: 'human-cancelled' },
    paths,
  );
  const before = requireDelivery(id, paths);
  const { assertDeliveryAuthority } = await import('./authority');
  const actualAuthority =
    await vi.importActual<typeof import('./authority')>('./authority');
  expect(() => actualAuthority.assertDeliveryAuthority(before, paths)).toThrow(
    'terminal',
  );
  vi.mocked(assertDeliveryAuthority).mockImplementation(
    actualAuthority.assertDeliveryAuthority,
  );
  try {
    await expect(
      authorizeFactoryPublication(id, input, paths),
    ).resolves.toMatchObject({
      pipeline: { outcome: 'cancelled', publication: grant },
    });
    expect(requireDelivery(id, paths)).toEqual(before);
    await expect(
      authorizeFactoryPublication(
        id,
        { ...input, requestId: 'replacement' },
        paths,
      ),
    ).rejects.toThrow('conflicts');
  } finally {
    vi.mocked(assertDeliveryAuthority).mockReset();
  }
});
