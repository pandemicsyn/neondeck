import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
const mocks = vi.hoisted(() => ({
  fingerprint: 'a'.repeat(64),
  commands: [] as string[],
  fail: '',
  node: '',
  missingManager: false,
  trackedDrift: false,
  gitFailure: false,
  cleanupFailure: '',
  duringCleanup: null as null | (() => Promise<void>),
  cleanupMutations: [] as { command: string; settled: boolean }[],
  duringObservation: null as null | (() => Promise<void>),
  refs: [] as string[],
  cwd: '.',
  policy: 'allow',
  changeSettings: false,
  wait: false,
  cancelled: false,
}));
vi.mock('./trial-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trial-store')>();
  return {
    ...actual,
    trialControllerState: async (
      controller: Parameters<typeof actual.trialControllerState>[0],
    ) => {
      const hook = mocks.duringObservation;
      mocks.duringObservation = null;
      await hook?.();
      return actual.trialControllerState(controller);
    },
  };
});
vi.mock('../factory', () => ({
  FactoryError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../repo-workflows', () => ({
  readRepoWorkflows: () => ({ fingerprint: mocks.fingerprint }),
  resolveRepoWorkflow: () => ({
    id: 'test',
    name: 'Test',
    setupCommands: [
      { command: 'prepare', cwd: mocks.cwd },
      { command: 'prepare2', cwd: '.' },
    ],
    validationCommands: [{ command: 'validate', cwd: '.' }],
    setupTimeoutMs: 1000,
    validationTimeoutMs: 1000,
    runtime: mocks.missingManager
      ? { packageManager: { name: 'pnpm', version: '^10.0.0' } }
      : mocks.node
        ? { node: mocks.node }
        : {},
    environmentRefs: mocks.refs,
  }),
}));
vi.mock('../repo-workflow-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../repo-workflow-runtime')>();
  return {
    ...actual,
    preflightRepoWorkflowRuntime: async (raw: unknown) => {
      if (mocks.missingManager)
        throw new actual.WorkflowRuntimeUnavailableError(
          'ENVIRONMENT SETUP: the required package manager executable is unavailable.',
        );
      return actual.preflightRepoWorkflowRuntime(raw);
    },
  };
});
vi.mock('../execution', () => ({
  checkExecutionPolicy: async () => ({ decision: mocks.policy }),
}));
vi.mock('../coding-runs', async () => {
  const io = await import('../coding-runs/host-io');
  const { createHash } = await import('node:crypto');
  return {
    ...io,
    artifactHash: (s: string) => createHash('sha256').update(s).digest('hex'),
    hostGit: async (cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        await mkdir(args[4]);
        await writeFile(join(args[4], '.git'), 'gitdir: fixture');
        return '';
      }
      if (
        (args[0] === 'worktree' && args[1] === 'remove') ||
        args[0] === 'update-ref'
      ) {
        const { readTrialOwnership } = await import('./trial-store');
        const owner = await readTrialOwnership(
          join(root, 'repo-workflow-runs', runId),
        );
        const command = args[0] === 'worktree' ? 'remove' : 'update-ref';
        mocks.cleanupMutations.push({ command, settled: owner.gitSettled });
        await mocks.duringCleanup?.();
        if (mocks.cleanupFailure === command)
          throw new Error('Simulated interruption during Git mutation');
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        await rm(args[4], { recursive: true });
        return '';
      }
      if (args[0] === 'worktree')
        return `worktree ${join(root, 'repo-workflow-runs', runId, 'checkout')}\n`;
      if (args[1] === '--git-common-dir') return join(root, 'common');
      if (args[1] === '--show-toplevel') {
        if (mocks.gitFailure)
          throw new Error('/private/operator/secret-path token=DO_NOT_EXPOSE');
        return cwd;
      }
      if (args[0] === 'diff' && mocks.trackedDrift && mocks.commands.length)
        return 'private-tracked-filename';
      if (args[0] === 'rev-parse') return 'b'.repeat(40);
      return '';
    },
  };
});
vi.mock('../factory-delivery', async () => {
  const v = await import('valibot');
  return {
    candidateCheckInputSchema: v.any(),
    recoverExistingCandidateCheck: vi.fn(),
    cancelCandidateVerification: async () => {
      mocks.cancelled = true;
    },
    runSupervisedCandidateCheck: async (request: {
      command: string;
      cwd: string;
    }) => {
      mocks.commands.push(request.command);
      if (mocks.changeSettings) mocks.fingerprint = 'd'.repeat(64);
      if (request.command === 'prepare')
        await writeFile(join(request.cwd, 'dependency'), 'ready');
      if (request.command === 'validate')
        expect(await readFile(join(request.cwd, 'dependency'), 'utf8')).toBe(
          'ready',
        );
      while (mocks.wait && !mocks.cancelled)
        await new Promise((r) => setTimeout(r, 5));
      return {
        noWriter: true,
        exitCode: mocks.cancelled
          ? null
          : mocks.fail === request.command
            ? 1
            : 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        timedOut: false,
        cancelled: mocks.cancelled,
      };
    },
  };
});
import {
  startRepoWorkflowRun,
  getRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from './service';
let root: string, paths: RuntimePaths, runId: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'trial-service-')));
  paths = runtimePaths(root);
  await mkdir(join(root, 'repo'));
  await mkdir(join(root, 'common'));
  await writeFile(paths.config, '{"version":1}');
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: [
        {
          id: 'sample',
          path: join(root, 'repo'),
          defaultBranch: 'main',
          github: { owner: 'fixture', name: 'sample' },
        },
      ],
    }),
  );
  Object.assign(mocks, {
    fingerprint: 'a'.repeat(64),
    commands: [],
    fail: '',
    node: '',
    missingManager: false,
    trackedDrift: false,
    gitFailure: false,
    cleanupFailure: '',
    duringCleanup: null,
    cleanupMutations: [],
    duringObservation: null,
    refs: [],
    cwd: '.',
    policy: 'allow',
    changeSettings: false,
    wait: false,
    cancelled: false,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function start() {
  const result = await startRepoWorkflowRun(
    'sample',
    { profileId: 'test', expectedFingerprint: 'a'.repeat(64) },
    paths,
  );
  runId = result.runId;
  return result;
}
async function settled() {
  for (let i = 0; i < 300; i++) {
    const r = await getRepoWorkflowRun('sample', runId, paths);
    if (r.phase === 'complete') return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Trial stuck');
}
it('setup creates the dependency required by validation and cleans checkout', async () => {
  await start();
  expect(await settled()).toMatchObject({
    status: 'passed',
    cleanup: 'complete',
  });
  expect(mocks.commands).toEqual(['prepare', 'prepare2', 'validate']);
});
it('setup failure stops subsequent setup and validation', async () => {
  mocks.fail = 'prepare';
  await start();
  expect(await settled()).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(mocks.commands).toEqual(['prepare']);
});
it('cancellation waits for worker settlement before checkout removal', async () => {
  mocks.wait = true;
  await start();
  while (!mocks.commands.length) await new Promise((r) => setTimeout(r, 5));
  await cancelRepoWorkflowRun('sample', runId, paths);
  expect(await settled()).toMatchObject({
    status: 'cancelled',
    cleanup: 'complete',
  });
  expect(mocks.commands).toEqual(['prepare']);
});
it('rejects stale reviewed fingerprints before any execution', async () => {
  mocks.fingerprint = 'c'.repeat(64);
  await expect(start()).rejects.toMatchObject({ status: 409 });
  expect(mocks.commands).toEqual([]);
});
it('rejects symlink storage without touching its target', async () => {
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'repo-workflow-runs'));
  await expect(start()).rejects.toThrow();
  expect(mocks.commands).toEqual([]);
});
it.each(['running', 'passed', 'failed'] as const)(
  'recovers dead-controller %s with pending cleanup only when durable jobs prove no writer',
  async (status) => {
    await start();
    const completed = await settled();
    const directory = join(root, 'repo-workflow-runs', runId);
    const { trialHandle, readTrialOwnership, saveTrialOwnership } =
      await import('./trial-store');
    const { writeSigned, artifactHash } = await import('../coding-runs');
    const { recoverExistingCandidateCheck } =
      await import('../factory-delivery');
    const owner = await readTrialOwnership(directory);
    owner.controller = await exitedController();
    owner.source = '';
    await saveTrialOwnership(directory, owner);
    const lock = join(
      root,
      'repo-workflow-runs',
      `repo-${artifactHash('sample')}.lock`,
    );
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'run-id'), runId);
    const handle = await trialHandle(directory);
    await writeSigned(join(directory, 'result.json'), handle.attemptToken, {
      ...completed,
      status,
      cleanup: 'pending',
      phase: status === 'running' ? 'validation' : 'cleanup',
      finishedAt: null,
    });
    vi.mocked(recoverExistingCandidateCheck).mockRejectedValueOnce(
      new Error('No receipt'),
    );
    expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
      status: 'uncertain',
      cleanup: 'retained',
      phase: 'complete',
    });
    vi.mocked(recoverExistingCandidateCheck).mockResolvedValue({
      noWriter: true,
    } as never);
    expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
      status: 'cancelled',
      cleanup: 'complete',
    });
  },
);
it('retains interrupted git creation even when no command was started', async () => {
  await start();
  const completed = await settled();
  const directory = join(root, 'repo-workflow-runs', runId);
  const { trialHandle, readTrialOwnership, saveTrialOwnership } =
    await import('./trial-store');
  const { writeSigned } = await import('../coding-runs');
  const owner = await readTrialOwnership(directory);
  owner.controller = await exitedController();
  owner.gitSettled = false;
  owner.jobs = [];
  await saveTrialOwnership(directory, owner);
  const handle = await trialHandle(directory);
  await writeSigned(join(directory, 'result.json'), handle.attemptToken, {
    ...completed,
    status: 'running',
    cleanup: 'pending',
    finishedAt: null,
  });
  expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
    status: 'uncertain',
    cleanup: 'retained',
    phase: 'complete',
  });
});

