// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryPage } from './FactoryPage';
import {
  emptyFactorySpec,
  factoryDetailSchema,
} from '../../../../shared/factory';
import * as v from 'valibot';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  sessionStorage.clear();
  history.replaceState(null, '', '/factory');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryPage />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
it('explains disabled mode, then enables real typed intake config', async () => {
  let enabled = false;
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, options) => {
      if (url === '/api/factory/config') {
        enabled = true;
        return response({
          enabled,
          github: [],
          codingPolicy: 'isolated-local-v1',
        });
      }
      expect(options?.method).toBeUndefined();
      return response({
        enabled,
        policy: 'isolated-local-v1',
        repos: [],
        items: [],
      });
    });
  await render();
  expect(container.textContent).toContain('Factory is disabled');
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Enable manual intake')!
      .click(),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(container.textContent).toContain('No tasks yet');
  expect(fetch).toHaveBeenCalledWith(
    '/api/factory/config',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        codingPolicy: 'isolated-local-v1',
      }),
    }),
  );
});
it('shows recoverable read failure with retry', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    response({ error: 'Synthetic API unavailable' }, 503),
  );
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Factory unavailable',
  );
  expect(
    [...container.querySelectorAll('button')].some(
      (b) => b.textContent === 'Retry',
    ),
  ).toBe(true);
});
it('retains editor text and its expected versions after a stale save', async () => {
  const detail = fixture();
  const { work } = detail;
  const revision = detail.revisions[0];
  history.replaceState(null, '', '/factory?task=task-1');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) => {
      if (url === '/api/factory/state')
        return response({
          enabled: true,
          policy: 'isolated-local-v1',
          repos: [],
          items: [work],
        });
      if (String(url).endsWith('/spec'))
        return response(
          { error: 'Task changed. Review the latest version before retrying.' },
          409,
        );
      return response(detail);
    });
  await render();
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Edit draft')!
      .click(),
  );
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Your local draft is preserved',
  );
  expect(container.querySelector('textarea')?.value).toBe(
    'My retained local draft',
  );
  expect(fetch).toHaveBeenCalledWith(
    '/api/factory/work/task-1/spec',
    expect.objectContaining({
      body: JSON.stringify({
        expectedVersion: 1,
        expectedSpecVersion: 1,
        expectedRepoFingerprint: null,
        spec: revision.spec,
      }),
    }),
  );
});

function fixture() {
  const work = {
    id: 'task-1',
    sourceId: 'source-1',
    title: 'Synthetic task',
    repoId: null,
    lifecycle: 'inbox',
    version: 1,
    specVersion: 1,
    createdAt: '2026-09-05',
    updatedAt: '2026-09-05',
  };
  const source = {
    id: 'source-1',
    provider: 'manual',
    requestKey: 'request-1',
    requestHash: 'a'.repeat(64),
    title: work.title,
    body: 'Outcome',
    repoId: null,
    version: 1,
    status: 'open',
    actor: 'local-operator',
    createdAt: '2026-09-05',
  };
  const revision = {
    workId: work.id,
    version: 1,
    parentVersion: null,
    spec: { ...emptyFactorySpec(), outcome: 'My retained local draft' },
    hash: 'b'.repeat(64),
    sourceVersion: 1,
    repoFingerprint: null,
    repoContext: null,
    authorKind: 'human',
    actor: 'local-operator',
    createdAt: '2026-09-05',
  };
  return v.parse(factoryDetailSchema, {
    work,
    source,
    revisions: [revision],
    releases: [],
    blockers: ['Select a registered repository.'],
    eligible: false,
    repoFingerprint: null,
    repoContext: null,
  });
}

