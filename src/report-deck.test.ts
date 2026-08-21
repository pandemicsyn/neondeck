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
import { reportDocumentToDeck } from '../shared/report-document-to-deck';
import { changeMapFootnote, slideBadge } from '../shared/report-deck-view';
import { ReportMarkdown } from '../shared/report-markdown';
import {
  REPORT_MARKDOWN_LIMITS,
  safeReportUrl,
} from '../shared/report-markdown-policy';
import { buildReviewReportDecks } from './modules/pr-review-assist/report-deck';
import {
  parseReviewPresentationPlan,
  REVIEW_PRESENTATION_LIMITS,
  type ReviewAssistStructuredOutput,
} from './modules/pr-review-assist/schemas';
import { REPORT_DECK_CONTROLLER_SOURCE } from './lib/report-deck-controller';
import { renderReportDeckHtml } from './lib/report-deck-html';

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

  it('parses the all-null variant of the new nullable fields', () => {
    const allNull = structuredClone(
      representativeReportDeckFixture,
    ) as ReportDeckDocument;
    allNull.subtitle = null;
    for (const slide of allNull.slides) {
      if (slide.kind === 'change-map') {
        slide.totalFiles = null;
        for (const item of slide.items) {
          item.additions = null;
          item.deletions = null;
        }
      }
      if (slide.kind === 'findings') {
        slide.subtitle = null;
        for (const item of slide.items) {
          item.revision = null;
        }
      }
    }
    const parsed = parseReportDeckDocument(allNull);
    expect(parsed).toEqual(allNull);
    expect(parsed?.subtitle).toBeNull();
  });

  it('parses persisted decks that predate the new keys and are missing them entirely', () => {
    // Regression guard: persisted report rows were written before `subtitle`,
    // `totalFiles`, `additions`, `deletions`, and `revision` existed, so those
    // keys are absent from the stored JSON rather than present-and-null.
    const legacy = structuredClone(representativeReportDeckFixture) as Record<
      string,
      unknown
    >;
    delete legacy.subtitle;
    for (const slide of legacy.slides as Array<Record<string, unknown>>) {
      if (slide.kind === 'change-map') {
        delete slide.totalFiles;
        for (const item of slide.items as Array<Record<string, unknown>>) {
          delete item.additions;
          delete item.deletions;
        }
      }
      if (slide.kind === 'findings') {
        delete slide.subtitle;
        for (const item of slide.items as Array<Record<string, unknown>>) {
          delete item.revision;
        }
      }
    }

    const parsed = parseReportDeckDocument(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.subtitle).toBeNull();
    const changeMapSlide = parsed?.slides.find(
      (slide) => slide.kind === 'change-map',
    );
    expect(changeMapSlide).toMatchObject({
      totalFiles: null,
      items: [expect.objectContaining({ additions: null, deletions: null })],
    });
    const findingsSlide = parsed?.slides.find(
      (slide) => slide.kind === 'findings',
    );
    expect(findingsSlide).toMatchObject({
      subtitle: null,
      items: [expect.objectContaining({ revision: null })],
    });
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

describe('report deck rendering', () => {
  it('renders a self-contained deck with the exact static controller source', () => {
    const html = renderReportDeckHtml(representativeReportDeckFixture);

    expect(html).toContain('data-report-deck=""');
    expect(html).toContain('<strong>brief</strong>');
    expect(html).toContain(
      '<script>' + REPORT_DECK_CONTROLLER_SOURCE + '</script>',
    );
    expect(html).toContain(
      '@media print { html, body { height: auto; overflow: visible; } }',
    );
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('shares Markdown link budgets across fields, slides, and the artifact', () => {
    const links = (prefix: string) =>
      Array.from(
        { length: REPORT_MARKDOWN_LIMITS.linksPerSlide },
        (_, index) =>
          `[${prefix} ${index}](https://example.com/${prefix}-${index})`,
      ).join(' ');
    const deck: ReportDeckDocument = {
      version: 2,
      eyebrow: 'PR REVIEW',
      title: 'Bounded links',
      subtitle: null,
      summaryMarkdown: 'Summary',
      generatedAt: '2026-07-15T12:00:00.000Z',
      links: [],
      slides: [
        {
          kind: 'summary',
          title: 'Review brief',
          facts: [],
          emptyStateMarkdown: null,
        },
        {
          kind: 'columns',
          title: 'Shared slide budget',
          columns: [
            {
              title: 'First field',
              tone: 'neutral',
              items: [links('column-a'), links('column-b')],
            },
          ],
        },
        ...['one', 'two', 'three', 'last'].map<ReportDeckSlide>((prefix) => ({
          kind: 'markdown',
          title: prefix,
          markdown: links(prefix),
          tone: 'neutral',
        })),
      ],
    };
    expect(parseReportDeckDocument(deck)).toEqual(deck);

    const html = renderReportDeckHtml(deck);
    expect((html.match(/<a /gu) ?? []).length).toBe(
      REPORT_MARKDOWN_LIMITS.linksPerArtifact,
    );
    expect(
      (html.match(/href="https:\/\/example\.com\/column-/gu) ?? []).length,
    ).toBe(REPORT_MARKDOWN_LIMITS.linksPerSlide);
    expect(html).not.toContain('href="https://example.com/last-');
    expect(html).toContain('last 31');
  });

  it('gives change-map churn values screen-reader text without doubling the announcement', () => {
    const html = renderReportDeckHtml(representativeReportDeckFixture);

    // The visible glyphs stay exactly as rendered today, but are hidden
    // from assistive tech so they don't announce alongside the spelled-out
    // text (e.g. "plus 42 42 additions").
    expect(html).toContain(
      '<span class="report-deck-churn-add">' +
        '<span aria-hidden="true">+42</span>' +
        '<span class="report-deck-sr-only">42 additions</span></span>',
    );
    expect(html).toContain(
      '<span class="report-deck-churn-del">' +
        '<span aria-hidden="true">−6</span>' +
        '<span class="report-deck-sr-only">6 deletions</span></span>',
    );
  });

  it('adapts retained v1 report documents into bounded v2 decks', () => {
    const deck = reportDocumentToDeck({
      eyebrow: 'PR REVIEW',
      title: 'Legacy overview',
      summary: 'Literal **Markdown** from the old report.',
      generatedAt: '2026-07-15T12:00:00.000Z',
      sections: [
        {
          title: 'Checks',
          body: 'Run `npm test`.',
          items: Array.from({ length: 25 }, (_, index) => ({
            label: `check ${index + 1}`,
            value: `value [${index + 1}]`,
          })),
        },
      ],
    });

    expect(deck).toMatchObject({
      version: 2,
      title: 'Legacy overview',
      summaryMarkdown: 'Literal \\*\\*Markdown\\*\\* from the old report\\.',
    });
    expect(deck?.slides[0]).toMatchObject({
      kind: 'summary',
      title: 'Review brief',
    });
    expect(deck?.slides.at(-1)).toMatchObject({
      kind: 'facts',
      title: 'Checks · part 2 of 2',
      items: expect.any(Array),
    });
    expect(parseReportDeckDocument(deck)).toEqual(deck);
  });
});

describe('slideBadge', () => {
  const [
    summarySlide,
    factsSlide,
    columnsSlide,
    changeMapSlide,
    findingsSlide,
    appendixSlide,
  ] = representativeReportDeckFixture.slides;

  it('renders no badge for summary and markdown slides', () => {
    expect(
      slideBadge(summarySlide!, representativeReportDeckFixture),
    ).toBeNull();
    const markdownSlide: ReportDeckSlide = {
      kind: 'markdown',
      title: 'Why this matters',
      markdown: 'Body',
      tone: 'neutral',
    };
    expect(
      slideBadge(markdownSlide, representativeReportDeckFixture),
    ).toBeNull();
  });

  it('renders the item count for facts slides', () => {
    expect(slideBadge(factsSlide!, representativeReportDeckFixture)).toEqual([
      { text: '2' },
    ]);
  });

  it('renders the risk item count for columns slides, omitted when zero', () => {
    expect(slideBadge(columnsSlide!, representativeReportDeckFixture)).toEqual([
      { text: '1', tone: 'warning' },
    ]);
    const noRiskColumns: ReportDeckSlide = {
      kind: 'columns',
      title: 'Checks only',
      columns: [{ title: 'Checks', tone: 'check', items: ['ok'] }],
    };
    expect(
      slideBadge(noRiskColumns, representativeReportDeckFixture),
    ).toBeNull();
  });

  it('renders part/totalParts for change-map slides', () => {
    expect(
      slideBadge(changeMapSlide!, representativeReportDeckFixture),
    ).toEqual([{ text: '1/1' }]);
  });

  it('renders the severe count against the document finding total for findings slides', () => {
    expect(slideBadge(findingsSlide!, representativeReportDeckFixture)).toEqual(
      [
        { text: '0', tone: 'danger' },
        { text: '/1', tone: 'muted' },
      ],
    );
  });

  it('renders the total item count across groups for appendix slides', () => {
    expect(slideBadge(appendixSlide!, representativeReportDeckFixture)).toEqual(
      [{ text: '1' }],
    );
  });
});

describe('changeMapFootnote', () => {
  const changeMapItem = (path: string) => ({
    path,
    summaryMarkdown: 'Change.',
    riskMarkdown: null,
    href: null,
    additions: 1,
    deletions: 0,
  });

  it('reports the cumulative shown count through the current part, not the per-part count', () => {
    const document: ReportDeckDocument = {
      version: 2,
      eyebrow: 'PR REVIEW',
      title: 'Multi-part change map',
      subtitle: null,
      summaryMarkdown: 'Summary',
      generatedAt: '2026-07-15T12:00:00.000Z',
      links: [],
      slides: [
        {
          kind: 'summary',
          title: 'Review brief',
          facts: [],
          emptyStateMarkdown: null,
        },
        {
          kind: 'change-map',
          title: 'Change map',
          part: 1,
          totalParts: 3,
          items: [changeMapItem('src/a.ts'), changeMapItem('src/b.ts')],
          totalFiles: 40,
        },
        {
          kind: 'change-map',
          title: 'Change map',
          part: 2,
          totalParts: 3,
          items: [changeMapItem('src/c.ts'), changeMapItem('src/d.ts')],
          totalFiles: 40,
        },
        {
          kind: 'change-map',
          title: 'Change map',
          part: 3,
          totalParts: 3,
          items: [changeMapItem('src/e.ts')],
          totalFiles: 40,
        },
      ],
    };
    const [, partOne, partTwo, partThree] = document.slides as Array<
      Extract<ReportDeckSlide, { kind: 'change-map' }>
    >;

    // Part 2 shows 2 files, but 4 have been shown cumulatively through part
    // 2 (2 in part 1 + 2 in part 2) — the footnote must say 4, not 2.
    expect(changeMapFootnote(partTwo!, document)).toBe(
      '4 of 40 files · part 2 of 3',
    );
    expect(changeMapFootnote(partOne!, document)).toBe(
      '2 of 40 files · part 1 of 3',
    );
    expect(changeMapFootnote(partThree!, document)).toBe(
      '5 of 40 files · part 3 of 3',
    );
  });

  it('omits the appendix remainder when nothing is deferred to the appendix', () => {
    const document: ReportDeckDocument = {
      version: 2,
      eyebrow: 'PR REVIEW',
      title: 'Single-part change map',
      subtitle: null,
      summaryMarkdown: 'Summary',
      generatedAt: '2026-07-15T12:00:00.000Z',
      links: [],
      slides: [
        {
          kind: 'summary',
          title: 'Review brief',
          facts: [],
          emptyStateMarkdown: null,
        },
        {
          kind: 'change-map',
          title: 'Change map',
          part: 1,
          totalParts: 1,
          items: [changeMapItem('src/a.ts')],
          totalFiles: 1,
        },
      ],
    };
    const slide = document.slides[1] as Extract<
      ReportDeckSlide,
      { kind: 'change-map' }
    >;
    expect(changeMapFootnote(slide, document)).toBe(
      '1 of 1 files · part 1 of 1',
    );
    expect(changeMapFootnote(slide, document)).not.toContain('appendix');
  });

  it('includes the appendix remainder only when files are actually deferred', () => {
    const document: ReportDeckDocument = {
      version: 2,
      eyebrow: 'PR REVIEW',
      title: 'Overflowed change map',
      subtitle: null,
      summaryMarkdown: 'Summary',
      generatedAt: '2026-07-15T12:00:00.000Z',
      links: [],
      slides: [
        {
          kind: 'summary',
          title: 'Review brief',
          facts: [],
          emptyStateMarkdown: null,
        },
        {
          kind: 'change-map',
          title: 'Change map',
          part: 1,
          totalParts: 1,
          items: [changeMapItem('src/a.ts')],
          totalFiles: 3,
        },
        {
          kind: 'appendix',
          title: 'Change map appendix',
          bodyMarkdown: 'Remaining files.',
          groups: [
            {
              kind: 'change-map',
              title: 'Remaining changed files',
              items: [changeMapItem('src/b.ts'), changeMapItem('src/c.ts')],
            },
          ],
        },
      ],
    };
    const slide = document.slides[1] as Extract<
      ReportDeckSlide,
      { kind: 'change-map' }
    >;
    expect(changeMapFootnote(slide, document)).toBe(
      '1 of 3 files · part 1 of 1 · remaining 2 in appendix',
    );
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

  it('uses trusted file facts and keeps next actions distinct from checks', () => {
    const result = buildReviewReportDecks({
      sourceRef: 'pandemicsyn/neondeck#125',
      state: reviewState(),
      files: [
        reviewFile('src/app.ts', 'https://example.com/src/app.ts', {
          additions: 5,
          deletions: 1,
        }),
        reviewFile('src/extra.ts', 'https://example.com/src/extra.ts', {
          additions: 2,
          deletions: 0,
        }),
      ],
      output: {
        overview: {
          summary: 'Summary',
          changeMap: [{ path: 'src/app.ts', summary: 'Changes the app.' }],
          checks: ['Run unit tests.'],
          risks: [],
          nextActions: ['Add a regression fixture.'],
        },
        findings: [],
        presentation: {
          overview: [
            { kind: 'source', source: 'pr-facts', layout: 'facts' },
            { kind: 'source', source: 'checks', layout: 'columns' },
            {
              kind: 'source',
              source: 'next-actions',
              layout: 'columns',
            },
          ],
          issues: [],
        },
      },
      seededFindings: [],
      reportOnlyFindings: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
    });

    const facts = result.overview.document.slides.find(
      (slide) => slide.kind === 'facts',
    );
    expect(facts).toMatchObject({
      kind: 'facts',
      items: expect.arrayContaining([
        expect.objectContaining({ label: 'Base', value: 'main' }),
        expect.objectContaining({ label: 'Head', value: 'abc123' }),
        expect.objectContaining({ label: 'Additions', value: '7' }),
        expect.objectContaining({ label: 'Deletions', value: '1' }),
      ]),
    });
    const summary = result.overview.document.slides.find(
      (slide) => slide.kind === 'summary',
    );
    expect(summary).toMatchObject({
      kind: 'summary',
      facts: expect.arrayContaining([
        expect.objectContaining({ label: 'Changed files', value: '2' }),
      ]),
    });
    expect(result.overview.document.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'columns',
          title: 'Checks',
          columns: [expect.objectContaining({ items: ['Run unit tests.'] })],
        }),
        expect.objectContaining({
          kind: 'columns',
          title: 'Next actions',
          columns: [
            expect.objectContaining({ items: ['Add a regression fixture.'] }),
          ],
        }),
      ]),
    );
  });

  it('honors bounded slide intent and restores omitted required data', () => {
    const result = buildReviewReportDecks({
      sourceRef: 'pandemicsyn/neondeck#125',
      state: reviewState(),
      files: [reviewFile('src/app.ts', 'https://example.com/src/app.ts')],
      output: {
        overview: {
          summary: 'Summary',
          changeMap: [{ path: 'src/app.ts', summary: 'Changes the app.' }],
          checks: ['Run unit tests.'],
          risks: ['Confirm retained report behavior.'],
        },
        findings: [],
        presentation: {
          overview: [
            {
              kind: 'markdown',
              title: 'Why this matters',
              markdown: 'The agent can shape **bounded** narrative slides.',
              tone: 'correctness',
            },
            {
              kind: 'source',
              source: 'risks',
              layout: 'columns',
              title: 'Watch closely',
            },
            { kind: 'source', source: 'pr-facts', layout: 'facts' },
          ],
          issues: [],
        },
      },
      seededFindings: [],
      reportOnlyFindings: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(result.overview.document.slides).toEqual([
      expect.objectContaining({ kind: 'summary' }),
      expect.objectContaining({
        kind: 'markdown',
        title: 'Why this matters',
        tone: 'correctness',
      }),
      expect.objectContaining({ kind: 'columns', title: 'Watch closely' }),
      expect.objectContaining({ kind: 'facts', title: 'PR facts' }),
      expect.objectContaining({ kind: 'change-map' }),
    ]);
    expect(result.presentationWarnings).toContain(
      'overview: appended required change-map data omitted by the presentation plan.',
    );
  });

  it('falls back when presentation source and layout semantics conflict', () => {
    const input: Parameters<typeof buildReviewReportDecks>[0] = {
      sourceRef: 'pandemicsyn/neondeck#125',
      state: reviewState(),
      files: [],
      output: {
        overview: {
          summary: 'Summary',
          changeMap: [],
          checks: ['Run tests.'],
          risks: [],
        },
        findings: [],
      },
      seededFindings: [],
      reportOnlyFindings: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
    };
    const fallback = buildReviewReportDecks(input);
    const planned = buildReviewReportDecks({
      ...input,
      output: {
        ...input.output,
        presentation: {
          overview: [{ kind: 'source', source: 'checks', layout: 'findings' }],
          issues: [],
        },
      },
    });

    expect(planned.overview.document).toEqual(fallback.overview.document);
    expect(planned.presentationWarnings).toContain(
      'overview: unsupported checks/findings presentation source. The deterministic overview layout was used.',
    );
  });

  it('does not let presentation intent omit known findings', () => {
    const finding = {
      severity: 'major' as const,
      path: 'src/app.ts',
      anchor: { kind: 'inline' as const, side: 'RIGHT' as const, line: 8 },
      summary: 'A known correctness finding.',
      suggestedFix: 'Add the missing guard.',
      confidence: 'high' as const,
    };
    const result = buildReviewReportDecks({
      sourceRef: 'pandemicsyn/neondeck#125',
      state: reviewState(),
      files: [reviewFile('src/app.ts', 'https://example.com/src/app.ts')],
      output: {
        overview: { summary: 'Summary', changeMap: [], checks: [], risks: [] },
        findings: [finding],
        presentation: {
          overview: [],
          issues: [
            {
              kind: 'markdown',
              title: 'Context',
              markdown: 'Useful context, but not a replacement for findings.',
            },
          ],
        },
      },
      seededFindings: [{ finding, line: 8 }],
      reportOnlyFindings: [],
      generatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(result.issues.document.slides).toEqual([
      expect.objectContaining({ kind: 'summary' }),
      expect.objectContaining({ kind: 'markdown', title: 'Context' }),
      expect.objectContaining({
        kind: 'findings',
        disposition: 'seeded',
      }),
    ]);
    expect(result.presentationWarnings).toContain(
      'issues: appended required seeded-comments data omitted by the presentation plan.',
    );
  });

  it('gives the overview and issues decks distinct eyebrows', () => {
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

    expect(result.overview.document.eyebrow).toBe('PR REVIEW · OVERVIEW');
    expect(result.issues.document.eyebrow).toBe('PR REVIEW · ISSUES');
    expect(result.overview.document.eyebrow).not.toBe(
      result.issues.document.eyebrow,
    );
  });

  it('rejects presentation plans beyond the Markdown bounds', () => {
    expect(
      parseReviewPresentationPlan({
        overview: [
          {
            kind: 'markdown',
            title: 'Oversized',
            markdown: 'x'.repeat(6_001),
          },
        ],
        issues: [],
      }),
    ).toBeNull();

    expect(
      parseReviewPresentationPlan({
        overview: Array.from(
          { length: REVIEW_PRESENTATION_LIMITS.markdownSlidesPerArtifact },
          (_, index) => ({
            kind: 'markdown',
            title: `Overview ${index}`,
            markdown: 'x'.repeat(6_000),
          }),
        ),
        issues: Array.from(
          { length: REVIEW_PRESENTATION_LIMITS.markdownSlidesPerArtifact },
          (_, index) => ({
            kind: 'markdown',
            title: `Issues ${index}`,
            markdown: 'y'.repeat(6_000),
          }),
        ),
      }),
    ).not.toBeNull();
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

function reviewFile(
  path: string,
  htmlUrl: string,
  churn: { additions?: number; deletions?: number } = {},
) {
  return {
    path,
    htmlUrl,
    additions: churn.additions ?? 0,
    deletions: churn.deletions ?? 0,
  } as Parameters<typeof buildReviewReportDecks>[0]['files'][number];
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
