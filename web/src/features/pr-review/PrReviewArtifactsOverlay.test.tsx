// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { representativeReportDeckFixture } from '../../../../shared/report-deck-fixtures';
import { getReport, getReportHtml } from '../../api/reports';
import { PrReviewArtifactsOverlay } from './PrReviewArtifactsOverlay';

vi.mock('../../api/reports', () => ({
  getReport: vi.fn<typeof getReport>(),
  getReportHtml: vi.fn<typeof getReportHtml>(),
}));

const getReportMock = vi.mocked(getReport);
const getReportHtmlMock = vi.mocked(getReportHtml);

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
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows loading and stalled states, then renders structured content inline', async () => {
    let resolveReport!: (value: Awaited<ReturnType<typeof getReport>>) => void;
    getReportMock.mockReturnValue(
      new Promise((resolve) => {
        resolveReport = resolve;
      }),
    );

    renderOverlay(root);
    expect(document.body.textContent).toContain('Loading overview');
    act(() => vi.advanceTimersByTime(6_000));
    expect(document.body.textContent).toContain(
      'overview is taking longer than expected',
    );

    await act(async () => resolveReport(reportResponse()));
    expect(document.body.textContent).toContain('PR Overview: owner/repo#1');
    expect(document.body.textContent).toContain('Changed the transport.');
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('output')).toBeNull();
  });

  it('shows retry and pop-out actions when the report request fails', async () => {
    getReportMock.mockRejectedValue(new Error('Report unavailable.'));
    renderOverlay(root);

    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain('Could not load overview');
    expect(document.body.textContent).toContain('Report unavailable.');
    expect(button('retry')).toBeDefined();
    expect(button('pop out')).toBeDefined();
  });

  it('converts retained HTML reports into safe inline content', async () => {
    getReportMock.mockResolvedValue({
      ...reportResponse(),
      item: {
        ...reportResponse().item!,
        summary: { report: 'overview', workflow: 'review-pr-for-human' },
      },
    });
    getReportHtmlMock.mockResolvedValue(legacyReportHtml());
    renderOverlay(root);

    await act(async () => Promise.resolve());
    expect(getReportHtmlMock).toHaveBeenCalledWith('report-1', {
      signal: expect.any(AbortSignal),
    });
    expect(document.body.textContent).toContain('Legacy overview');
    expect(document.body.textContent).toContain('Legacy risk');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('renders v2 decks with accessible navigation and bounded keyboard controls', async () => {
    getReportMock.mockResolvedValue({
      ...reportResponse(),
      item: {
        ...reportResponse().item!,
        summary: { deck: representativeReportDeckFixture },
      },
    });
    renderOverlay(root);

    await act(async () => Promise.resolve());
    const deck = document.querySelector<HTMLElement>('[data-report-deck]')!;
    const slides = [
      ...document.querySelectorAll<HTMLElement>('[data-deck-slide-index]'),
    ];
    expect(deck.getAttribute('aria-label')).toContain('report deck');
    expect(slides[0]?.hidden).toBe(false);
    expect(slides[1]?.hidden).toBe(true);
    expect(
      document
        .querySelector('[data-deck-dot-index="1"]')
        ?.getAttribute('aria-label'),
    ).toBe('Go to slide 2: PR facts');
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
    const scrollRegion = slides[0]!.querySelector<HTMLElement>(
      '[data-deck-scroll-region]',
    )!;
    expect(scrollRegion.tabIndex).toBe(0);
    expect(scrollRegion.getAttribute('aria-label')).toBe(
      'Review brief content',
    );
    act(() =>
      scrollRegion.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }),
      ),
    );
    expect(slides[0]?.hidden).toBe(false);
    expect(slides[1]?.hidden).toBe(true);

    act(() => button('next')!.click());
    expect(slides[0]?.hidden).toBe(true);
    expect(slides[1]?.hidden).toBe(false);

    act(() =>
      deck.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
      ),
    );
    expect(slides.at(-1)?.hidden).toBe(false);

    act(() =>
      deck.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }),
      ),
    );
    const link = document.querySelector<HTMLAnchorElement>('.report-deck a')!;
    act(() =>
      link.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
      ),
    );
    expect(slides[0]?.hidden).toBe(false);
    expect(slides[1]?.hidden).toBe(true);
  });
});

function renderOverlay(root: ReturnType<typeof createRoot>) {
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
}

function reportResponse(): Awaited<ReturnType<typeof getReport>> {
  return {
    ok: true,
    action: 'reports_read',
    item: {
      id: 'report-1',
      kind: 'pr-review',
      title: 'PR Overview: owner/repo#1',
      repoId: 'repo-1',
      sourceRef: 'owner/repo#1',
      htmlPath: 'pr-review/report-1.html',
      summary: {
        document: {
          eyebrow: 'PR REVIEW',
          title: 'PR Overview: owner/repo#1',
          summary: 'Changed the transport.',
          generatedAt: '2026-07-15T00:00:00.000Z',
          sections: [
            {
              title: 'Pull Request',
              body: null,
              items: [{ label: 'state', value: 'open' }],
            },
          ],
        },
      },
      createdBy: 'review-pr-for-human',
      createdAt: '2026-07-15T00:00:00.000Z',
    },
  };
}

function button(label: string) {
  return [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
}

function legacyReportHtml() {
  return `<!doctype html>
    <html><body><main>
      <header>
        <p class="eyebrow">PR REVIEW</p>
        <h1>PR Overview: owner/repo#1</h1>
        <p class="summary">Legacy overview</p>
        <p class="meta">generated 2026-07-14T00:00:00.000Z</p>
      </header>
      <section>
        <h2>Checks And Risks</h2>
        <dl><dt>risk 1</dt><dd>Legacy risk</dd></dl>
      </section>
    </main></body></html>`;
}