it('blocks missing runtime before checkout or commands', async () => {
  mocks.node = '>=999';
  await start();
  expect(await settled()).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(mocks.commands).toEqual([]);
});
it('blocks missing environment references before commands', async () => {
  mocks.refs = ['NEON_TEST_UNAVAILABLE_TRIAL_FIXTURE'];
  await start();
  const result = await settled();
  expect(result.guidance).toContain('NEON_TEST_UNAVAILABLE_TRIAL_FIXTURE');
  expect(result.guidance).toContain('Provide a valid permitted value');
  expect(result).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(mocks.commands).toEqual([]);
});
it('stops when reviewed settings change during setup', async () => {
  mocks.changeSettings = true;
  await start();
  expect(await settled()).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(mocks.commands).toEqual(['prepare']);
});
it('policy denial includes the command and remediation without creating checkout', async () => {
  mocks.policy = 'deny';
  await start();
  const result = await settled();
  expect(result).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(result.logs[0]).toMatchObject({ command: 'prepare' });
  expect(result.guidance).toContain('permission');
  expect(mocks.commands).toEqual([]);
});
it('missing cwd stops execution with an environment diagnostic', async () => {
  mocks.cwd = 'missing';
  await start();
  const result = await settled();
  expect(result).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(result.logs[0].output).toContain('directory');
  expect(mocks.commands).toEqual([]);
});

