// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryPlanning } from './FactoryPlanning';
import { deliveryPlanningEvidence } from './FactoryDeliveryPlanningEvidence';
import { deliveryDetail } from './FactoryDelivery.fixtures';
import {
  emptyFactorySpec,
  type FactoryDetail,
} from '../../../../shared/factory';
const api = vi.hoisted(() => ({
  getFactoryPlanning: vi.fn(),
  sendFactoryPlanning: vi.fn(),
  retryFactoryTriage: vi.fn(),
  stopFactoryPlanning: vi.fn(),
  recoverFactoryPlanning: vi.fn(),
  refreshFactoryPlanningContext: vi.fn(),
}));
vi.mock('../../api/factory', () => api);
vi.mock('../flue-chat/components/session-view', () => ({
  FlueChatSessionView: ({
    onSendMessage,
  }: {
    onSendMessage: (message: string) => Promise<void>;
  }) => (
    <button
      onClick={() =>
        void onSendMessage('Please explain the scope change.').catch(() => {})
      }
    >
      Send planning message
    </button>
  ),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const detail = {
  work: { id: 'work-demo', version: 3, lifecycle: 'shaping' },
  revisions: [{ version: 3, spec: emptyFactorySpec() }],
} as FactoryDetail;
const evidence = deliveryPlanningEvidence(deliveryDetail('intervention'));
const clear = vi.fn();
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  sessionStorage.clear();
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = {
    sessionId: 'planning-demo',
    plannerStarted: true,
    contextStale: false,
    activity: 'completed',
    triage: null,
    error: null,
  };
  client.setQueryData(['factory-planning', 'work-demo'], state);
  api.getFactoryPlanning.mockResolvedValue(state);
  api.sendFactoryPlanning.mockResolvedValue({});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryPlanning
          detail={detail}
          deliveryEvidence={evidence}
          onClearDeliveryEvidence={clear}
        />
      </QueryClientProvider>,
    ),
  );
}
async function click(label: string) {
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === label)!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}
it('preserves unsent text and sends attached evidence only with the human message', async () => {
  sessionStorage.setItem(
    'factory-chat-draft:work-demo:planning-demo',
    'Please explain the scope change.',
  );
  await render();
  expect(api.sendFactoryPlanning).not.toHaveBeenCalled();
  expect(container.textContent).toContain('intervention-demo');
  expect(
    sessionStorage.getItem('factory-chat-draft:work-demo:planning-demo'),
  ).toBe('Please explain the scope change.');
  await click('Send planning message');
  expect(api.sendFactoryPlanning).toHaveBeenCalledWith(
    'work-demo',
    expect.objectContaining({
      message: `Please explain the scope change.\n\n${evidence}`,
      expectedVersion: 3,
    }),
  );
  expect(clear).toHaveBeenCalledOnce();
  expect(
    sessionStorage.getItem('factory-chat-draft:work-demo:planning-demo'),
  ).toBeNull();
});
it('retains evidence in the original immutable request after uncertain admission', async () => {
  api.sendFactoryPlanning.mockRejectedValue(new Error('Uncertain receipt'));
  await render();
  await click('Send planning message');
  await click('Retry original request');
  expect(api.sendFactoryPlanning).toHaveBeenCalledTimes(2);
  expect(api.sendFactoryPlanning.mock.calls[1]).toEqual(
    api.sendFactoryPlanning.mock.calls[0],
  );
  expect(clear).not.toHaveBeenCalled();
});
