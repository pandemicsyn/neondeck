export const REPORT_DECK_CONTROLLER_SOURCE = String.raw`(() => {
  const root = document.querySelector('[data-report-deck]');
  if (!(root instanceof HTMLElement)) return;
  const slides = Array.from(root.querySelectorAll('[data-deck-slide-index]'));
  const dots = Array.from(root.querySelectorAll('[data-deck-dot-index]'));
  const previous = root.querySelector('[data-deck-action="prev"]');
  const next = root.querySelector('[data-deck-action="next"]');
  const current = root.querySelector('[data-deck-count-current]');
  const progress = root.querySelector('[data-deck-progress]');
  const live = root.querySelector('[data-deck-live]');
  let active = 0;
  let announceTimer = 0;

  const titleAt = (index) => {
    const slide = slides[index];
    return slide instanceof HTMLElement
      ? slide.getAttribute('aria-label') || 'Report slide'
      : 'Report slide';
  };

  const fromHash = () => {
    const match = /^#slide-(\d+)$/.exec(window.location.hash);
    if (!match) return 0;
    const index = Number(match[1]) - 1;
    return Number.isInteger(index) ? index : 0;
  };

  const setActive = (requested, updateHash = true) => {
    const previousActive = active;
    const outgoingSlide = slides[previousActive];
    const shouldRestoreFocus =
      outgoingSlide instanceof HTMLElement &&
      document.activeElement instanceof Node &&
      outgoingSlide.contains(document.activeElement);
    active = Math.max(0, Math.min(slides.length - 1, requested));
    slides.forEach((slide, index) => {
      if (slide instanceof HTMLElement) slide.hidden = index !== active;
    });
    if (shouldRestoreFocus) {
      const incomingSlide = slides[active];
      const scrollRegion =
        incomingSlide instanceof HTMLElement
          ? incomingSlide.querySelector('[data-deck-scroll-region]')
          : null;
      const focusTarget = scrollRegion instanceof HTMLElement ? scrollRegion : root;
      if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus();
      }
    }
    let activeDot = null;
    dots.forEach((dot, index) => {
      if (!(dot instanceof HTMLElement)) return;
      if (index === active) {
        dot.setAttribute('aria-current', 'true');
        activeDot = dot;
      } else {
        dot.removeAttribute('aria-current');
      }
    });
    if (activeDot && typeof activeDot.scrollIntoView === 'function') {
      activeDot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (previous instanceof HTMLButtonElement) previous.disabled = active === 0;
    if (next instanceof HTMLButtonElement) next.disabled = active === slides.length - 1;
    if (current) current.textContent = String(active + 1);
    if (progress instanceof HTMLElement) {
      progress.setAttribute('aria-valuenow', String(active + 1));
      progress.style.transform = 'scaleX(' + String((active + 1) / slides.length) + ')';
    }
    if (updateHash) {
      window.history.replaceState(null, '', '#slide-' + String(active + 1));
    }
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      if (live) live.textContent = titleAt(active);
    }, 120);
  };

  const interactiveTarget = (target) =>
    target instanceof Element &&
    Boolean(target.closest('a, button, input, select, textarea, [contenteditable]:not([contenteditable="false"])'));

  const deckScrollRegion = (target) => {
    if (!(target instanceof Element)) return null;
    const region = target.closest('[data-deck-scroll-region]');
    return region instanceof HTMLElement ? region : null;
  };

  const horizontalForwardKeys = new Set(['ArrowRight']);
  const horizontalBackwardKeys = new Set(['ArrowLeft']);
  const verticalForwardKeys = new Set(['PageDown', ' ', 'End']);
  const verticalBackwardKeys = new Set(['PageUp', 'Home']);

  const nextIndex = (key) => {
    if (key === 'ArrowLeft' || key === 'PageUp' || key === '[') return active - 1;
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === ']') return active + 1;
    if (key === 'Home') return 0;
    if (key === 'End') return slides.length - 1;
    if (key.length === 1 && key >= '1' && key <= '9') {
      const requested = Number(key) - 1;
      return requested < slides.length ? requested : null;
    }
    return null;
  };

  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const action = event.target.closest('[data-deck-action]');
    if (action instanceof HTMLElement) {
      setActive(active + (action.dataset.deckAction === 'next' ? 1 : -1));
      return;
    }
    const dot = event.target.closest('[data-deck-dot-index]');
    if (dot instanceof HTMLElement) setActive(Number(dot.dataset.deckDotIndex));
  });

  document.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      interactiveTarget(event.target)
    ) return;
    const scrollRegion = deckScrollRegion(event.target);
    if (scrollRegion && horizontalForwardKeys.has(event.key) && scrollRegion.scrollLeft + scrollRegion.clientWidth < scrollRegion.scrollWidth - 1) return;
    if (scrollRegion && horizontalBackwardKeys.has(event.key) && scrollRegion.scrollLeft > 0) return;
    if (scrollRegion && verticalForwardKeys.has(event.key) && scrollRegion.scrollTop + scrollRegion.clientHeight < scrollRegion.scrollHeight - 1) return;
    if (scrollRegion && verticalBackwardKeys.has(event.key) && scrollRegion.scrollTop > 0) return;
    const requested = nextIndex(event.key);
    if (requested === null) return;
    event.preventDefault();
    setActive(requested);
  });

  window.addEventListener('hashchange', () => setActive(fromHash(), false));
  setActive(fromHash(), false);
})();`;
