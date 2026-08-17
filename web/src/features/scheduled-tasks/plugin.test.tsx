// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskEditor, WorkspaceIdentity } from './plugin';

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('scheduled task editor', () => {
  it('shows exact canonical repository and provider resource identity', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <WorkspaceIdentity
          workspace={{
            id: 'workspace:1',
            providerId: 'build-box',
            providerResourceId: 'canonical-resource-17',
            repoId: 'repo-config-id',
            repoSnapshot: {
              verified: true,
              id: 'repo-config-id',
              github: { owner: 'example', name: 'project' },
              path: '/src/project',
              defaultBranch: 'main',
            },
            lifecycle: 'reuse-task',
            workspaceRoot: '/workspaces/project',
            requestedRef: 'main',
            branchName: 'neondeck/schedules/test',
            baseSha: null,
            finalSha: null,
            dirty: null,
            authority: 'trusted-workspace',
            status: 'retained',
            lockOwner: null,
            lockExpiresAt: null,
            retentionReason: null,
            providerError: null,
          }}
        />,
      );
    });
    expect(container.textContent).toContain('example/project');
    expect(container.textContent).toContain('repo-config-id');
    expect(container.textContent).toContain('canonical-resource-17');
    expect(container.textContent).toContain('build-box');
  });

  it('defaults repository tasks to the local workspace provider', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const readiness = {
      ready: true,
      message: 'ready',
      missingEnvironment: [],
    };
    act(() => {
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskEditor
            repos={[{ id: 'repo', defaultBranch: 'main' }]}
            defaultProviderId="local"
            providers={[
              {
                descriptor: { id: 'exe.dev', label: 'exe.dev' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
              {
                descriptor: { id: 'local', label: 'Local' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
            ]}
            onCreated={() => undefined}
          />
        </QueryClientProvider>,
      );
    });

    expect(
      (
        container.querySelector(
          'select[name="providerId"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('local');
  });

  it('offers the configured default remote without replacing the local default', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const readiness = { ready: true, message: 'ready', missingEnvironment: [] };
    act(() => {
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskEditor
            repos={[{ id: 'repo', defaultBranch: 'main' }]}
            defaultProviderId="local"
            defaultRemoteProviderId="build-box"
            providers={[
              {
                descriptor: { id: 'local', label: 'Local' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
              {
                descriptor: { id: 'build-box', label: 'Build box' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
            ]}
            onCreated={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
    const provider = container.querySelector(
      'select[name="providerId"]',
    ) as HTMLSelectElement;
    expect(provider.value).toBe('local');
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Use default remote'),
    );
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(provider.value).toBe('build-box');
    expect(provider.selectedOptions[0]?.textContent).toContain(
      'default remote',
    );
  });

  it('submits stable hidden advanced defaults without null strings', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ ok: true, changed: true, message: 'created' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const readiness = { ready: true, message: 'ready', missingEnvironment: [] };
    await act(async () => {
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskEditor
            repos={[{ id: 'repo', defaultBranch: 'main' }]}
            defaultProviderId="local"
            providers={[
              {
                descriptor: { id: 'local', label: 'Local' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
            ]}
            onCreated={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
    const prompt = container.querySelector(
      'textarea[name="prompt"]',
    ) as HTMLTextAreaElement;
    prompt.value = 'Run tests';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workspace: {
        resource: { lifecycle: 'per-run' },
        overlap: 'skip',
      },
    });
    expect(JSON.stringify(requests[0])).not.toContain('null');
  });

  it('keeps persistent task branches continuation-only and exposes full pinned SHA input', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const readiness = {
      ready: true,
      message: 'ready',
      missingEnvironment: [],
    };
    act(() => {
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskEditor
            repos={[{ id: 'repo', defaultBranch: 'main' }]}
            defaultProviderId="local"
            providers={[
              {
                descriptor: { id: 'local', label: 'Local' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
            ]}
            onCreated={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
    const git = container.querySelector(
      'select[name="gitMode"]',
    ) as HTMLSelectElement;
    const revision = container.querySelector(
      'select[name="revisionMode"]',
    ) as HTMLSelectElement;
    const lifecycle = container.querySelector(
      'select[name="lifecycle"]',
    ) as HTMLSelectElement;
    act(() => {
      git.value = 'task-branch';
      git.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(revision.value).toBe('continue');
    expect(lifecycle.value).toBe('reuse-task');
    expect(Array.from(revision.options).map((option) => option.value)).toEqual([
      'continue',
    ]);
    act(() => {
      git.value = 'run-branch';
      git.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(revision.value).toBe('latest-each-run');
    act(() => {
      revision.value = 'pinned';
      revision.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('input[name="sha"]')).toMatchObject({
      required: true,
      minLength: 40,
      maxLength: 64,
    });
    act(() => {
      git.value = 'direct-branch';
      git.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(lifecycle.value).toBe('reuse-task');
    act(() => {
      lifecycle.value = 'per-run';
      lifecycle.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(git.value).toBe('run-branch');
  });

  it('requires explicit confirmation when recurring shell authority is selected', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const readiness = { ready: true, message: 'ready', missingEnvironment: [] };
    act(() => {
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskEditor
            repos={[{ id: 'repo', defaultBranch: 'main' }]}
            defaultProviderId="local"
            providers={[
              {
                descriptor: { id: 'local', label: 'Local' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
            ]}
            onCreated={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
    const authority = container.querySelector(
      'select[name="authority"]',
    ) as HTMLSelectElement;
    expect(container.querySelector('input[name="confirm"]')).toBeNull();
    act(() => {
      authority.value = 'trusted-workspace';
      authority.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('input[name="confirm"]')).toMatchObject({
      required: true,
    });
  });

  it('resets the target ref when repository selection changes', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const readiness = { ready: true, message: 'ready', missingEnvironment: [] };
    act(() => {
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskEditor
            repos={[
              { id: 'first', defaultBranch: 'main' },
              { id: 'second', defaultBranch: 'develop' },
            ]}
            defaultProviderId="local"
            providers={[
              {
                descriptor: { id: 'local', label: 'Local' },
                readiness,
                readinessByLifecycle: {
                  'per-run': readiness,
                  'reuse-task': readiness,
                  existing: readiness,
                },
              },
            ]}
            onCreated={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
    const repository = container.querySelector(
      'select[name="repoId"]',
    ) as HTMLSelectElement;
    const targetRef = container.querySelector(
      'input[name="ref"]',
    ) as HTMLInputElement;
    expect(targetRef.value).toBe('main');
    act(() => {
      targetRef.value = 'release';
      targetRef.dispatchEvent(new Event('input', { bubbles: true }));
      targetRef.dispatchEvent(new Event('change', { bubbles: true }));
      repository.value = 'second';
      repository.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(repository.value).toBe('second');
    expect(targetRef.value).toBe('develop');
  });
});
