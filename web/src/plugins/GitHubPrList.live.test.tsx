// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ApiModule = typeof import('../api');

const api = vi.hoisted(() => ({
  getGitHubPullRequests: vi.fn<ApiModule['getGitHubPullRequests']>(),
  getRepoRegistry: vi.fn<ApiModule['getRepoRegistry']>(),
}));

vi.mock('@flue/react', () => ({
  useFlueClient: () => ({
    workflows: {
      invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  }),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getGitHubPullRequests: api.getGitHubPullRequests,
  getRepoRegistry: api.getRepoRegistry,
}));

vi.mock('../lib/config-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/config-events')>()),
  useConfigEvents: vi.fn<() => void>(),
}));

import { GitHubPrListPlugin } from './GitHubPrList';

describe('GitHubPrList server snapshot', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    api.getGitHubPullRequests.mockResolvedValue(queue([pullRequest()]));
    api.getRepoRegistry.mockResolvedValue({
      home: '/tmp/neondeck',
      path: '/tmp/neondeck/repos.json',
      repos: [],
      count: 0,
      fetchedAt: '2026-07-23T20:00:00.000Z',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not independently poll GitHub while the panel stays mounted', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const Component = GitHubPrListPlugin.Component;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Component
            config={{ limit: 12 }}
            region={{
              id: 'github',
              title: 'GitHub',
              column: 1,
              row: 1,
              columnSpan: 1,
              rowSpan: 1,
              tabs: [],
            }}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(container.textContent).toContain('New pull request');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(api.getGitHubPullRequests).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('1 PR · 1 REPOS');
  });
});

function queue(items: ReturnType<typeof pullRequest>[]) {
  return {
    login: 'pandemicsyn',
    repos: ['pandemicsyn/neondeck'],
    items,
    fetchedAt: '2026-07-23T20:00:00.000Z',
    truncated: false,
    issues: [],
  };
}

function pullRequest() {
  return {
    id: 4732,
    title: 'New pull request',
    repo: 'pandemicsyn/neondeck',
    number: 4732,
    url: 'https://github.com/pandemicsyn/neondeck/pull/4732',
    state: 'open' as const,
    author: 'pandemicsyn',
    labels: [],
    comments: 0,
    updatedAt: '2026-07-23T20:00:00.000Z',
    createdAt: '2026-07-23T20:00:00.000Z',
    relations: ['authored' as const],
    ageDays: 0,
    stale: false,
    draft: false,
    headSha: 'head-4732',
    baseRef: 'main',
    checks: null,
  };
}
