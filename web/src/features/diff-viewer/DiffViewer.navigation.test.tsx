// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedPatchView } from './DiffViewer';

const pierre = vi.hoisted(() => ({
  scrollTo: vi.fn<(target: unknown) => void>(),
}));

vi.mock('@pierre/diffs', () => ({
  getSingularPatch: vi.fn<() => object>(() => ({})),
}));

vi.mock('@pierre/diffs/react', async () => {
  const react = await import('react');
  return {
    CodeView: react.forwardRef(function MockCodeView(_props, ref) {
      react.useImperativeHandle(ref, () => ({ scrollTo: pierre.scrollTo }));
      return <div data-code-view="" />;
    }),
    PatchDiff: () =>
      react.createElement(
        'diffs-container',
        null,
        <div data-navigation-selected="" />,
      ),
    WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
      children,
  };
});

describe('guided diff navigation scrolling', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let scrollIntoView: ReturnType<
    typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>
  >;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('uses the Pierre CodeView scroll API for a virtualized target', () => {
    const patch = largePatch();
    act(() =>
      root.render(
        <UnifiedPatchView
          navigationScroll={{ token: 1, line: 1_800, selection: null }}
          patch={patch}
        />,
      ),
    );

    expect(pierre.scrollTo).toHaveBeenCalledWith({
      type: 'line',
      id: 'active-diff',
      lineNumber: 1_800,
      align: 'center',
      behavior: 'smooth-auto',
    });
  });

  it('scrolls a rendered PatchDiff annotation into view', () => {
    act(() =>
      root.render(
        <UnifiedPatchView
          navigationScroll={{ token: 1, line: 2, selection: null }}
          patch={smallPatch}
        />,
      ),
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  });
});

const smallPatch = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  '',
].join('\n');

function largePatch() {
  return [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -0,0 +1,2001 @@',
    ...Array.from({ length: 2_001 }, (_, index) => `+line ${index + 1}`),
    '',
  ].join('\n');
}