async function exitedController() {
  const { captureTrialController } = await import('./trial-store');
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('message', () => process.exit(0)); process.send('ready');",
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  await once(child, 'message');
  const identity = await captureTrialController(child.pid!);
  const exited = once(child, 'exit');
  child.send('exit');
  await exited;
  return identity;
}
it('another controller status reader leaves a live trial untouched and explicit cancellation works', async () => {
  mocks.wait = true;
  await start();
  while (!mocks.commands.length) await new Promise((r) => setTimeout(r, 5));
  const directory = join(root, 'repo-workflow-runs', runId);
  const before = await readFile(join(directory, 'result.json'), 'utf8');
  vi.resetModules();
  const secondController = await import('./service');
  try {
    expect(
      await secondController.getRepoWorkflowRun('sample', runId, paths),
    ).toMatchObject({ status: 'running', cleanup: 'pending' });
    expect(mocks.cancelled).toBe(false);
    expect(await readFile(join(directory, 'result.json'), 'utf8')).toBe(before);
    expect(
      await readFile(join(directory, 'checkout', 'dependency'), 'utf8'),
    ).toBe('ready');
    await secondController.cancelRepoWorkflowRun('sample', runId, paths);
    expect(mocks.cancelled).toBe(true);
  } finally {
    await cancelRepoWorkflowRun('sample', runId, paths);
  }
  expect(await settled()).toMatchObject({
    status: 'cancelled',
    cleanup: 'complete',
  });
});
it('an unobservable controller never authorizes recovery cancellation or cleanup', async () => {
  await start();
  const completed = await settled();
  const directory = join(root, 'repo-workflow-runs', runId);
  const { trialHandle, readTrialOwnership, saveTrialOwnership } =
    await import('./trial-store');
  const { writeSigned } = await import('../coding-runs');
  const owner = await readTrialOwnership(directory);
  delete owner.controller;
  await saveTrialOwnership(directory, owner);
  const handle = await trialHandle(directory);
  await writeSigned(join(directory, 'result.json'), handle.attemptToken, {
    ...completed,
    status: 'running',
    cleanup: 'pending',
  });
  const before = await readFile(join(directory, 'result.json'), 'utf8');
  expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
    status: 'uncertain',
  });
  expect(mocks.cancelled).toBe(false);
  expect(await readFile(join(directory, 'result.json'), 'utf8')).toBe(before);
});

