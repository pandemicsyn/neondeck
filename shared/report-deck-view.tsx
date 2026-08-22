import { useEffect, useId, useRef, useState } from 'react';
import type {
  ReportDeckDocument,
  ReportDeckFindingItem,
  ReportDeckSlide,
} from './report-deck';
import {
  ReportMarkdown,
  type ReportMarkdownLinkBudget,
} from './report-markdown';
import { REPORT_MARKDOWN_LIMITS } from './report-markdown-policy';

export type ReportDeckChrome = 'embedded' | 'full';

export type ReportDeckProps = {
  chrome?: ReportDeckChrome;
  className?: string;
  deckKey?: string;
  document: ReportDeckDocument;
  onActiveSlideChange?: (index: number, slide: ReportDeckSlide) => void;
  staticController?: boolean;
};

export function ReportDeck({
  chrome = 'full',
  className,
  deckKey,
  document,
  onActiveSlideChange,
  staticController = false,
}: ReportDeckProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const stepsRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef(false);
  const id = useId().replaceAll(':', '');
  const slideCount = document.slides.length;
  const activeSlide = document.slides[activeIndex] ?? document.slides[0]!;
  const artifactLinkBudget = {
    count: structuredLinkCount(document),
    max: REPORT_MARKDOWN_LIMITS.linksPerArtifact,
  };

  useEffect(() => {
    setActiveIndex(0);
  }, [deckKey, document]);

  useEffect(() => {
    onActiveSlideChange?.(activeIndex, activeSlide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, activeSlide]);

  useEffect(() => {
    const active = stepsRef.current?.querySelector(
      `[data-deck-dot-index="${activeIndex}"]`,
    );
    if (active instanceof HTMLElement) {
      active.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeIndex]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAnnouncement(
        `Slide ${activeIndex + 1} of ${slideCount}: ${activeSlide.title}`,
      );
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [activeIndex, activeSlide.title, slideCount]);

  // Hiding the outgoing slide drops focus that was inside it out of the
  // focus order entirely (real browsers move it to <body>, which jsdom does
  // not emulate). When that happens, restore focus onto the incoming
  // slide's scroll region so keyboard navigation keeps working. Navigation
  // triggered from chrome that stays in the DOM (footer buttons, step dots)
  // must not steal focus, so `navigate` only arms this when focus was
  // actually inside the slide being hidden.
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const incomingSlide = articleRef.current?.querySelector(
      `[data-deck-slide-index="${activeIndex}"]`,
    );
    const scrollRegion = incomingSlide?.querySelector(
      '[data-deck-scroll-region]',
    );
    const target =
      scrollRegion instanceof HTMLElement ? scrollRegion : articleRef.current;
    target?.focus();
  }, [activeIndex]);

  const navigate = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(slideCount - 1, nextIndex));
    const outgoingSlide = articleRef.current?.querySelector(
      `[data-deck-slide-index="${activeIndex}"]`,
    );
    const activeElement = globalThis.document?.activeElement;
    restoreFocusRef.current = Boolean(
      outgoingSlide && activeElement && outgoingSlide.contains(activeElement),
    );
    setActiveIndex(clamped);
  };

  return (
    <article
      aria-label={`${document.title} report deck`}
      className={['report-deck', className].filter(Boolean).join(' ')}
      data-deck-chrome={chrome}
      data-report-deck=""
      onKeyDown={
        staticController
          ? undefined
          : (event) =>
              handleDeckKeyDown(event, activeIndex, slideCount, navigate)
      }
      ref={articleRef}
      tabIndex={0}
    >
      <div aria-hidden="true" className="report-deck-print-heading">
        {document.eyebrow ? (
          <p className="report-deck-eyebrow">{document.eyebrow}</p>
        ) : null}
        <h2 className="report-deck-heading">{document.title}</h2>
        {document.subtitle ? (
          <p className="report-deck-subtitle">{document.subtitle}</p>
        ) : null}
      </div>
      {chrome === 'full' ? (
        <header className="report-deck-toolbar">
          <div className="report-deck-heading-group">
            {document.eyebrow ? (
              <p className="report-deck-eyebrow">{document.eyebrow}</p>
            ) : null}
            <h1 className="report-deck-heading">{document.title}</h1>
            {document.subtitle ? (
              <p className="report-deck-subtitle">{document.subtitle}</p>
            ) : null}
          </div>
          <span className="report-deck-count">
            <span data-deck-count-current="">{activeIndex + 1}</span> /{' '}
            {slideCount}
          </span>
        </header>
      ) : null}
      <div className="report-deck-progress-track">
        <div
          aria-label="Report progress"
          aria-valuemax={slideCount}
          aria-valuemin={1}
          aria-valuenow={activeIndex + 1}
          className="report-deck-progress"
          data-deck-progress=""
          role="progressbar"
          style={{ transform: `scaleX(${(activeIndex + 1) / slideCount})` }}
        />
      </div>
      <div className="report-deck-stage">
        {document.slides.map((slide, index) => {
          const linkBudget: ReportMarkdownLinkBudget = {
            artifact: artifactLinkBudget,
            slide: {
              count:
                structuredLinksInSlide(slide) +
                (index === 0 ? document.links.length : 0),
              max: REPORT_MARKDOWN_LIMITS.linksPerSlide,
            },
          };
          return (
            <section
              aria-label={`${index + 1} of ${slideCount}: ${slide.title}`}
              aria-roledescription="slide"
              className="report-deck-slide"
              data-deck-slide-index={index}
              hidden={index !== activeIndex}
              id={`${id}-slide-${index + 1}`}
              key={`${slide.kind}:${slide.title}:${index}`}
              role="group"
            >
              <div
                className={[
                  'report-deck-slide-frame',
                  slide.kind === 'markdown'
                    ? `report-deck-markdown-tone-${slide.tone}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <header className="report-deck-slide-header">
                  <div className="report-deck-slide-heading-group">
                    <h2 className="report-deck-slide-title">{slide.title}</h2>
                    {slide.kind === 'findings' && slide.subtitle ? (
                      <p className="report-deck-slide-subtitle">
                        {slide.subtitle}
                      </p>
                    ) : null}
                  </div>
                  {'part' in slide ? (
                    <span className="report-deck-part">
                      {slide.part} / {slide.totalParts}
                    </span>
                  ) : null}
                </header>
                <div
                  aria-label={`${slide.title} content`}
                  className="report-deck-slide-body"
                  data-deck-scroll-region=""
                  role="region"
                  tabIndex={0}
                >
                  <ReportDeckSlideContent
                    document={document}
                    linkBudget={linkBudget}
                    slide={slide}
                  />
                </div>
              </div>
            </section>
          );
        })}
      </div>
      <footer className="report-deck-footer">
        <button
          aria-label={previousLabel(document.slides, activeIndex)}
          className="report-deck-nav-button"
          data-deck-action="prev"
          disabled={activeIndex === 0}
          onClick={
            staticController ? undefined : () => navigate(activeIndex - 1)
          }
          type="button"
        >
          <span aria-hidden="true">&larr;</span>
        </button>
        <div
          aria-label="Report slides"
          className="report-deck-steps"
          ref={stepsRef}
        >
          {document.slides.map((slide, index) => (
            <button
              aria-current={index === activeIndex ? 'true' : undefined}
              aria-label={stepAriaLabel(index, slide, document)}
              className="report-deck-step"
              data-deck-dot-index={index}
              data-step-kind={slide.kind}
              key={`${slide.title}:${index}`}
              onClick={staticController ? undefined : () => navigate(index)}
              type="button"
            >
              <span className="report-deck-step-index">{index + 1}</span>
              <span className="report-deck-step-title">{slide.title}</span>
              <SlideStepBadge document={document} slide={slide} />
            </button>
          ))}
        </div>
        <button
          aria-label={nextLabel(document.slides, activeIndex)}
          className="report-deck-nav-button"
          data-deck-action="next"
          disabled={activeIndex === slideCount - 1}
          onClick={
            staticController ? undefined : () => navigate(activeIndex + 1)
          }
          type="button"
        >
          <span aria-hidden="true">&rarr;</span>
        </button>
      </footer>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="report-deck-live report-deck-sr-only"
        data-deck-live=""
      >
        {announcement}
      </p>
    </article>
  );
}

function ReportDeckSlideContent({
  document,
  linkBudget,
  slide,
}: {
  document: ReportDeckDocument;
  linkBudget: ReportMarkdownLinkBudget;
  slide: ReportDeckSlide;
}) {
  switch (slide.kind) {
    case 'summary':
      return (
        <div className="report-deck-summary-layout">
          <div className="report-deck-summary-copy">
            <ReportMarkdown linkBudget={linkBudget}>
              {document.summaryMarkdown}
            </ReportMarkdown>
            {slide.emptyStateMarkdown ? (
              <div className="report-deck-empty">
                <ReportMarkdown linkBudget={linkBudget}>
                  {slide.emptyStateMarkdown}
                </ReportMarkdown>
              </div>
            ) : null}
          </div>
          <div className="report-deck-summary-side">
            <p className="report-deck-kicker">At a glance</p>
            <Facts items={slide.facts} />
            {document.links.length > 0 ? (
              <div className="report-deck-links">
                {document.links.map((link, index) => (
                  <a
                    className="report-deck-action"
                    href={link.href}
                    key={`${link.kind}:${link.href}:${index}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      );
    case 'facts':
      return <Facts items={slide.items} />;
    case 'columns':
      return (
        <div className="report-deck-columns">
          {slide.columns.map((column, index) => (
            <section
              className="report-deck-column"
              data-tone={column.tone}
              key={`${column.title}:${index}`}
            >
              <h3>{column.title}</h3>
              <ul className="report-deck-list">
                {column.items.map((item, itemIndex) => (
                  <li key={`${itemIndex}:${item.slice(0, 40)}`}>
                    <ReportMarkdown linkBudget={linkBudget}>
                      {item}
                    </ReportMarkdown>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      );
    case 'markdown':
      return (
        <ReportMarkdown linkBudget={linkBudget}>
          {slide.markdown}
        </ReportMarkdown>
      );
    case 'change-map':
      return (
        <ChangeMapItems
          footnote={changeMapFootnote(slide, document)}
          items={slide.items}
          linkBudget={linkBudget}
        />
      );
    case 'findings':
      return <FindingItems items={slide.items} linkBudget={linkBudget} />;
    case 'appendix':
      return (
        <div>
          <div className="report-deck-appendix-note">
            <ReportMarkdown linkBudget={linkBudget}>
              {slide.bodyMarkdown}
            </ReportMarkdown>
          </div>
          {slide.groups.map((group, index) => (
            <section
              className="report-deck-appendix-group"
              key={`${group.kind}:${group.title}:${index}`}
            >
              <h3 className="report-deck-appendix-label">{group.title}</h3>
              {group.kind === 'facts' ? (
                <Facts items={group.items} />
              ) : group.kind === 'change-map' ? (
                <ChangeMapItems items={group.items} linkBudget={linkBudget} />
              ) : (
                <FindingItems items={group.items} linkBudget={linkBudget} />
              )}
            </section>
          ))}
        </div>
      );
  }
}

export function changeMapFootnote(
  slide: Extract<ReportDeckSlide, { kind: 'change-map' }>,
  document: ReportDeckDocument,
) {
  if (slide.totalFiles === null) return null;
  // Cumulative count of files shown through this part (not just this part's
  // page), so a mid-series part doesn't understate how many files have
  // actually been shown so far.
  const shownThroughPart = document.slides.reduce((total, other) => {
    if (other.kind !== 'change-map') return total;
    if (other.totalParts !== slide.totalParts) return total;
    if (other.part > slide.part) return total;
    return total + other.items.length;
  }, 0);
  const remaining = document.slides.reduce((total, other) => {
    if (other.kind !== 'appendix') return total;
    return (
      total +
      other.groups.reduce(
        (groupTotal, group) =>
          group.kind === 'change-map'
            ? groupTotal + group.items.length
            : groupTotal,
        0,
      )
    );
  }, 0);
  const base = `${shownThroughPart} of ${slide.totalFiles} files · part ${slide.part} of ${slide.totalParts}`;
  return remaining > 0 ? `${base} · remaining ${remaining} in appendix` : base;
}

function Facts({
  items,
}: {
  items: Array<{ href: string | null; label: string; value: string }>;
}) {
  return (
    <dl className="report-deck-facts">
      {items.map((item, index) => (
        <div className="report-deck-fact" key={`${item.label}:${index}`}>
          <dt>{item.label}</dt>
          <dd>
            {item.href ? (
              <a href={item.href} rel="noreferrer" target="_blank">
                {item.value}
              </a>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ChangeMapItems({
  footnote = null,
  items,
  linkBudget,
}: {
  footnote?: string | null;
  items: Extract<ReportDeckSlide, { kind: 'change-map' }>['items'];
  linkBudget: ReportMarkdownLinkBudget;
}) {
  return (
    <div>
      <div aria-hidden="true" className="report-deck-change-header">
        <span>Path</span>
        <span>Churn</span>
        <span>What changed</span>
      </div>
      <ul className="report-deck-change-list">
        {items.map((item, index) => (
          <li className="report-deck-change" key={`${item.path}:${index}`}>
            <ChangeMapPath href={item.href} path={item.path} />
            <ChangeMapChurn
              additions={item.additions}
              deletions={item.deletions}
            />
            <div>
              <ReportMarkdown linkBudget={linkBudget}>
                {item.summaryMarkdown}
              </ReportMarkdown>
              {item.riskMarkdown ? (
                <div className="report-deck-risk">
                  <ReportMarkdown linkBudget={linkBudget}>
                    {item.riskMarkdown}
                  </ReportMarkdown>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {footnote ? (
        <p className="report-deck-change-footnote">{footnote}</p>
      ) : null}
    </div>
  );
}

function ChangeMapPath({ href, path }: { href: string | null; path: string }) {
  const lastSlash = path.lastIndexOf('/');
  const prefix = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return (
    <div className="report-deck-change-path">
      {prefix ? (
        <span className="report-deck-change-path-prefix">{prefix}</span>
      ) : null}
      {href ? (
        <a href={href} rel="noreferrer" target="_blank">
          {basename}
        </a>
      ) : (
        <span>{basename}</span>
      )}
    </div>
  );
}

function ChangeMapChurn({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) {
    return <div className="report-deck-churn" />;
  }
  return (
    <div className="report-deck-churn">
      {additions !== null ? (
        <span className="report-deck-churn-add">
          <span aria-hidden="true">+{additions}</span>
          <span className="report-deck-sr-only">
            {additions} addition{additions === 1 ? '' : 's'}
          </span>
        </span>
      ) : null}
      {deletions !== null ? (
        <span className="report-deck-churn-del">
          <span aria-hidden="true">&minus;{deletions}</span>
          <span className="report-deck-sr-only">
            {deletions} deletion{deletions === 1 ? '' : 's'}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function FindingItems({
  items,
  linkBudget,
}: {
  items: ReportDeckFindingItem[];
  linkBudget: ReportMarkdownLinkBudget;
}) {
  return (
    <ul className="report-deck-finding-list">
      {items.map((item, index) => (
        <li
          className="report-deck-finding"
          data-severity={item.severity}
          key={`${item.disposition}:${item.path}:${item.line}:${index}`}
        >
          <div>
            <div className="report-deck-finding-meta">
              <span
                className="report-deck-severity"
                data-severity={item.severity}
              >
                {item.severity}
              </span>
              <span>{item.disposition}</span>
              {item.confidence ? (
                <span>{item.confidence} confidence</span>
              ) : null}
            </div>
            <p className="report-deck-path">
              {item.href ? (
                <a href={item.href} rel="noreferrer" target="_blank">
                  {item.path}
                  {item.line ? `:${item.line}` : ''}
                </a>
              ) : (
                `${item.path}${item.line ? `:${item.line}` : ''}`
              )}
            </p>
            {item.revision ? (
              <p className="report-deck-meta">revision {item.revision}</p>
            ) : null}
            {item.reason ? (
              <p className="report-deck-meta">{item.reason}</p>
            ) : null}
          </div>
          <div>
            <ReportMarkdown linkBudget={linkBudget}>
              {item.summaryMarkdown}
            </ReportMarkdown>
            <div className="report-deck-fix">
              <p className="report-deck-kicker">Suggested fix</p>
              <ReportMarkdown linkBudget={linkBudget}>
                {item.suggestedFixMarkdown}
              </ReportMarkdown>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export type ReportDeckStepBadgeSegment = {
  text: string;
  tone?: 'danger' | 'muted' | 'warning';
};

export function slideBadge(
  slide: ReportDeckSlide,
  document: ReportDeckDocument,
): ReportDeckStepBadgeSegment[] | null {
  switch (slide.kind) {
    case 'facts':
      return [{ text: String(slide.items.length) }];
    case 'columns': {
      const riskCount = slide.columns
        .filter((column) => column.tone === 'risk')
        .reduce((total, column) => total + column.items.length, 0);
      return riskCount > 0
        ? [{ text: String(riskCount), tone: 'warning' }]
        : null;
    }
    case 'change-map':
      return [{ text: `${slide.part}/${slide.totalParts}` }];
    case 'findings': {
      const severe = slide.items.filter(
        (item) => item.severity === 'critical' || item.severity === 'major',
      ).length;
      return [
        { text: String(severe), tone: 'danger' },
        { text: `/${totalFindingsInDocument(document)}`, tone: 'muted' },
      ];
    }
    case 'appendix':
      return [
        {
          text: String(
            slide.groups.reduce(
              (total, group) => total + group.items.length,
              0,
            ),
          ),
        },
      ];
    case 'summary':
    case 'markdown':
      return null;
  }
}

function totalFindingsInDocument(document: ReportDeckDocument) {
  return document.slides.reduce((total, slide) => {
    if (slide.kind === 'findings') return total + slide.items.length;
    if (slide.kind === 'appendix') {
      return (
        total +
        slide.groups.reduce(
          (groupTotal, group) =>
            group.kind === 'findings'
              ? groupTotal + group.items.length
              : groupTotal,
          0,
        )
      );
    }
    return total;
  }, 0);
}

function stepAriaLabel(
  index: number,
  slide: ReportDeckSlide,
  document: ReportDeckDocument,
) {
  const badgeText = slideBadge(slide, document)
    ?.map((segment) => segment.text)
    .join('');
  return badgeText
    ? `Go to slide ${index + 1}: ${slide.title}, ${badgeText}`
    : `Go to slide ${index + 1}: ${slide.title}`;
}

function SlideStepBadge({
  document,
  slide,
}: {
  document: ReportDeckDocument;
  slide: ReportDeckSlide;
}) {
  const segments = slideBadge(slide, document);
  if (!segments) return null;
  return (
    <span className="report-deck-step-badge">
      {segments.map((segment, index) => (
        <span data-badge-tone={segment.tone} key={index}>
          {segment.text}
        </span>
      ))}
    </span>
  );
}

function structuredLinkCount(document: ReportDeckDocument) {
  return (
    document.links.length +
    document.slides.reduce(
      (count, slide) => count + structuredLinksInSlide(slide),
      0,
    )
  );
}

function structuredLinksInSlide(slide: ReportDeckSlide) {
  switch (slide.kind) {
    case 'summary':
      return slide.facts.filter((item) => item.href).length;
    case 'facts':
    case 'change-map':
    case 'findings':
      return slide.items.filter((item) => item.href).length;
    case 'appendix':
      return slide.groups.reduce(
        (count, group) =>
          count + group.items.filter((item) => item.href).length,
        0,
      );
    case 'columns':
    case 'markdown':
      return 0;
  }
}

const HORIZONTAL_FORWARD_DECK_KEYS = new Set(['ArrowRight']);
const HORIZONTAL_BACKWARD_DECK_KEYS = new Set(['ArrowLeft']);
const VERTICAL_FORWARD_DECK_KEYS = new Set(['PageDown', ' ', 'End']);
const VERTICAL_BACKWARD_DECK_KEYS = new Set(['PageUp', 'Home']);

function handleDeckKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  activeIndex: number,
  slideCount: number,
  navigate: (index: number) => void,
) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isInteractiveTarget(event.target)
  ) {
    return;
  }

  const scrollRegion = deckScrollRegion(event.target);
  if (
    scrollRegion &&
    HORIZONTAL_FORWARD_DECK_KEYS.has(event.key) &&
    scrollRegion.scrollLeft + scrollRegion.clientWidth <
      scrollRegion.scrollWidth - 1
  ) {
    return;
  }
  if (
    scrollRegion &&
    HORIZONTAL_BACKWARD_DECK_KEYS.has(event.key) &&
    scrollRegion.scrollLeft > 0
  ) {
    return;
  }
  if (
    scrollRegion &&
    VERTICAL_FORWARD_DECK_KEYS.has(event.key) &&
    scrollRegion.scrollTop + scrollRegion.clientHeight <
      scrollRegion.scrollHeight - 1
  ) {
    return;
  }
  if (
    scrollRegion &&
    VERTICAL_BACKWARD_DECK_KEYS.has(event.key) &&
    scrollRegion.scrollTop > 0
  ) {
    return;
  }

  const nextIndex = nextDeckIndex(event.key, activeIndex, slideCount);
  if (nextIndex === null) return;
  event.preventDefault();
  navigate(nextIndex);
}

function nextDeckIndex(
  key: string,
  activeIndex: number,
  slideCount: number,
): number | null {
  if (key === 'ArrowLeft' || key === 'PageUp' || key === '[') {
    return activeIndex - 1;
  }
  if (
    key === 'ArrowRight' ||
    key === 'PageDown' ||
    key === ' ' ||
    key === ']'
  ) {
    return activeIndex + 1;
  }
  if (key === 'Home') return 0;
  if (key === 'End') return slideCount - 1;
  if (key.length === 1 && key >= '1' && key <= '9') {
    const requested = Number(key) - 1;
    return requested < slideCount ? requested : null;
  }
  return null;
}

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'a, button, input, select, textarea, [contenteditable]:not([contenteditable="false"])',
      ),
    )
  );
}

function deckScrollRegion(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const region = target.closest('[data-deck-scroll-region]');
  return region instanceof HTMLElement ? region : null;
}

function previousLabel(slides: ReportDeckSlide[], activeIndex: number) {
  const slide = slides[activeIndex - 1];
  return slide ? `Previous slide: ${slide.title}` : 'Previous slide';
}

function nextLabel(slides: ReportDeckSlide[], activeIndex: number) {
  const slide = slides[activeIndex + 1];
  return slide ? `Next slide: ${slide.title}` : 'Next slide';
}
