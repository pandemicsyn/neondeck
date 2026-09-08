import { readWorkflowDraft, writeWorkflowDraft } from './workflow-draft';
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  FactoryRepoWorkflows,
  RepoWorkflowEditor,
} from './FactoryRepoWorkflows';
import {
  getRepoWorkflows,
  getCurrentRepoWorkflowRun,
  getRepoWorkflowRun,
  proposeRepoWorkflows,
  saveRepoWorkflows,
  startRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from './workflow-api';
import type { RepoWorkflowsSnapshot } from '../../../../shared/repo-workflows';
import type { RepoWorkflowRun } from '../../../../shared/repo-workflow-runs';
vi.mock('./workflow-api', () => ({
  getCurrentRepoWorkflowRun: vi.fn(),
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
  sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
  vi.mocked(getRepoWorkflowRun).mockResolvedValue(run());
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function flushDiscovery() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
async function render(value = snapshot()) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RepoWorkflowEditor snapshot={value} />
      </QueryClientProvider>,
    ),
  );
  await flushDiscovery();
}
async function click(text: string) {
  await act(async () => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.includes(text),
    );
    expect(button).toBeTruthy();
    button!.click();
    await Promise.resolve();
  });
  await flushDiscovery();
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
it.each(['cancelled', 'running'] as const)(
  'retains a %s cancel receipt when the following status read fails',
  async (status) => {
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
    await render();
    const receipt: RepoWorkflowRun = {
      ...run(),
      status,
      guidance: 'Confirmed cancel receipt',
      phase: status === 'cancelled' ? 'complete' : 'setup',
      cleanup: status === 'cancelled' ? 'complete' : 'pending',
    };
    vi.mocked(cancelRepoWorkflowRun).mockResolvedValue(receipt);
    vi.mocked(getRepoWorkflowRun).mockRejectedValue(
      new Error('Read unavailable'),
    );
    await click('Cancel test');
    expect(client.getQueryData(['repo-workflow-run', 'demo', 'trial'])).toEqual(
      receipt,
    );
    expect(container.textContent).toContain('Confirmed cancel receipt');
    expect(container.textContent).toContain('Test progress could not refresh');
    expect(container.textContent).not.toContain('Could not cancel the test');
    expect(container.textContent?.includes('Test cancelled')).toBe(
      status === 'cancelled',
    );
    expect(container.textContent?.includes('Test in progress')).toBe(
      status === 'running',
    );
  },
);
it('reports cancel POST failure without changing confirmed progress', async () => {
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
  await render();
  const reads = vi.mocked(getRepoWorkflowRun).mock.calls.length;
  vi.mocked(cancelRepoWorkflowRun).mockRejectedValue(
    new Error('Cancel unavailable'),
  );
  await click('Cancel test');
  expect(container.textContent).toContain('Could not cancel the test');
  expect(container.textContent).toContain('Test in progress');
  expect(container.textContent).not.toContain(
    'Test progress could not refresh',
  );
  expect(getRepoWorkflowRun).toHaveBeenCalledTimes(reads);
  expect(client.getQueryData(['repo-workflow-run', 'demo', 'trial'])).toEqual(
    run(),
  );
});
it('ignores a delayed cancel receipt after a new run replaces its mounted instance', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
    await render();
    let finishCancel!: (value: RepoWorkflowRun) => void;
    vi.mocked(cancelRepoWorkflowRun).mockReturnValue(
      new Promise((resolve) => {
        finishCancel = resolve;
      }),
    );
    await click('Cancel test');
    const completeA: RepoWorkflowRun = {
      ...run(),
      status: 'passed',
      phase: 'complete',
      cleanup: 'complete',
    };
    vi.mocked(getRepoWorkflowRun).mockResolvedValue(completeA);
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    const activeB = { ...run(), runId: 'trial-b', guidance: 'Running B' };
    vi.mocked(startRepoWorkflowRun).mockResolvedValue(activeB);
    vi.mocked(getRepoWorkflowRun).mockResolvedValue(activeB);
    await click('Test setup and validation');
    const ownershipReads = vi.mocked(getCurrentRepoWorkflowRun).mock.calls
      .length;
    const statusReads = vi.mocked(getRepoWorkflowRun).mock.calls.length;
    await act(async () =>
      finishCancel({
        ...completeA,
        status: 'cancelled',
        guidance: 'Old receipt A',
      }),
    );
    await flushDiscovery();
    expect(getCurrentRepoWorkflowRun).toHaveBeenCalledTimes(ownershipReads);
    expect(getRepoWorkflowRun).toHaveBeenCalledTimes(statusReads);
    expect(client.getQueryData(['repo-workflow-run', 'demo', 'trial'])).toEqual(
      completeA,
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['repo-workflow-current', 'demo'],
      });
    });
    await flushDiscovery();
    expect(container.textContent).toContain('Running B');
    expect(container.textContent).not.toContain('Old receipt A');
    expect(button('Test setup and validation').disabled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
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
it('observes terminal ownership until the server unlocks and enables another test without remounting', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
    await render();
    const initialReads = vi.mocked(getCurrentRepoWorkflowRun).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(getCurrentRepoWorkflowRun).toHaveBeenCalledTimes(initialReads);
    const complete: RepoWorkflowRun = {
      ...run(),
      status: 'passed',
      phase: 'complete',
      cleanup: 'complete',
    };
    vi.mocked(getRepoWorkflowRun).mockResolvedValue(complete);
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: complete });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(container.textContent).toContain('Setup and checks passed');
    expect(button('Test setup and validation').disabled).toBe(true);
    expect(button('Refresh test ownership')).toBeTruthy();
    const terminalReads = vi.mocked(getCurrentRepoWorkflowRun).mock.calls
      .length;
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(
      vi.mocked(getCurrentRepoWorkflowRun).mock.calls.length,
    ).toBeGreaterThan(terminalReads);
    expect(button('Test setup and validation').disabled).toBe(false);
    expect(container.textContent).toContain('Setup and checks passed');
    expect(container.textContent).not.toContain('Waiting for the server');
    const unlockedReads = vi.mocked(getCurrentRepoWorkflowRun).mock.calls
      .length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(getCurrentRepoWorkflowRun).toHaveBeenCalledTimes(unlockedReads);
    expect(startRepoWorkflowRun).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it('stops ownership polling on error and retains the final result until explicit retry succeeds', async () => {
  vi.useFakeTimers();
  try {
    const complete: RepoWorkflowRun = {
      ...run(),
      status: 'passed',
      phase: 'complete',
      cleanup: 'complete',
    };
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: complete });
    vi.mocked(getRepoWorkflowRun).mockResolvedValue(complete);
    await render();
    await flushDiscovery();
    vi.mocked(getCurrentRepoWorkflowRun).mockRejectedValue(
      new Error('Server unavailable'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(container.textContent).toContain(
      'Could not check for an existing test',
    );
    expect(container.textContent).toContain('Setup and checks passed');
    expect(button('Test setup and validation').disabled).toBe(true);
    const failedReads = vi.mocked(getCurrentRepoWorkflowRun).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getCurrentRepoWorkflowRun).toHaveBeenCalledTimes(failedReads);
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
    await click('Retry test discovery');
    expect(button('Test setup and validation').disabled).toBe(false);
    expect(container.textContent).toContain('Setup and checks passed');
  } finally {
    vi.useRealTimers();
  }
});
it('refreshes terminal run status to recover a dead controller lock even when terminal data stays unchanged', async () => {
  const complete: RepoWorkflowRun = {
    ...run(),
    status: 'passed',
    phase: 'complete',
    cleanup: 'complete',
  };
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: complete });
  vi.mocked(getRepoWorkflowRun).mockResolvedValue(complete);
  await render();
  await flushDiscovery();
  expect(button('Test setup and validation').disabled).toBe(true);
  // A read-only ownership refresh cannot release the dead controller's lock.
  await click('Refresh test ownership');
  expect(button('Test setup and validation').disabled).toBe(true);
  vi.mocked(getCurrentRepoWorkflowRun).mockRejectedValue(
    new Error('Server unavailable'),
  );
  await click('Refresh test ownership');
  expect(container.textContent).toContain(
    'Could not check for an existing test',
  );
  const reads = vi.mocked(getRepoWorkflowRun).mock.calls.length;
  vi.mocked(getRepoWorkflowRun).mockImplementation(async () => {
    // getRun recovery releases ownership but returns identical terminal data.
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
    return complete;
  });
  await click('Refresh test status');
  expect(getRepoWorkflowRun).toHaveBeenCalledTimes(reads + 1);
  expect(getRepoWorkflowRun).toHaveBeenLastCalledWith(
    'demo',
    'trial',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(button('Test setup and validation').disabled).toBe(false);
  expect(container.textContent).toContain('Setup and checks passed');
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('ignores a delayed prior-run status refresh and retains the new run through unlock until its final result', async () => {
  vi.useFakeTimers();
  try {
    const completeA: RepoWorkflowRun = {
      ...run(),
      status: 'passed',
      phase: 'complete',
      cleanup: 'complete',
      guidance: 'Result A',
    };
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: completeA });
    vi.mocked(getRepoWorkflowRun).mockResolvedValue(completeA);
    await render();
    await flushDiscovery();
    let finishA!: (value: RepoWorkflowRun) => void;
    vi.mocked(getRepoWorkflowRun).mockReturnValueOnce(
      new Promise((resolve) => {
        finishA = resolve;
      }),
    );
    await click('Refresh test status');
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(button('Test setup and validation').disabled).toBe(false);
    const activeB = { ...run(), runId: 'trial-b', guidance: 'Running B' };
    vi.mocked(startRepoWorkflowRun).mockResolvedValue(activeB);
    let finishB!: (value: RepoWorkflowRun) => void;
    vi.mocked(getRepoWorkflowRun).mockReturnValue(
      new Promise((resolve) => {
        finishB = resolve;
      }),
    );
    await click('Test setup and validation');
    expect(container.textContent).toContain('Running B');
    const ownershipReads = vi.mocked(getCurrentRepoWorkflowRun).mock.calls
      .length;
    await act(async () => finishA(completeA));
    await flushDiscovery();
    expect(getCurrentRepoWorkflowRun).toHaveBeenCalledTimes(ownershipReads);
    // B's lock disappears before its final status response is collected.
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['repo-workflow-current', 'demo'],
      });
    });
    await flushDiscovery();
    expect(container.textContent).toContain('Running B');
    expect(container.textContent).not.toContain('Result A');
    expect(button('Test setup and validation').disabled).toBe(true);
    await act(async () =>
      finishB({
        ...activeB,
        status: 'passed',
        phase: 'complete',
        cleanup: 'complete',
        guidance: 'Final result B',
      }),
    );
    await flushDiscovery();
    expect(container.textContent).toContain('Final result B');
    expect(button('Test setup and validation').disabled).toBe(false);
    expect(startRepoWorkflowRun).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it('restores a running test after remount with progress and cancellation', async () => {
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
  await render();
  expect(container.textContent).toContain('Setting up repository');
  expect(button('Test setup and validation').disabled).toBe(true);
  await act(async () => root.render(null));
  await render();
  expect(button('Cancel test')).toBeTruthy();
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
  vi.mocked(cancelRepoWorkflowRun).mockResolvedValue({
    ...run(),
    status: 'cancelled',
  });
  await click('Cancel test');
  expect(cancelRepoWorkflowRun).toHaveBeenCalledWith('demo', 'trial');
});
it('blocks discovery pending, failure and retained uncertain runs without losing drafts', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(getCurrentRepoWorkflowRun).mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  await render();
  expect(button('Test setup and validation').disabled).toBe(true);
  await click('Add profile');
  await act(async () => reject(new Error('Unsafe lock')));
  await flushDiscovery();
  expect(container.textContent).toContain(
    'Could not check for an existing test',
  );
  expect(container.textContent).toContain('Profile 2');
  const uncertain: RepoWorkflowRun = {
    ...run(),
    status: 'uncertain',
    phase: 'complete',
    cleanup: 'retained',
    guidance: 'Inspect retained checkout',
  };
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: uncertain });
  vi.mocked(getRepoWorkflowRun).mockResolvedValue(uncertain);
  await click('Retry test discovery');
  expect(container.textContent).toContain('Inspect retained checkout');
  expect(container.textContent).toContain('Profile 2');
  expect(button('Test setup and validation').disabled).toBe(true);
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('discovers an owned test after a lost start response without showing a request failure or allowing a duplicate', async () => {
  await render();
  vi.mocked(startRepoWorkflowRun).mockImplementation(async () => {
    vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
    throw new Error('Request failed');
  });
  await click('Test setup and validation');
  expect(container.textContent).toContain('Setting up repository');
  expect(container.textContent).not.toContain('Request failed');
  expect(button('Test setup and validation').disabled).toBe(true);
  await click('Test setup and validation');
  expect(startRepoWorkflowRun).toHaveBeenCalledOnce();
});
it.each(['absent', 'failed'] as const)(
  'preserves the start error when recovery discovery is %s',
  async (recovery) => {
    await render();
    vi.mocked(startRepoWorkflowRun).mockImplementation(async () => {
      if (recovery === 'failed')
        vi.mocked(getCurrentRepoWorkflowRun).mockRejectedValue(
          new Error('Discovery unavailable'),
        );
      throw new Error('Request failed');
    });
    await click('Test setup and validation');
    expect(container.textContent).toContain('Request failed');
    expect(container.textContent).not.toContain('Setting up repository');
    expect(startRepoWorkflowRun).toHaveBeenCalledOnce();
    expect(button('Test setup and validation').disabled).toBe(
      recovery === 'failed',
    );
  },
);
it('rechecks ownership on click and restores a concurrently started run instead of starting another', async () => {
  await render();
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
  await click('Test setup and validation');
  expect(container.textContent).toContain('Setting up repository');
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('keeps late repository discovery scoped and preserves drafts when switching back', async () => {
  let resolveFirst!: (result: { run: RepoWorkflowRun | null }) => void;
  vi.mocked(getRepoWorkflows).mockImplementation(async (repoId) => ({
    ...snapshot(),
    repoId,
  }));
  vi.mocked(getCurrentRepoWorkflowRun).mockImplementation(async (repoId) =>
    repoId === 'demo'
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : { run: null },
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryRepoWorkflows
          repos={[
            { id: 'demo', name: 'Demo' },
            { id: 'other', name: 'Other' },
          ]}
        />
      </QueryClientProvider>,
    ),
  );
  await flushDiscovery();
  await click('Add profile');
  const selector = container.querySelector('select')!;
  await act(async () => {
    selector.value = 'other';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushDiscovery();
  await act(async () => resolveFirst({ run: run() }));
  await flushDiscovery();
  const visible = container.querySelector(
    '#factory-repo-workflows > div:not([hidden])',
  );
  expect(visible?.textContent).not.toContain('Setting up repository');
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
  await act(async () => {
    selector.value = 'demo';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushDiscovery();
  expect(
    container.querySelector('#factory-repo-workflows > div:not([hidden])')
      ?.textContent,
  ).toContain('Profile 2');
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('does not let an older discovery response erase a newly accepted test', async () => {
  await render();
  let accept!: (value: RepoWorkflowRun) => void;
  vi.mocked(startRepoWorkflowRun).mockReturnValue(
    new Promise((resolve) => {
      accept = resolve;
    }),
  );
  await click('Test setup and validation');
  let resolveOld!: (value: { run: RepoWorkflowRun | null }) => void;
  vi.mocked(getCurrentRepoWorkflowRun).mockReturnValue(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  let refresh!: Promise<unknown>;
  await act(async () => {
    refresh = client.refetchQueries({
      queryKey: ['repo-workflow-current', 'demo'],
    });
  });
  await act(async () => accept(run()));
  await flushDiscovery();
  await act(async () => {
    resolveOld({ run: null });
    await refresh;
  });
  await flushDiscovery();
  expect(container.textContent).toContain('Setting up repository');
  expect(button('Test setup and validation').disabled).toBe(true);
  expect(startRepoWorkflowRun).toHaveBeenCalledOnce();
});
it('retains transient uncertain status over persisted running discovery and explicitly refreshes recovery', async () => {
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: run() });
  const uncertain: RepoWorkflowRun = {
    ...run(),
    status: 'uncertain',
    cleanup: 'retained',
    guidance: 'Controller liveness is unknown.',
  };
  vi.mocked(getRepoWorkflowRun).mockResolvedValue(uncertain);
  await render();
  await flushDiscovery();
  expect(container.textContent).toContain('Controller liveness is unknown.');
  expect(button('Refresh test ownership')).toBeTruthy();
  expect(button('Refresh test status')).toBeTruthy();
  await click('Refresh test ownership');
  expect(container.textContent).toContain('This test has a retained checkout');
  expect(button('Test setup and validation').disabled).toBe(true);
  const reads = vi.mocked(getRepoWorkflowRun).mock.calls.length;
  vi.mocked(getRepoWorkflowRun).mockResolvedValue({
    ...run(),
    status: 'cancelled',
    phase: 'complete',
    cleanup: 'complete',
  });
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
  await click('Refresh test status');
  await flushDiscovery();
  expect(vi.mocked(getRepoWorkflowRun).mock.calls.length).toBeGreaterThan(
    reads,
  );
  expect(container.textContent).toContain('cleaned up');
  expect(container.textContent).not.toContain(
    'This test has a retained checkout',
  );
  expect(button('Test setup and validation').disabled).toBe(false);
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('retains a discovered run across repo switching when ownership disappears before final status arrives', async () => {
  vi.mocked(getRepoWorkflows).mockImplementation(async (repoId) => ({
    ...snapshot(),
    repoId,
  }));
  vi.mocked(getCurrentRepoWorkflowRun).mockImplementation(async (repoId) => ({
    run: repoId === 'demo' ? run() : null,
  }));
  let finish!: (value: RepoWorkflowRun) => void;
  vi.mocked(getRepoWorkflowRun).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryRepoWorkflows
          repos={[
            { id: 'demo', name: 'Demo' },
            { id: 'other', name: 'Other' },
          ]}
        />
      </QueryClientProvider>,
    ),
  );
  await flushDiscovery();
  const selector = container.querySelector('select')!;
  await act(async () => {
    selector.value = 'other';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushDiscovery();
  vi.mocked(getCurrentRepoWorkflowRun).mockResolvedValue({ run: null });
  await act(async () => {
    selector.value = 'demo';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushDiscovery();
  const visible = () =>
    container.querySelector('#factory-repo-workflows > div:not([hidden])')!;
  expect(visible().textContent).toContain('Setting up repository');
  expect(
    Array.from(visible().querySelectorAll('button')).find(
      (item) => item.textContent === 'Test setup and validation',
    )?.disabled,
  ).toBe(true);
  await act(async () =>
    finish({
      ...run(),
      status: 'passed',
      phase: 'complete',
      cleanup: 'complete',
      guidance: 'Final result from discovered trial A.',
    }),
  );
  await flushDiscovery();
  expect(visible().textContent).toContain(
    'Final result from discovered trial A.',
  );
  expect(visible().textContent).toContain('cleaned up');
  expect(startRepoWorkflowRun).not.toHaveBeenCalled();
});
it('restores incomplete profile commands and runtime edits with the original base after remount', async () => {
  const saved = snapshot();
  const draft = structuredClone(saved.workflows!);
  draft.profiles.push({
    ...draft.profiles[0],
    id: 'nested',
    name: 'Nested draft',
    setupCommands: [{ command: '', cwd: 'extension' }],
    runtime: { node: '>=28' },
    environmentRefs: ['BUILD_TOKEN'],
  });
  writeWorkflowDraft('demo', {
    version: 1,
    base: saved,
    draft,
    profileIndex: 1,
    proposal: null,
  });
  await render();
  expect(container.querySelector('input')?.value).toBe('nested');
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(container.textContent).toContain('Unsaved changes');
  await click('Add setup command');
  await act(async () => root.render(null));
  const changed = snapshot();
  changed.fingerprint = 'c'.repeat(64);
  await render(changed);
  expect(container.querySelector('input')?.value).toBe('nested');
  expect(
    container
      .querySelectorAll('.workflow-commands')[0]
      .querySelectorAll('textarea'),
  ).toHaveLength(2);
  expect(container.textContent).toContain('Saved settings changed elsewhere');
  expect(button('Save workflow').disabled).toBe(true);
  expect(button('Test setup and validation').disabled).toBe(true);
  const restored = readWorkflowDraft('demo');
  expect(restored.status).toBe('loaded');
  if (restored.status !== 'loaded') throw new Error('Draft missing');
  expect(restored.value.base.fingerprint).toBe('a'.repeat(64));
  expect(restored.value.draft?.profiles[1].runtime.node).toBe('>=28');
});
it('persists generated suggestions and adopted edits, clearing only after save or explicit discard', async () => {
  await render();
  const proposed = snapshot().workflows!;
  proposed.profiles[0].name = 'Suggested pnpm profile';
  vi.mocked(proposeRepoWorkflows).mockResolvedValue({
    ...snapshot(),
    proposal: {
      workflows: proposed,
      rationale: 'Read lockfile',
      evidencePaths: ['pnpm-lock.yaml'],
      evidenceRevision: 'a'.repeat(40),
    },
  });
  await click('Ask Neon');
  await act(async () => root.render(null));
  await render();
  expect(container.textContent).toContain('Read lockfile');
  await click('Use suggestion');
  await act(async () => root.render(null));
  await render();
  expect(container.textContent).toContain('Suggested pnpm profile');
  vi.mocked(saveRepoWorkflows).mockRejectedValueOnce(new Error('Save failed'));
  await submit();
  expect(readWorkflowDraft('demo').status).toBe('loaded');
  vi.mocked(saveRepoWorkflows).mockImplementation(async (repoId, input) => ({
    repoId,
    fingerprint: 'b'.repeat(64),
    workflows: input.workflows,
  }));
  await submit();
  expect(readWorkflowDraft('demo').status).toBe('missing');
  await click('Add profile');
  expect(readWorkflowDraft('demo').status).toBe('loaded');
  await click('Load saved settings');
  expect(readWorkflowDraft('demo').status).toBe('missing');
});
it('isolates persisted drafts by repository across full remounts', async () => {
  await render();
  await click('Add profile');
  await act(async () => root.render(null));
  await render({ ...snapshot(), repoId: 'other' });
  expect(container.textContent).not.toContain('Profile 2');
  await click('Add profile');
  await click('Add profile');
  await act(async () => root.render(null));
  await render();
  expect(container.textContent).toContain('Profile 2');
  expect(container.textContent).not.toContain('Profile 3');
});
it('keeps corrupt drafts untouched until explicit discard and handles unavailable storage', async () => {
  sessionStorage.setItem(
    'factory-workflow-draft:demo',
    'sensitive invalid data',
  );
  await render();
  await click('Add profile');
  expect(container.textContent).toContain(
    'Browser draft could not be restored',
  );
  expect(container.textContent).not.toContain('sensitive invalid data');
  expect(sessionStorage.getItem('factory-workflow-draft:demo')).toBe(
    'sensitive invalid data',
  );
  await click('Load saved settings');
  expect(readWorkflowDraft('demo').status).toBe('missing');
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem').mockImplementation(
    () => {
      throw new Error('private storage details');
    },
  );
  await click('Add profile');
  expect(container.textContent).toContain(
    'Browser storage is unavailable or full',
  );
  expect(container.textContent).not.toContain('private storage details');
  expect(container.textContent).toContain('Profile 2');
});
