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

export type ReportDeckProps = {
  className?: string;
  deckKey?: string;
  document: ReportDeckDocument;
  focusHeading?: boolean;
  staticController?: boolean;
};

export function ReportDeck({
  className,
  deckKey,
  document,
  focusHeading = false,
  staticController = false,
}: ReportDeckProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
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
    if (focusHeading) headingRef.current?.focus();
  }, [deckKey, focusHeading]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAnnouncement(
        `Slide ${activeIndex + 1} of ${slideCount}: ${activeSlide.title}`,
      );
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [activeIndex, activeSlide.title, slideCount]);

  const navigate = (nextIndex: number) => {
    setActiveIndex(Math.max(0, Math.min(slideCount - 1, nextIndex)));
  };

  return (
    <article
      aria-label={`${document.title} report deck`}
      className={['report-deck', className].filter(Boolean).join(' ')}
      data-report-deck=""
      onKeyDown={
        staticController
          ? undefined
          : (event) =>
              handleDeckKeyDown(event, activeIndex, slideCount, navigate)
      }
      tabIndex={0}
    >
      <header className="report-deck-toolbar">
        <div className="report-deck-heading-group">
          {document.eyebrow ? (
            <p className="report-deck-eyebrow">{document.eyebrow}</p>
          ) : null}
          <h1 className="report-deck-heading" ref={headingRef} tabIndex={-1}>
            {document.title}
          </h1>
        </div>
        <span className="report-deck-count">
          <span data-deck-count-current="">{activeIndex + 1}</span> /{' '}
          {slideCount}
        </span>
      </header>
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
                  <h2 className="report-deck-slide-title">{slide.title}</h2>
                  {'part' in slide ? (
                    <span className="report-deck-part">
                      {slide.part} / {slide.totalParts}
                    </span>
                  ) : null}
                </header>
                <div className="report-deck-slide-body">
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
          previous
        </button>
        <div aria-label="Report slides" className="report-deck-dots">
          {document.slides.map((slide, index) => (
            <button
              aria-current={index === activeIndex ? 'true' : undefined}
              aria-label={`Go to slide ${index + 1}: ${slide.title}`}
              className="report-deck-dot"
              data-deck-dot-index={index}
              key={`${slide.title}:${index}`}
              onClick={staticController ? undefined : () => navigate(index)}
              type="button"
            />
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
          next
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
      return <ChangeMapItems items={slide.items} linkBudget={linkBudget} />;
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
  items,
  linkBudget,
}: {
  items: Extract<ReportDeckSlide, { kind: 'change-map' }>['items'];
  linkBudget: ReportMarkdownLinkBudget;
}) {
  return (
    <ul className="report-deck-change-list">
      {items.map((item, index) => (
        <li className="report-deck-change" key={`${item.path}:${index}`}>
          <div className="report-deck-path">
            {item.href ? (
              <a href={item.href} rel="noreferrer" target="_blank">
                {item.path}
              </a>
            ) : (
              item.path
            )}
          </div>
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

  let nextIndex: number | null = null;
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    nextIndex = activeIndex - 1;
  } else if (
    event.key === 'ArrowRight' ||
    event.key === 'PageDown' ||
    event.key === ' '
  ) {
    nextIndex = activeIndex + 1;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = slideCount - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  navigate(nextIndex);
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

function previousLabel(slides: ReportDeckSlide[], activeIndex: number) {
  const slide = slides[activeIndex - 1];
  return slide ? `Previous slide: ${slide.title}` : 'Previous slide';
}

function nextLabel(slides: ReportDeckSlide[], activeIndex: number) {
  const slide = slides[activeIndex + 1];
  return slide ? `Next slide: ${slide.title}` : 'Next slide';
}
