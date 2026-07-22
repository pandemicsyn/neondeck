// @vitest-environment jsdom

import type { UseFlueAgentResult } from '@flue/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrReviewRecord } from '../../api';
import { PrReviewReviewerChat } from './PrReviewReviewerChat';

const useFlueAgentMock = vi.hoisted(() =>
  vi.fn<(options: { name: string; id?: string }) => UseFlueAgentResult>(),
);

vi.mock('@flue/react', () => ({ useFlueAgent: useFlueAgentMock }));

describe('PrReviewReviewerChat', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useFlueAgentMock.mockReturnValue({
      messages: [],
      status: 'error',
      historyReady: false,
      error: new Error('History request failed.'),
      failedSends: [],
      sendMessage: vi.fn<UseFlueAgentResult['sendMessage']>(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useFlueAgentMock.mockReset();
  });

  it('scopes history to the reviewed revision and offers reconnect on failure', async () => {
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;

    act(() => root.render(<PrReviewReviewerChat review={review} />));

    expect(useFlueAgentMock).toHaveBeenLastCalledWith({
      name: 'pr-reviewer',
      id: `review-123@${'a'.repeat(40)}`,
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'History request failed.',
    );
    const reconnect = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reconnect',
    );
    expect(reconnect).toBeDefined();

    await act(async () => {
      reconnect?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(useFlueAgentMock.mock.calls.length).toBeGreaterThan(1);
  });
});
