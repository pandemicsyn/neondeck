import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  REPORT_DECK_LIMITS,
  parseReportDeckDocument,
  reportDeckFromSummary,
  type ReportDeckDocument,
  type ReportDeckSlide,
} from '../shared/report-deck';
import {
  hostileReportMarkdownFixtures,
  representativeReportDeckFixture,
} from '../shared/report-deck-fixtures';
import { ReportMarkdown } from '../shared/report-markdown';
import {
  REPORT_MARKDOWN_LIMITS,
  safeReportUrl,
} from '../shared/report-markdown-policy';
import { buildReviewReportDecks } from './modules/pr-review-assist/report-deck';
import type { ReviewAssistStructuredOutput } from './modules/pr-review-assist/schemas';

describe('report deck contract', () => {
  it('parses the representative v2 fixture from report metadata', () => {
    expect(parseReportDeckDocument(representativeReportDeckFixture)).toEqual(
      representativeReportDeckFixture,
    );
    const parsed = reportDeckFromSummary({
      deck: representativeReportDeckFixture,
    });
    expect(parsed).toMatchObject({
      version: 2,
      title: 'PR Overview: pandemicsyn/neondeck#125',
    });
    expect(parsed?.slides[0]).toMatchObject({
      kind: 'summary',
      title: 'Review brief',
    });
  });

  it('rejects decks with an unsafe shape or link budget', () => {
    const wrongFirstSlide = structuredClone(
      representativeReportDeckFixture,
    ) as ReportDeckDocument;
    wrongFirstSlide.slides.reverse();
    expect(parseReportDeckDocument(wrongFirstSlide)).toBeNull();

    const appendixBeforeEnd = structuredClone(
      representativeReportDeckFixture,
    ) as ReportDeckDocument;
    appendixBeforeEnd.slides.push({
      kind: 'facts',
      title: 'After appendix',
      items: [],
    });
    expect(parseReportDeckDocument(appendixBeforeEnd)).toBeNull();

    const tooManyLinks = structuredClone(
      representativeReportDeckFixture,
    ) as ReportDeckDocument;
    tooManyLinks.slides = [
      tooManyLinks.slides[0],
      {
        kind: 'facts',
        title: 'Link overflow',
        items: Array.from(
          { length: REPORT_MARKDOWN_LIMITS.linksPerSlide + 1 },
          (_, index) => ({
            label: `link ${index}`,
            value: `value ${index}`,
            href: `https://example.com/${index}`,
          }),
        ),
      },
    ];
    expect(parseReportDeckDocument(tooManyLinks)).toBeNull();

    const unsafeLink = structuredClone(
      representativeReportDeckFixture,
    ) as ReportDeckDocument;
    unsafeLink.links[0]!.href = 'javascript:alert(1)';
    expect(parseReportDeckDocument(unsafeLink)).toBeNull();
  });
});

describe('report Markdown policy', () => {
  it('normalizes complete http links and rejects unsafe or ambiguous targets', () => {
    expect(safeReportUrl('https://example.com/path')).toBe(
      'https://example.com/path',
    );
    expect(safeReportUrl('http://example.com')).toBe('http://example.com/');
    expect(safeReportUrl('https://user:secret@example.com/path')).toBeNull();
    expect(safeReportUrl('//example.com/path')).toBeNull();
    expect(safeReportUrl('javascript:alert(1)')).toBeNull();
    expect(safeReportUrl('java\tscript:alert(1)')).toBeNull();
    expect(
      safeReportUrl(`https://example.com/${'a'.repeat(2_100)}`),
    ).toBeNull();
  });

  it('renders the supported GFM subset with clickable safe links', () => {
    const html = renderMarkdown(
      [
        '## Review',
        '',
        '**Strong**, `inline`, and [safe](https://example.com/path).',
        '',
        '| Check | Result |',
        '| --- | --- |',
        '| unit | pass |',
      ].join('\n'),
    );

    expect(html).toContain('<h2>Review</h2>');
    expect(html).toContain('<strong>Strong</strong>');
    expect(html).toContain('<code>inline</code>');
    expect(html).toContain(
      '<a href="https://example.com/path" rel="noreferrer" target="_blank">safe</a>',
    );
    expect(html).toContain('<table>');
  });

  it('keeps hostile Markdown inert and unwraps over-bound structures', () => {
    const hostileHtml = renderMarkdown(
      Object.values(hostileReportMarkdownFixtures).join('\n\n'),
    );

    expect(hostileHtml).not.toContain('<script');
    expect(hostileHtml).not.toContain('<img');
    expect(hostileHtml).not.toContain('javascript:');
    expect(hostileHtml).not.toContain('href="//');
    expect(hostileHtml).not.toContain('user:secret');
    expect(hostileHtml).not.toContain('<table>');
    expect(hostileHtml).not.toContain('<pre>');
  });

  it('renders no more than the per-slide link bound', () => {
    const markdown = Array.from(
      { length: REPORT_MARKDOWN_LIMITS.linksPerSlide + 1 },
      (_, index) => `[link ${index + 1}](https://example.com/${index + 1})`,
    ).join(' ');
    const html = renderMarkdown(markdown);

    expect((html.match(/<a /gu) ?? []).length).toBe(
      REPORT_MARKDOWN_LIMITS.linksPerSlide,
    );
    expect(html).toContain('link 33');
  });
});

