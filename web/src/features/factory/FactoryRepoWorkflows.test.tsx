// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepoWorkflowEditor } from './FactoryRepoWorkflows';
import {
  getRepoWorkflowRun,
  proposeRepoWorkflows,
  saveRepoWorkflows,
  startRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from './workflow-api';
import type { RepoWorkflowsSnapshot } from '../../../../shared/repo-workflows';
import type { RepoWorkflowRun } from '../../../../shared/repo-workflow-runs';
vi.mock('./workflow-api', () => ({
  getRepoWorkflows: vi.fn(),
  saveRepoWorkflows: vi.fn(),
  proposeRepoWorkflows: vi.fn(),
  startRepoWorkflowRun: vi.fn(),
  getRepoWorkflowRun: vi.fn(),
  cancelRepoWorkflowRun: vi.fn(),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const snapshot = (): RepoWorkflowsSnapshot => ({
  repoId: 'demo',
  fingerprint: 'a'.repeat(64),
  workflows: {
    defaultProfileId: 'web',
    profiles: [
      {
        id: 'web',
        name: 'Web app',
        setupCommands: [
          { command: 'pnpm install --frozen-lockfile', cwd: '.' },
        ],
        validationCommands: [{ command: 'pnpm test', cwd: 'web' }],
        setupTimeoutMs: 300000,
        validationTimeoutMs: 600000,
        runtime: { node: '>=26', packageManager: { name: 'pnpm' } },
        environmentRefs: [],
      },
    ],
  },
});
const run = (): RepoWorkflowRun => ({
  runId: 'trial',
  repoId: 'demo',
  profileId: 'web',
  workflowFingerprint: 'b'.repeat(64),
  status: 'running',
  baseSha: null,
  phase: 'setup',
  logs: [],
  cleanup: 'pending',
  guidance: '',
  startedAt: '2026-09-07T00:00:00.000Z',
  finishedAt: null,
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(getRepoWorkflowRun).mockResolvedValue(run());
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function render(value = snapshot()) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RepoWorkflowEditor snapshot={value} />
      </QueryClientProvider>,
    ),
  );
}
async function click(text: string) {
  await act(async () => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.includes(text),
    );
    expect(button).toBeTruthy();
    button!.click();
  });
}
function button(text: string) {
  return Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  )!;
}
async function submit() {
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
it('never starts a model or trial on render or save', async () => {
  await render();
  await click('Add profile');
  vi.mocked(saveRepoWorkflows).mockImplementation(async (repoId, input) => ({
    repoId,
    fingerprint: 'b'.repeat(64),
    workflows: input.workflows,
  }));
  await submit();
  expect(saveRepoWorkflows).toHaveBeenCalledWith(
    'demo',
    expect.objectContaining({ expectedFingerprint: 'a'.repeat(64) }),
  );
  expect(proposeRepoWorkflows).not.toHaveBeenCalled();
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('retains drafts through polling and disables stale saves and tests', async () => {
  await render();
  await click('Add profile');
  const next = snapshot();
  next.fingerprint = 'b'.repeat(64);
  next.workflows!.profiles[0].name = 'Remote change';
  await render(next);
  expect(container.textContent).toContain('Profile 2');
  expect(container.textContent).toContain('Saved settings changed elsewhere');
  expect(button('Save workflow').disabled).toBe(true);
  expect(button('Test setup and validation').disabled).toBe(true);
  expect(container.textContent).not.toContain('Remote change');
});
it('retains failed saves and requires an explicit suggestion adoption', async () => {
  await render();
  await click('Add profile');
  vi.mocked(saveRepoWorkflows).mockRejectedValue(
    new Error('Configuration changed'),
  );
  await submit();
  expect(container.textContent).toContain('Configuration changed');
  expect(container.textContent).toContain('Profile 2');
  const proposed = snapshot();
  proposed.workflows!.profiles[0].name = 'Suggested';
  vi.mocked(proposeRepoWorkflows).mockResolvedValue({
    ...snapshot(),
    proposal: {
      workflows: proposed.workflows!,
      rationale: 'Found pnpm lockfile',
      evidenceRevision: 'a'.repeat(40),
      evidencePaths: ['pnpm-lock.yaml'],
    },
  });
  await click('Ask Neon');
  expect(container.textContent).toContain('Found pnpm lockfile');
  expect(container.querySelector('input')?.value).toBe('profile-2');
  await click('Use suggestion');
  expect(container.querySelector('input')?.value).toBe('web');
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('starts only on click, shows setup failures and cancellation', async () => {
  vi.mocked(startRepoWorkflowRun).mockResolvedValue(run());
  await render();
  await click('Test setup and validation');
  expect(startRepoWorkflowRun).toHaveBeenCalledWith('demo', {
    profileId: 'web',
    expectedFingerprint: 'a'.repeat(64),
  });
  expect(container.textContent).toContain('Setting up repository');
  const stopped = {
    ...run(),
    status: 'cancelled' as const,
    phase: 'complete' as const,
    cleanup: 'complete' as const,
  };
  vi.mocked(cancelRepoWorkflowRun).mockResolvedValue(stopped);
  vi.mocked(getRepoWorkflowRun).mockResolvedValue(stopped);
  await click('Cancel test');
  expect(cancelRepoWorkflowRun).toHaveBeenCalledWith('demo', 'trial');
  expect(container.textContent).toContain('Test cancelled');
  expect(button('Test setup and validation').disabled).toBe(false);
});
it('keeps polling terminal status until cleanup completes before enabling another test', async () => {
  vi.useFakeTimers();
  try {
    const pending: RepoWorkflowRun = {
      ...run(),
      status: 'cancelled',
      phase: 'cleanup',
    };
    vi.mocked(startRepoWorkflowRun).mockResolvedValue(pending);
    vi.mocked(getRepoWorkflowRun).mockResolvedValue(pending);
    await render();
    await click('Test setup and validation');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(container.textContent).toContain('Cleaning up test checkout');
    expect(button('Test setup and validation').disabled).toBe(true);
    const reads = vi.mocked(getRepoWorkflowRun).mock.calls.length;
    vi.mocked(getRepoWorkflowRun).mockResolvedValue({
      ...pending,
      phase: 'complete',
      cleanup: 'complete',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(vi.mocked(getRepoWorkflowRun).mock.calls.length).toBeGreaterThan(
      reads,
    );
    expect(container.textContent).toContain('cleaned up');
    expect(button('Test setup and validation').disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
