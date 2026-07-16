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

    const link = document.querySelector<HTMLAnchorElement>('.report-deck a')!;
    link.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    );
    expect(location.hash).toBe('#slide-1');
  });
});
