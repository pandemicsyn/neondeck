import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReviewCursorDirection,
  ReviewCursorKind,
  ReviewCursorTarget,
} from '../../../../shared/review-navigation';
import { reviewNavigationKindLabel } from './review-navigation';

const traversalKinds: readonly ReviewCursorKind[] = [
  'file',
  'hunk',
  'review-thread',
  'local-draft',
  'finding',
  'attention',
];

export function PrReviewNavigationBar({
  announcement,
  boundary,
  canMove,
  currentIndex,
  currentTarget,
  filter,
  isBusy,
  kind,
  onClearFilter,
  onKindChange,
  onMove,
  status,
  total,
}: {
  announcement: string;
  boundary: 'start' | 'end' | null;
  canMove: boolean;
  currentIndex: number;
  currentTarget: ReviewCursorTarget | null;
  filter: string | null;
  isBusy: boolean;
  kind: ReviewCursorKind;
  onClearFilter: () => void;
  onKindChange: (kind: ReviewCursorKind) => void;
  onMove: (direction: ReviewCursorDirection) => void;
  status: string | null;
  total: number;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const helpInvokerRef = useRef<HTMLElement | null>(null);

  const openHelp = useCallback((invoker: HTMLElement | null) => {
    helpInvokerRef.current = invoker;
    setHelpOpen(true);
  }, []);

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    window.requestAnimationFrame(() => {
      const invoker = helpInvokerRef.current;
      helpInvokerRef.current = null;
      if (invoker?.isConnected) {
        invoker.focus();
        return;
      }
      helpButtonRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (helpOpen) closeButtonRef.current?.focus();
  }, [helpOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldSuppressReviewShortcut(event)) return;
      if (event.key === '?') {
        event.preventDefault();
        const activeElement = deepActiveElement();
        openHelp(activeElement instanceof HTMLElement ? activeElement : null);
        return;
      }
      if (event.key !== '[' && event.key !== ']') return;
      event.preventDefault();
      onMove(event.key === '[' ? 'previous' : 'next');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onMove, openHelp]);
  const positionText = navigationPositionText({
    boundary,
    canMove,
    currentIndex,
    currentTarget,
    filter,
    isBusy,
    kind,
    status,
    total,
  });

  return (
    <>
      <nav
        aria-label="Review traversal controls"
        className="pr-review-navigation"
      >
        <div className="pr-review-navigation-mode">
          <label htmlFor="pr-review-traversal-kind">Traverse</label>
          <select
            id="pr-review-traversal-kind"
            onChange={(event) =>
              onKindChange(event.currentTarget.value as ReviewCursorKind)
            }
            value={kind}
          >
            {traversalKinds.map((item) => (
              <option key={item} value={item}>
                {reviewNavigationKindLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <div className="pr-review-navigation-actions">
          <button
            aria-keyshortcuts="["
            disabled={isBusy || !canMove}
            onClick={() => onMove('previous')}
            title="Previous target ([)"
            type="button"
          >
            <span aria-hidden="true">←</span> Previous <kbd>[</kbd>
          </button>
          <button
            aria-keyshortcuts="]"
            disabled={isBusy || !canMove}
            onClick={() => onMove('next')}
            title="Next target (])"
            type="button"
          >
            Next <kbd>]</kbd> <span aria-hidden="true">→</span>
          </button>
        </div>
        <p className="pr-review-navigation-status">{positionText}</p>
        {filter ? (
          <button
            className="pr-review-navigation-filter"
            onClick={onClearFilter}
            title={`Clear file-tree filter: ${filter}`}
            type="button"
          >
            filter: {filter} · clear
          </button>
        ) : null}
        <button
          aria-keyshortcuts="?"
          className="pr-review-navigation-help"
          onClick={(event) => openHelp(event.currentTarget)}
          ref={helpButtonRef}
          title="Review navigation keyboard help (?)"
          type="button"
        >
          Shortcuts <kbd>?</kbd>
        </button>
      </nav>
      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {helpOpen ? (
        <dialog
          aria-labelledby="pr-review-shortcuts-title"
          aria-modal="true"
          className="pr-review-shortcuts-dialog"
          data-review-shortcuts="off"
          open
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeHelp();
            } else if (event.key === 'Tab') {
              event.preventDefault();
              closeButtonRef.current?.focus();
            }
          }}
        >
          <div className="pr-review-shortcuts-panel">
            <div className="pr-review-shortcuts-heading">
              <h2 id="pr-review-shortcuts-title">Review navigation</h2>
              <button
                onClick={closeHelp}
                ref={closeButtonRef}
                title="Close keyboard help"
                type="button"
              >
                Close
              </button>
            </div>
            <dl>
              <div>
                <dt>
                  <kbd>[</kbd>
                </dt>
                <dd>Previous target in the selected traversal kind.</dd>
              </div>
              <div>
                <dt>
                  <kbd>]</kbd>
                </dt>
                <dd>Next target in the selected traversal kind.</dd>
              </div>
              <div>
                <dt>
                  <kbd>?</kbd>
                </dt>
                <dd>Open this keyboard help.</dd>
              </div>
            </dl>
            <p>
              Shortcuts are off while a field, comment composer, editable
              region, or dialog owns focus. Browser and modified-key shortcuts
              are left unchanged.
            </p>
          </div>
        </dialog>
      ) : null}
    </>
  );
}

export function shouldSuppressReviewShortcut(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return true;
  }
  const target =
    event.target instanceof Element ? event.target : deepActiveElement();
  return (
    isShortcutSuppressedElement(target) ||
    isShortcutSuppressedElement(deepActiveElement())
  );
}

function isShortcutSuppressedElement(element: Element | null) {
  return Boolean(
    (element instanceof HTMLElement && element.isContentEditable) ||
    element?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [data-review-shortcuts="off"], [data-neondeck-review-annotation]',
    ),
  );
}

function deepActiveElement() {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function navigationPositionText({
  boundary,
  canMove,
  currentIndex,
  currentTarget,
  filter,
  isBusy,
  kind,
  status,
  total,
}: {
  boundary: 'start' | 'end' | null;
  canMove: boolean;
  currentIndex: number;
  currentTarget: ReviewCursorTarget | null;
  filter: string | null;
  isBusy: boolean;
  kind: ReviewCursorKind;
  status: string | null;
  total: number;
}) {
  const label = reviewNavigationKindLabel(kind);
  if (isBusy) return status ?? `Loading the next ${label}.`;
  if (total === 0) {
    if (kind === 'hunk' && canMove) {
      return (
        status ??
        'No loaded hunk targets · Previous or Next scans patches one file at a time.'
      );
    }
    return `No ${label} targets${filter ? ' match the file-tree filter' : ''}.`;
  }
  const position =
    currentTarget && currentIndex >= 0
      ? `${currentIndex + 1} of ${total}`
      : `not selected · ${total} available`;
  const boundaryText = boundary
    ? ` · ${boundary === 'start' ? 'start boundary' : 'end boundary'}`
    : '';
  return `${label} · ${position}${boundaryText}${status ? ` · ${status}` : ''}`;
}
