// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { representativeReportDeckFixture } from '../shared/report-deck-fixtures';
import { REPORT_DECK_CONTROLLER_SOURCE } from './lib/report-deck-controller';
import { renderReportDeckHtml } from './lib/report-deck-html';

describe('standalone report deck controller', () => {
  beforeEach(() => {
    const html = renderReportDeckHtml(representativeReportDeckFixture);
    document.documentElement.innerHTML = html
      .slice(html.indexOf('<head>'), html.indexOf('</html>'))
      .replace(`<script>${REPORT_DECK_CONTROLLER_SOURCE}</script>`, '');
    history.replaceState(null, '', '/');
    globalThis.eval(REPORT_DECK_CONTROLLER_SOURCE);
  });

  it('navigates buttons, named dots, progress, and the slide hash', () => {
    const slides = [
      ...document.querySelectorAll<HTMLElement>('[data-deck-slide-index]'),
    ];
    const next = document.querySelector<HTMLButtonElement>(
      '[data-deck-action="next"]',
    )!;

    expect(slides[0]?.hidden).toBe(false);
    expect(slides[1]?.hidden).toBe(true);
    next.click();
    expect(slides[0]?.hidden).toBe(true);
    expect(slides[1]?.hidden).toBe(false);
    expect(location.hash).toBe('#slide-2');
    expect(
      document.querySelector('[data-deck-count-current]')?.textContent,
    ).toBe('2');
    expect(
      document.querySelector<HTMLElement>('[data-deck-progress]')?.style
        .transform,
    ).toBe(`scaleX(${2 / representativeReportDeckFixture.slides.length})`);
    expect(
      document
        .querySelector('[data-deck-dot-index="1"]')
        ?.getAttribute('aria-current'),
    ).toBe('true');
  });

  it('supports deck keyboard navigation and ignores interactive targets', () => {
    const deck = document.querySelector<HTMLElement>('[data-report-deck]')!;
    const scrollRegion = document.querySelector<HTMLElement>(
      '[data-deck-scroll-region]',
    )!;
    expect(scrollRegion.tabIndex).toBe(0);
    expect(scrollRegion.getAttribute('role')).toBe('region');

    // Arrow keys pressed while focus is inside the slide scroll region now
    // advance the deck, since the region cannot actually scroll further.
    scrollRegion.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    );
    expect(location.hash).toBe('#slide-2');

    deck.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
    );
    expect(location.hash).toBe(
      `#slide-${representativeReportDeckFixture.slides.length}`,
    );

    deck.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }),
    );
    expect(location.hash).toBe('#slide-1');

    deck.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: ']' }),
    );
    expect(location.hash).toBe('#slide-2');

    deck.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: '[' }),
    );
    expect(location.hash).toBe('#slide-1');

    deck.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: '3' }),
    );
    expect(location.hash).toBe('#slide-3');

    const link = document.querySelector<HTMLAnchorElement>('.report-deck a')!;
    link.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    );
    expect(location.hash).toBe('#slide-3');
  });

  it('yields horizontal and vertical keys to a scroll region that can still scroll', () => {
    const scrollRegion = document.querySelector<HTMLElement>(
      '[data-deck-scroll-region]',
    )!;
    for (const [property, value] of [
      ['scrollWidth', 500],
      ['clientWidth', 200],
      ['scrollHeight', 500],
      ['clientHeight', 200],
    ] as const) {
      Object.defineProperty(scrollRegion, property, {
        configurable: true,
        value,
      });
    }

    scrollRegion.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    );
    expect(location.hash).toBe('');

    scrollRegion.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }),
    );
    expect(location.hash).toBe('');
  });

  it('lets Home scroll a scrolled region to the top instead of jumping to slide 1', () => {
    const scrollRegion = document.querySelector<HTMLElement>(
      '[data-deck-scroll-region]',
    )!;
    Object.defineProperty(scrollRegion, 'scrollTop', {
      configurable: true,
      value: 120,
    });

    scrollRegion.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }),
    );
    expect(location.hash).toBe('');
  });

  it('lets PageDown keep working at the bottom of a long slide instead of dead-ending', () => {
    const scrollRegion = document.querySelector<HTMLElement>(
      '[data-deck-scroll-region]',
    )!;
    // The region is scrollable (scrollHeight > clientHeight) but already
    // scrolled all the way down, so there is no remaining forward scroll.
    for (const [property, value] of [
      ['scrollHeight', 500],
      ['clientHeight', 200],
      ['scrollTop', 300],
    ] as const) {
      Object.defineProperty(scrollRegion, property, {
        configurable: true,
        value,
      });
    }

    scrollRegion.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }),
    );
    expect(location.hash).toBe('#slide-2');
  });

  it('lets digit keys jump slides even inside a horizontally-scrollable region', () => {
    const scrollRegion = document.querySelector<HTMLElement>(
      '[data-deck-scroll-region]',
    )!;
    for (const [property, value] of [
      ['scrollWidth', 900],
      ['clientWidth', 300],
    ] as const) {
      Object.defineProperty(scrollRegion, property, {
        configurable: true,
        value,
      });
    }

    scrollRegion.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: '3' }),
    );
    expect(location.hash).toBe('#slide-3');
  });
});