function button(text: string) {
  return [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
function fill(selector: string, value: string) {
  const field = container.querySelector(selector) as
    HTMLInputElement | HTMLTextAreaElement;
  const prototype =
    field.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}
it('keeps cached draft and source editors mounted through inbox and task refresh failures', async () => {
  const detail = fixture();
  let failing = false;
  history.replaceState(null, '', '/factory?task=task-1');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (failing) return response({ error: 'Synthetic refresh outage' }, 503);
    return response(
      url === '/api/factory/state'
        ? {
            enabled: true,
            policy: 'isolated-local-v1',
            repos: [],
            items: [detail.work],
          }
        : detail,
    );
  });
  await render();
  await act(async () => button('Edit draft').click());
  act(() => {
    fill('textarea', 'Unsaved draft survives refresh');
    fill('textarea[name="body"]', 'Unsaved source survives refresh');
  });
  failing = true;
  await act(async () => {
    await client.refetchQueries({ queryKey: ['factory-state'] });
    await client.refetchQueries({ queryKey: ['factory-detail'] });
  });
  await flush();
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(container.textContent).toContain('Your local draft is preserved');
  expect(container.textContent).toContain('Inbox refresh failed');
  expect(container.textContent).toContain('Task refresh failed');
  expect(container.querySelector('textarea')?.value).toBe(
    'Unsaved draft survives refresh',
  );
  expect(
    (container.querySelector('textarea[name="body"]') as HTMLTextAreaElement)
      .value,
  ).toBe('Unsaved source survives refresh');
});
it('pins all source values before focus and explicitly reloads after a stale source save', async () => {
  const original = fixture();
  let current = structuredClone(original);
  let sent: unknown;
  history.replaceState(null, '', '/factory?task=task-1');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).endsWith('/source')) {
      sent = JSON.parse(String(options?.body));
      return (sent as { expectedVersion: number }).expectedVersion ===
        current.work.version
        ? response(current)
        : response({ error: 'Task changed' }, 409);
    }
    return response(
      url === '/api/factory/state'
        ? {
            enabled: true,
            policy: 'isolated-local-v1',
            repos: [{ id: 'other', name: 'example/other' }],
            items: [current.work],
          }
        : current,
    );
  });
  await render();
  current = {
    ...current,
    work: { ...current.work, version: 2, repoId: 'other' },
    source: {
      ...current.source,
      version: 2,
      title: 'Remote source title',
      body: 'Remote source body',
      repoId: 'other',
    },
  };
  await act(async () => {
    await client.refetchQueries({ queryKey: ['factory-detail'] });
  });
  await flush();
  expect(
    (container.querySelector('.factory-source select') as HTMLSelectElement)
      .value,
  ).toBe('');
  expect(container.textContent).toContain('Your local edits are retained');
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(sent).toEqual({
    expectedVersion: 1,
    title: original.source.title,
    body: original.source.body,
    repoId: null,
  });
  expect(
    (container.querySelector('input[name="title"]') as HTMLInputElement).value,
  ).toBe(original.source.title);
  await act(async () =>
    button('Reload current source (discard local edits)').click(),
  );
  expect(
    (container.querySelector('.factory-source select') as HTMLSelectElement)
      .value,
  ).toBe('other');
  expect(
    (container.querySelector('input[name="title"]') as HTMLInputElement).value,
  ).toBe('Remote source title');
  act(() => fill('textarea[name="body"]', 'Reconciled source after reload'));
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(sent).toEqual({
    expectedVersion: 2,
    title: 'Remote source title',
    body: 'Reconciled source after reload',
    repoId: 'other',
  });
});
it('keeps the reviewed repo fingerprint pinned until an explicit context review', async () => {
  let current = fixture();
  current.repoFingerprint = 'a'.repeat(64);
  current.revisions[0].repoFingerprint = current.repoFingerprint;
  current.repoContext = {
    path: '/private/tmp/synthetic-original',
    defaultBranch: 'main',
    commands: { check: 'npm run check' },
  };
  let sent: unknown;
  history.replaceState(null, '', '/factory?task=task-1');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).endsWith('/spec')) {
      sent = JSON.parse(String(options?.body));
      return (sent as { expectedRepoFingerprint: string })
        .expectedRepoFingerprint === current.repoFingerprint
        ? response(current)
        : response({ error: 'Repository configuration changed' }, 409);
    }
    return response(
      url === '/api/factory/state'
        ? {
            enabled: true,
            policy: 'isolated-local-v1',
            repos: [],
            items: [current.work],
          }
        : current,
    );
  });
  await render();
  await act(async () => button('Edit draft').click());
  act(() => fill('textarea', 'My text survives context review'));
  current = {
    ...current,
    repoFingerprint: 'b'.repeat(64),
    repoContext: {
      path: '/private/tmp/synthetic-replacement',
      defaultBranch: 'next',
      commands: { check: 'npm run test' },
    },
  };
  await act(async () => {
    await client.refetchQueries({ queryKey: ['factory-detail'] });
  });
  await flush();
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(sent).toMatchObject({ expectedRepoFingerprint: 'a'.repeat(64) });
  expect(container.textContent).toContain('Repository configuration changed');
  expect(container.textContent).toContain('/private/tmp/synthetic-replacement');
  await act(async () => button('Use this reviewed repository context').click());
  expect(container.querySelector('textarea')?.value).toBe(
    'My text survives context review',
  );
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(sent).toMatchObject({
    expectedRepoFingerprint: 'b'.repeat(64),
    spec: { outcome: 'My text survives context review' },
  });
});

