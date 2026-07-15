// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrReviewArtifactsOverlay } from './PrReviewArtifactsOverlay';

describe('PR review artifacts overlay', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('covers the iframe with useful loading and stalled states', () => {
    act(() =>
      root.render(
        <PrReviewArtifactsOverlay
          onClose={() => {}}
          reportIds={['report-1']}
          reviewLabel="owner/repo#1"
          reviewUrl="/review?repo=owner%2Frepo&number=1"
        />,
      ),
    );

    expect(document.body.textContent).toContain('Loading overview');
    act(() => vi.advanceTimersByTime(6_000));
    expect(document.body.textContent).toContain(
      'overview is taking longer than expected',
    );

    const iframe = document.querySelector('iframe');
    expect(iframe?.title).toBe('overview report for owner/repo#1');
    act(() => iframe?.dispatchEvent(new Event('load')));
    expect(document.querySelector('output')).toBeNull();
    expect(document.body.textContent).not.toContain(
      'overview is taking longer than expected',
    );
  });
});
