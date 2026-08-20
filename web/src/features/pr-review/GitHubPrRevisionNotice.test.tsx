// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateReviewRefreshSafety } from '../../../../shared/review-refresh';
import {
  GitHubPrDraftRevisionNotice,
  GitHubPrRevisionNotice,
} from './GitHubPrRevisionNotice';

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

  it('offers one action that updates the diff and local draft together', async () => {
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
      'moves any local draft to the same head',
    );
    expect(container.textContent).toContain('nothing is submitted to GitHub');
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

  it('offers one recovery action when the diff is current but the draft is stale', async () => {
    const onApply = vi.fn<() => void>();
    const safety = evaluateReviewRefreshSafety({});
    await act(async () => {
      root.render(
        <GitHubPrDraftRevisionNotice
          disabled={false}
          headSha="head-b-123456"
          onApply={onApply}
          safety={safety}
        />,
      );
    });

    expect(container.textContent).toContain('Draft revision is outdated');
    expect(container.textContent).toContain(
      'diff is showing GitHub head head-b-',
    );
    expect(container.textContent).toContain('Update draft to current revision');
    const update = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Update the local draft to the mounted review revision"]',
    )!;
    await act(async () =>
      update.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onApply).toHaveBeenCalledOnce();
  });

  function button() {
    return container.querySelector<HTMLButtonElement>(
      'button[aria-label="Update the review workspace to the available revision"]',
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