it.each(['source', 'spec'] as const)(
  'disables %s editing controls until its pending save settles',
  async (action) => {
    const detail = fixture();
    let settle: ((response: Response) => void) | undefined;
    let submitted: Record<string, unknown> | undefined;
    history.replaceState(null, '', '/factory?task=task-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url).endsWith('/' + action)) {
        submitted = JSON.parse(String(options?.body));
        return new Promise<Response>((resolve) => {
          settle = resolve;
        });
      }
      return response(
        url === '/api/factory/state'
          ? {
              enabled: true,
              policy: 'isolated-local-v1',
              repos: [],
              items: [detail.work],
            }
          : detail,
      );
    });
    await render();
    if (action === 'spec') await act(async () => button('Edit draft').click());
    const selector = action === 'source' ? 'textarea[name="body"]' : 'textarea';
    act(() => fill(selector, 'Submitted text stays safe while pending'));
    const field = container.querySelector(selector) as HTMLTextAreaElement;
    await act(async () =>
      field
        .closest('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(settle).toBeTypeOf('function');
    expect(field.matches(':disabled')).toBe(true);
    const form = field.closest('form')!;
    for (const control of form.querySelectorAll('input,textarea,select,button'))
      expect(control.matches(':disabled')).toBe(true);
    expect(
      action === 'source'
        ? submitted?.body
        : (submitted?.spec as { outcome: string }).outcome,
    ).toBe('Submitted text stays safe while pending');
    await act(async () =>
      settle!(response({ error: 'Synthetic save failed' }, 503)),
    );
    expect(field.matches(':disabled')).toBe(false);
    expect(field.value).toBe('Submitted text stays safe while pending');
  },
);

it.each(['success', 'failure'] as const)(
  'protects the submitted intake snapshot through deferred %s',
  async (outcome) => {
    const detail = fixture();
    let settle: ((response: Response) => void) | undefined;
    const submitted: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (options?.method === 'POST') {
        submitted.push(JSON.parse(String(options.body)));
        return new Promise<Response>((resolve) => {
          settle = resolve;
        });
      }
      return response(
        url === '/api/factory/state'
          ? {
              enabled: true,
              policy: 'isolated-local-v1',
              repos: [{ id: 'demo', name: 'Synthetic repo' }],
              items: [detail.work],
            }
          : detail,
      );
    });
    await render();
    act(() => {
      fill('input[name="title"]', 'Submitted title');
      fill('textarea[name="body"]', 'Submitted outcome');
      (
        container.querySelector('select[name="repoId"]') as HTMLSelectElement
      ).value = 'demo';
    });
    const form = container.querySelector('form')!;
    const send = () =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    await act(async () => {
      send();
    });
    expect(settle).toBeTypeOf('function');
    for (const control of form.querySelectorAll('input,textarea,select,button'))
      expect(control.matches(':disabled')).toBe(true);
    expect(button('New task').disabled).toBe(true);
    const existingTask = container.querySelector(
      '.factory-inbox li button',
    ) as HTMLButtonElement;
    expect(existingTask.disabled).toBe(true);
    await act(async () => {
      button('New task').click();
      existingTask.click();
      send();
    });
    expect(container.querySelector('form')).toBe(form);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      title: 'Submitted title',
      body: 'Submitted outcome',
      repoId: 'demo',
    });
    await act(async () =>
      settle!(
        outcome === 'success'
          ? response(detail)
          : response({ error: 'Synthetic intake failed' }, 503),
      ),
    );
    await flush();
    expect(button('New task').disabled).toBe(false);
    if (outcome === 'failure') {
      expect(container.querySelector('form')).toBe(form);
      expect((form.elements.namedItem('title') as HTMLInputElement).value).toBe(
        'Submitted title',
      );
      expect(
        (form.elements.namedItem('body') as HTMLTextAreaElement).value,
      ).toBe('Submitted outcome');
      expect(
        (form.elements.namedItem('repoId') as HTMLSelectElement).value,
      ).toBe('demo');
      expect(container.textContent).toContain('Synthetic intake failed');
      for (const control of form.querySelectorAll(
        'input,textarea,select,button',
      ))
        expect(control.matches(':disabled')).toBe(false);
    } else {
      expect(location.search).toBe('?task=task-1');
      await act(async () => button('New task').click());
      expect(
        (container.querySelector('input[name="title"]') as HTMLInputElement)
          .value,
      ).toBe('');
    }
  },
);