it('missing package manager names the required tool/version and remediation', async () => {
  mocks.missingManager = true;
  await start();
  const result = await settled();
  expect(result).toMatchObject({
    status: 'setup-blocked',
    cleanup: 'complete',
  });
  expect(result.guidance).toContain('pnpm ^10.0.0');
  expect(result.guidance).toContain('installed executable');
  expect(mocks.commands).toEqual([]);
});
it('missing Node names the requirement', async () => {
  mocks.node = '>=999';
  await start();
  expect((await settled()).guidance).toContain('Node >=999');
});
it('tracked setup drift explains the change without exposing filenames', async () => {
  mocks.trackedDrift = true;
  await start();
  const result = await settled();
  expect(result.guidance).toContain('changed tracked repository content');
  expect(result.guidance).not.toContain('private-tracked-filename');
  expect(mocks.commands).toEqual(['prepare']);
});
it('unexpected repository errors never expose raw paths or secrets', async () => {
  mocks.gitFailure = true;
  await start();
  const result = await settled();
  expect(result.guidance).toContain('configured remote default branch');
  expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
  expect(JSON.stringify(result)).not.toContain('/private/operator');
});

it('persists unsettled ownership before each cleanup Git mutation and settles after success', async () => {
  await start();
  expect(await settled()).toMatchObject({ cleanup: 'complete' });
  expect(mocks.cleanupMutations).toEqual([
    { command: 'remove', settled: false },
    { command: 'update-ref', settled: false },
  ]);
  const { readTrialOwnership } = await import('./trial-store');
  expect(
    (await readTrialOwnership(join(root, 'repo-workflow-runs', runId)))
      .gitSettled,
  ).toBe(true);
});
it.each(['remove', 'update-ref'])(
  'interrupted cleanup %s remains unsettled and cannot be repeated or unlocked',
  async (command) => {
    mocks.cleanupFailure = command;
    await start();
    expect(await settled()).toMatchObject({
      status: 'uncertain',
      cleanup: 'retained',
    });
    const directory = join(root, 'repo-workflow-runs', runId);
    const { readTrialOwnership, saveTrialOwnership } =
      await import('./trial-store');
    const { artifactHash } = await import('../coding-runs');
    const owner = await readTrialOwnership(directory);
    expect(owner.gitSettled).toBe(false);
    owner.controller = await exitedController();
    await saveTrialOwnership(directory, owner);
    const mutations = mocks.cleanupMutations.length;
    mocks.cleanupFailure = '';
    expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
      status: 'uncertain',
      cleanup: 'retained',
    });
    expect(mocks.cleanupMutations).toHaveLength(mutations);
    expect(
      await readFile(
        join(
          root,
          'repo-workflow-runs',
          `repo-${artifactHash('sample')}.lock`,
          'run-id',
        ),
        'utf8',
      ),
    ).toBe(runId);
  },
);
it.each(['job', 'git', 'controller'])(
  'recovery rereads ownership changed during death observation: %s',
  async (change) => {
    await start();
    const completed = await settled();
    const directory = join(root, 'repo-workflow-runs', runId);
    const {
      readTrialOwnership,
      saveTrialOwnership,
      trialHandle,
      captureTrialController,
    } = await import('./trial-store');
    const { artifactHash, writeSigned } = await import('../coding-runs');
    const { recoverExistingCandidateCheck } =
      await import('../factory-delivery');
    const owner = await readTrialOwnership(directory);
    const priorJob = owner.jobs[0];
    owner.controller = await exitedController();
    owner.source = '';
    owner.jobs = [];
    await saveTrialOwnership(directory, owner);
    const lock = join(
      root,
      'repo-workflow-runs',
      `repo-${artifactHash('sample')}.lock`,
    );
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'run-id'), runId);
    const handle = await trialHandle(directory);
    await writeSigned(join(directory, 'result.json'), handle.attemptToken, {
      ...completed,
      status: 'running',
      cleanup: 'pending',
      phase: 'setup',
      finishedAt: null,
    });
    vi.mocked(recoverExistingCandidateCheck)
      .mockReset()
      .mockRejectedValue(new Error('New job has no settlement receipt'));
    mocks.duringObservation = async () => {
      const fresh = await readTrialOwnership(directory);
      if (change === 'job') fresh.jobs = [priorJob];
      if (change === 'git') fresh.gitSettled = false;
      if (change === 'controller')
        fresh.controller = await captureTrialController();
      await saveTrialOwnership(directory, fresh);
    };
    const mutations = mocks.cleanupMutations.length;
    expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
      status: 'uncertain',
      cleanup: 'retained',
    });
    if (change === 'job')
      expect(recoverExistingCandidateCheck).toHaveBeenCalledWith(
        priorJob.request,
        expect.anything(),
        priorJob.jobId,
        runId,
      );
    else expect(recoverExistingCandidateCheck).not.toHaveBeenCalled();
    expect(mocks.cleanupMutations).toHaveLength(mutations);
    expect(await readFile(join(lock, 'run-id'), 'utf8')).toBe(runId);
  },
);

