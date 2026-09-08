import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runWorkflowPhase } from './runner';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-phase-')));
  roots.push(root);
  return {
    root,
    workflow: {
      id: 'test',
      name: 'Test',
      setupCommands: [
        { command: 'one', cwd: '.' },
        { command: 'two', cwd: '.' },
      ],
      validationCommands: [{ command: 'check', cwd: '.' }],
      setupTimeoutMs: 1000,
      validationTimeoutMs: 1000,
      runtime: {},
      environmentRefs: [],
    },
    phase: 'setup' as const,
    remainingMs: 2000,
  };
}
const result = {
  exitCode: 0,
  truncated: false,
  timedOut: false,
  cancelled: false,
  noWriter: true,
  durationMs: 1,
  stdout: '',
  stderr: '',
};
it('uses one aggregate setup deadline, including time before command admission', async () => {
  const input = await fixture();
  let time = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const run = vi.fn(async (request) => {
    expect(request.timeoutMs).toBe(400);
    time += 401;
    return { ...result, durationMs: 401 };
  });
  const report = await runWorkflowPhase({
    ...input,
    before: async () => {
      time += 600;
    },
    run,
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(report.passed).toBe(false);
});
it('permits empty setup but never certifies empty validation or invalid timeout', async () => {
  const input = await fixture(),
    run = vi.fn(async () => result),
    workflow = { ...input.workflow, setupCommands: [], validationCommands: [] };
  expect((await runWorkflowPhase({ ...input, workflow, run })).passed).toBe(
    true,
  );
  expect(
    (await runWorkflowPhase({ ...input, workflow, phase: 'validation', run }))
      .passed,
  ).toBe(false);
  await expect(
    runWorkflowPhase({ ...input, remainingMs: 0, run }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
it('retains an actionable missing-directory result without implying process uncertainty', async () => {
  const input = await fixture(),
    run = vi.fn(async () => result);
  const report = await runWorkflowPhase({
    ...input,
    workflow: {
      ...input.workflow,
      setupCommands: [{ command: 'one', cwd: 'missing' }],
    },
    run,
  });
  expect(report).toMatchObject({
    passed: false,
    results: [
      {
        noWriter: true,
        setupBlocked: true,
        stderr: expect.stringContaining('command directory'),
      },
    ],
  });
  expect(run).not.toHaveBeenCalled();
});