describe('default PR review deck builder', () => {
  it('paginates change maps and moves overflow into the final appendix', () => {
    const changeMap = Array.from({ length: 280 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      summary: `Change ${index}`,
    }));
    const output: ReviewAssistStructuredOutput = {
      overview: {
        summary: 'A complete Markdown review brief.',
        changeMap,
        checks: ['Run the unit suite.'],
        risks: [],
      },
      findings: [],
    };
    const result = buildReviewReportDecks({
      sourceRef: 'pandemicsyn/neondeck#125',
      state: reviewState(),
      files: changeMap.map((item) =>
        reviewFile(item.path, `https://example.com/files/${item.path}`),
      ),
      output,
      seededFindings: [],
      reportOnlyFindings: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(result.overview.overflowUsed).toBe(true);
    expect(result.overview.document.slides).toHaveLength(
      REPORT_DECK_LIMITS.slides,
    );
    expect(result.overview.document.slides.at(-1)).toMatchObject({
      kind: 'appendix',
      groups: [
        {
          kind: 'change-map',
          items: expect.arrayContaining([
            expect.objectContaining({ path: 'src/file-279.ts' }),
          ]),
        },
      ],
    });
    expect(changeMapPaths(result.overview.document.slides)).toEqual(
      changeMap.map((item) => item.path),
    );
    expect(countDeckLinks(result.overview.document)).toBeLessThanOrEqual(
      REPORT_MARKDOWN_LIMITS.linksPerArtifact,
    );
  });

  it('uses one useful Review brief slide when there are no findings', () => {
    const result = buildReviewReportDecks({
      sourceRef: 'pandemicsyn/neondeck#125',
      state: reviewState(),
      files: [],
      output: {
        overview: { summary: 'Summary', changeMap: [], checks: [], risks: [] },
        findings: [],
      },
      seededFindings: [],
      reportOnlyFindings: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(result.issues.document.slides).toEqual([
      expect.objectContaining({
        kind: 'summary',
        title: 'Review brief',
        emptyStateMarkdown: expect.stringContaining('nothing to triage'),
      }),
    ]);
  });
});

function renderMarkdown(markdown: string) {
  return renderToStaticMarkup(createElement(ReportMarkdown, null, markdown));
}

function reviewState() {
  return {
    repo: 'pandemicsyn/neondeck',
    number: 125,
    url: 'https://github.com/pandemicsyn/neondeck/pull/125',
    title: 'Build report decks',
    state: 'open',
    baseRef: 'main',
    headSha: 'abc123',
  } as Parameters<typeof buildReviewReportDecks>[0]['state'];
}

function reviewFile(path: string, htmlUrl: string) {
  return { path, htmlUrl } as Parameters<
    typeof buildReviewReportDecks
  >[0]['files'][number];
}

function changeMapPaths(slides: ReportDeckSlide[]) {
  return slides.flatMap((slide) => {
    if (slide.kind === 'change-map') {
      return slide.items.map((item) => item.path);
    }
    if (slide.kind === 'appendix') {
      return slide.groups.flatMap((group) =>
        group.kind === 'change-map' ? group.items.map((item) => item.path) : [],
      );
    }
    return [];
  });
}

function countDeckLinks(deck: ReportDeckDocument) {
  return (
    deck.links.length +
    deck.slides.reduce((total, slide) => {
      if (slide.kind === 'summary') {
        return total + slide.facts.filter((fact) => fact.href).length;
      }
      if (slide.kind === 'facts') {
        return total + slide.items.filter((item) => item.href).length;
      }
      if (slide.kind === 'change-map' || slide.kind === 'findings') {
        return total + slide.items.filter((item) => item.href).length;
      }
      if (slide.kind === 'appendix') {
        return (
          total +
          slide.groups.reduce(
            (groupTotal, group) =>
              groupTotal + group.items.filter((item) => item.href).length,
            0,
          )
        );
      }
      return total;
    }, 0)
  );
}
