// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCursorTarget } from '../../../../shared/review-navigation';
import { PrReviewNavigationBar } from './PrReviewNavigationBar';

describe('PR review navigation controls', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let onMove: ReturnType<
    typeof vi.fn<(direction: 'previous' | 'next') => void>
  >;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    onMove = vi.fn<(direction: 'previous' | 'next') => void>();
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

  it('renders visible named controls, text position and boundary state, and a polite announcement', () => {
    renderBar(root, onMove, {
      announcement: 'src/a.ts, local draft, 2 of 3, stale.',
      boundary: 'start',
      currentIndex: 1,
      currentTarget: draftTarget,
      filter: 'src/',
      kind: 'local-draft',
      status: 'stale',
      total: 3,
    });

    expect(select('Traversal kind').value).toBe('local-draft');
    expect(button('Previous').title).toBe('Previous target ([)');
    expect(button('Next').title).toBe('Next target (])');
    expect(button('Shortcuts').title).toBe(
      'Review navigation keyboard help (?)',
    );
    expect(container.textContent).toContain(
      'local draft · 2 of 3 · start boundary · stale',
    );
    expect(container.textContent).toContain('filter: src/ · clear');
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'src/a.ts, local draft, 2 of 3, stale.',
    );
  });

  it('dispatches pointer and keyboard navigation through the same path without stealing focus', () => {
    renderBar(root, onMove);
    const focusOwner = document.createElement('button');
    focusOwner.textContent = 'Outside focus';
    document.body.append(focusOwner);
    focusOwner.focus();

    act(() => button('Next').click());
    act(() => dispatchKey(focusOwner, ']'));
    act(() => dispatchKey(focusOwner, '['));

    expect(onMove.mock.calls).toEqual([['next'], ['next'], ['previous']]);
    expect(document.activeElement).toBe(focusOwner);
    focusOwner.remove();
  });

  it('suppresses shortcuts for every editable, dialog, and composer focus context', () => {
    renderBar(root, onMove);
    const contexts = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editableRegion(),
      descendantOf('dialog', 'open', ''),
      descendantOf('div', 'role', 'dialog'),
      descendantOf('div', 'data-neondeck-review-annotation', ''),
      descendantOf('div', 'data-review-shortcuts', 'off'),
    ];
    for (const context of contexts) {
      document.body.append(context);
      const target =
        context.querySelector<HTMLElement>('button') ??
        (context as HTMLElement);
      target.focus();
      act(() => dispatchKey(target, ']'));
      context.remove();
    }
    expect(onMove).not.toHaveBeenCalled();
  });

  it('respects prevented, modified, and IME-composition events', () => {
    renderBar(root, onMove);
    const target = document.createElement('button');
    document.body.append(target);
    target.focus();
    const prevented = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: ']',
    });
    prevented.preventDefault();

    act(() => target.dispatchEvent(prevented));
    act(() => dispatchKey(target, ']', { ctrlKey: true }));
    act(() => dispatchKey(target, ']', { altKey: true }));
    act(() => dispatchKey(target, ']', { metaKey: true }));
    act(() => dispatchKey(target, ']', { isComposing: true }));

    expect(onMove).not.toHaveBeenCalled();
    target.remove();
  });

  it('opens accessible help from pointer or keyboard, focuses it intentionally, and restores focus', () => {
    renderBar(root, onMove);
    const help = button('Shortcuts');
    const outside = document.createElement('button');
    outside.textContent = 'Outside invoker';
    document.body.append(outside);
    outside.focus();

    act(() => dispatchKey(outside, '?', { shiftKey: true }));
    const dialog = container.querySelector<HTMLDialogElement>('dialog')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Shortcuts are off while a field');
    expect(document.activeElement?.textContent).toBe('Close');

    act(() => dispatchKey(dialog, 'Escape'));
    expect(container.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(outside);

    act(() => dispatchKey(outside, '?', { shiftKey: true }));
    act(() => button('Close').click());
    expect(container.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(outside);

    act(() => help.click());
    expect(container.querySelector('dialog')).not.toBeNull();
    outside.remove();
  });

  it('keeps empty and loading states in ordinary text and disables unavailable actions', () => {
    renderBar(root, onMove, {
      canMove: false,
      currentIndex: -1,
      currentTarget: null,
      isBusy: false,
      kind: 'finding',
      total: 0,
    });
    expect(container.textContent).toContain('No Neon finding targets.');
    expect(button('Previous').disabled).toBe(true);
    expect(button('Next').disabled).toBe(true);

    renderBar(root, onMove, {
      canMove: true,
      currentIndex: -1,
      currentTarget: null,
      isBusy: true,
      kind: 'hunk',
      status: 'Loading hunks for src/b.ts.',
      total: 0,
    });
    expect(container.textContent).toContain('Loading hunks for src/b.ts.');
  });
});

const draftTarget: ReviewCursorTarget = {
  id: 'draft-a',
  key: 'local-draft:draft-a',
  kind: 'local-draft',
  missing: false,
  orderIndex: 0,
  path: 'src/a.ts',
  position: 7,
  previousPath: null,
  requestedPath: 'src/a.ts',
  severity: null,
  stale: true,
  summary: 'Draft',
};

function renderBar(
  root: ReturnType<typeof createRoot>,
  onMove: (direction: 'previous' | 'next') => void,
  overrides: Partial<React.ComponentProps<typeof PrReviewNavigationBar>> = {},
) {
  act(() =>
    root.render(
      <PrReviewNavigationBar
        announcement="src/a.ts, file, 1 of 2."
        boundary={null}
        canMove
        currentIndex={0}
        currentTarget={{
          ...draftTarget,
          kind: 'file',
          id: 'src/a.ts',
          key: 'file:src/a.ts',
        }}
        filter={null}
        isBusy={false}
        kind="file"
        onClearFilter={vi.fn<() => void>()}
        onKindChange={vi.fn<() => void>()}
        onMove={onMove}
        status={null}
        total={2}
        {...overrides}
      />,
    ),
  );
}

function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.includes(name),
  )!;
}

function select(name: string) {
  return (
    document.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`) ??
    document.querySelector<HTMLSelectElement>('select')!
  );
}

function dispatchKey(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      ...init,
    }),
  );
}

function editableRegion() {
  const element = document.createElement('div');
  element.setAttribute('contenteditable', 'true');
  element.tabIndex = 0;
  return element;
}

function descendantOf(tag: string, attribute: string, value: string) {
  const parent = document.createElement(tag);
  parent.setAttribute(attribute, value);
  const child = document.createElement('button');
  parent.append(child);
  return parent;
}