it.each(['complete', 'interrupted'])(
  'exclusive recovery prevents a second observer cleaning while Git is active: %s',
  async (outcome) => {
    await start();
    const completed = await settled();
    const directory = join(root, 'repo-workflow-runs', runId);
    const { readTrialOwnership, saveTrialOwnership, trialHandle } =
      await import('./trial-store');
    const { artifactHash, writeSigned } = await import('../coding-runs');
    const owner = await readTrialOwnership(directory);
    owner.controller = await exitedController();
    owner.jobs = [];
    await saveTrialOwnership(directory, owner);
    await mkdir(owner.root);
    await writeFile(join(owner.root, '.git'), 'gitdir: fixture');
    const lock = join(
      root,
      'repo-workflow-runs',
      `repo-${artifactHash('sample')}.lock`,
    );
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'run-id'), runId);
    const handle = await trialHandle(directory);
    await writeSigned(join(directory, 'result.json'), handle.attemptToken, {
      ...completed,
      status: 'running',
      cleanup: 'pending',
      phase: 'cleanup',
      finishedAt: null,
    });
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.duringCleanup = async () => {
      entered();
      await gate;
    };
    mocks.cleanupFailure = outcome === 'interrupted' ? 'remove' : '';
    const before = mocks.cleanupMutations.length;
    vi.resetModules();
    const another = await import('./service');
    const first = another.getRepoWorkflowRun('sample', runId, paths);
    try {
      await started;
      const persisted = await readFile(join(directory, 'result.json'), 'utf8');
      expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
        status: 'uncertain',
        cleanup: 'retained',
        guidance: expect.stringContaining('already claimed'),
      });
      expect(mocks.cleanupMutations).toHaveLength(before + 1);
      expect(await readFile(join(directory, 'result.json'), 'utf8')).toBe(
        persisted,
      );
    } finally {
      resume();
    }
    expect(await first).toMatchObject({
      cleanup: outcome === 'complete' ? 'complete' : 'retained',
    });
    mocks.duringCleanup = null;
    mocks.cleanupFailure = '';
    if (outcome === 'interrupted') {
      // Even a later apparently settled journal cannot authorize stealing the
      // interrupted executor claim: only that executor can safely release it.
      const fresh = await readTrialOwnership(directory);
      fresh.gitSettled = true;
      await saveTrialOwnership(directory, fresh);
      expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
        cleanup: 'retained',
        guidance: expect.stringContaining('already claimed'),
      });
      expect(mocks.cleanupMutations).toHaveLength(before + 1);
      expect(await readFile(join(lock, 'run-id'), 'utf8')).toBe(runId);
    } else {
      expect(await getRepoWorkflowRun('sample', runId, paths)).toMatchObject({
        cleanup: 'complete',
      });
      expect(mocks.cleanupMutations).toHaveLength(before + 2);
    }
  },
);
