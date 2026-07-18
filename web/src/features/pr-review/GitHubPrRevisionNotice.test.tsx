// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateReviewRefreshSafety } from '../../../../shared/review-refresh';
import { GitHubPrRevisionNotice } from './GitHubPrRevisionNotice';

describe('GitHubPrRevisionNotice', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the available head without implying that a stale local draft moved', async () => {
    const onApply = vi.fn<() => void>();
    await render(
      evaluateReviewRefreshSafety({
        activeSelection: true,
        staleDraft: true,
      }),
      onApply,
    );

    expect(container.getAttribute('aria-live')).toBeNull();
    expect(container.textContent).toContain('GitHub head head-b-');
    expect(container.textContent).toContain(
      'will not move or submit the local draft',
    );
    expect(container.textContent).toContain(
      'the local GitHub draft belongs to the older head',
    );
    const apply = button();
    expect(apply.disabled).toBe(false);
    await act(async () =>
      apply.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onApply).toHaveBeenCalledOnce();
  });

  it.each([
    ['dirty composer', { dirtyEditor: true }],
    ['dirty comment editor', { dirtyEditor: true }],
    ['dirty reply editor', { dirtyEditor: true }],
    ['re-anchor flow', { reanchorActive: true }],
    ['pending mutation', { mutationPending: true }],
  ])('suppresses explicit application for a %s', async (_label, input) => {
    const onApply = vi.fn<() => void>();
    await render(evaluateReviewRefreshSafety(input), onApply);

    expect(button().disabled).toBe(true);
    await act(async () =>
      button().dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  function button() {
    return container.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply the available review revision"]',
    )!;
  }

  async function render(
    safety: ReturnType<typeof evaluateReviewRefreshSafety>,
    onApply: () => void,
  ) {
    await act(async () => {
      root.render(
        <GitHubPrRevisionNotice
          headSha="head-b-123456"
          onApply={onApply}
          safety={safety}
        />,
      );
    });
  }
});
