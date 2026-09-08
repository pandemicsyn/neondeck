// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryLinearSource } from './FactoryLinearSource';
const api = vi.hoisted(() => ({
  getFactoryLinear: vi.fn(),
  syncFactoryLinearSource: vi.fn(),
}));
vi.mock('../../api/factory-linear', () => api);
const detail = {
  work: { id: 'work-one' },
  source: {
    provider: 'linear',
    body: 'External brief',
    version: 2,
    status: 'open',
    attention: 'Restore the original repository mapping.',
    linear: {
      connectionId: 'connection',
      identifier: 'ENG-42',
      issueId: 'issue',
      teamId: 'team',
      projectId: null,
      stateType: 'started',
      url: 'https://linear.app/example/issue/ENG-42',
    },
  },
} as Parameters<typeof FactoryLinearSource>[0]['detail'];
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.getFactoryLinear.mockResolvedValue({
    connections: [],
    sync: [],
    deliveries: [],
    writebacks: [
      {
        id: 'effect',
        workId: 'work-one',
        stateId: 'state',
        state: 'uncertain',
        error: 'Reconcile before retry.',
      },
      {
        id: 'other',
        workId: 'work-two',
        stateId: 'other-state',
        state: 'complete',
        error: null,
      },
    ],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryLinearSource detail={detail} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
it('shows source mapping attention and only selected-task writeback evidence', async () => {
  await render();
  expect(container.textContent).toContain('Linear issue ENG-42');
  expect(container.textContent).toContain(
    'Restore the original repository mapping.',
  );
  expect(container.textContent).toContain('Reconcile before retry.');
  expect(container.textContent).not.toContain('other-state');
  expect(container.querySelector('textarea')).toBeNull();
});
it('refreshes the task and inbox after accepted source sync', async () => {
  api.syncFactoryLinearSource.mockResolvedValue({ accepted: true });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await render();
  await act(async () => container.querySelector('button')!.click());
  expect(api.syncFactoryLinearSource).toHaveBeenCalledWith('work-one');
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['factory-detail', 'work-one'],
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['factory-state'] });
});
it('keeps source context visible when connection status fails', async () => {
  api.getFactoryLinear.mockRejectedValue(new Error('Unavailable'));
  await render();
  expect(container.textContent).toContain('External brief');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Linear connection status could not refresh',
  );
});
