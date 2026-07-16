import * as v from 'valibot';
import {
  REPORT_DECK_LIMITS,
  reportDeckDocumentSchema,
  type ReportDeckChangeMapItem,
  type ReportDeckDocument,
  type ReportDeckFindingItem,
  type ReportDeckSlide,
} from '../../../shared/report-deck';
import {
  REPORT_MARKDOWN_LIMITS,
  safeReportUrl,
} from '../../../shared/report-markdown-policy';
import type {
  GitHubPullRequestEventState,
  GitHubPullRequestFile,
} from '../github';
import type {
  ReviewAssistFinding,
  ReviewAssistStructuredOutput,
  ReviewPresentationPlan,
  ReviewPresentationSlide,
} from './schemas';
import { parseReviewPresentationPlan } from './schemas';

export type ReviewReportDeckInput = {
  sourceRef: string;
  state: GitHubPullRequestEventState;
  files: GitHubPullRequestFile[];
  output: ReviewAssistStructuredOutput;
  seededFindings: Array<{
    finding: ReviewAssistFinding;
    line: number;
  }>;
  reportOnlyFindings: Array<{
    finding: ReviewAssistFinding;
    reason: string;
  }>;
  generatedAt: string;
};

export type BuiltReviewReportDeck = {
  document: ReportDeckDocument;
  overflowUsed: boolean;
};

export function buildReviewReportDecks(input: ReviewReportDeckInput) {
  const fileUrls = new Map(
    input.files.map((file) => [file.path, safeReportUrl(file.htmlUrl)]),
  );
  const links = primaryLinks(input.state.url);
  const fallbackOverview = buildOverviewDeck(input, fileUrls, links);
  const fallbackIssues = buildIssuesDeck(input, fileUrls, links);
  if (input.output.presentation === undefined) {
    return {
      overview: fallbackOverview,
      issues: fallbackIssues,
      presentationWarnings: [] as string[],
    };
  }

  const presentation = parseReviewPresentationPlan(input.output.presentation);
  if (!presentation) {
    return {
      overview: fallbackOverview,
      issues: fallbackIssues,
      presentationWarnings: [
        'The agent presentation plan was invalid; deterministic deck layouts were used.',
      ],
    };
  }

  const overviewResult = applyOverviewPresentation(
    input,
    fallbackOverview,
    presentation.overview,
    links,
  );
  const issuesResult = applyIssuesPresentation(
    input,
    fallbackIssues,
    presentation.issues,
    links,
  );
  if (overviewResult.rejected || issuesResult.rejected) {
    return {
      overview: fallbackOverview,
      issues: fallbackIssues,
      presentationWarnings: [
        ...(overviewResult.rejected ? overviewResult.warnings : []),
        ...(issuesResult.rejected ? issuesResult.warnings : []),
      ],
    };
  }
  return {
    overview: overviewResult.deck,
    issues: issuesResult.deck,
    presentationWarnings: [
      ...overviewResult.warnings,
      ...issuesResult.warnings,
    ],
  };
}

function buildOverviewDeck(
  input: ReviewReportDeckInput,
  fileUrls: Map<string, string | null>,
  links: ReportDeckDocument['links'],
): BuiltReviewReportDeck {
  const summarySlide: ReportDeckSlide = {
    kind: 'summary',
    title: 'Review brief',
    facts: [
      { label: 'PR title', value: input.state.title, href: null },
      { label: 'State', value: input.state.state, href: null },
      { label: 'Review SHA', value: input.state.headSha, href: null },
      { label: 'Generated', value: input.generatedAt, href: null },
    ],
    emptyStateMarkdown: null,
  };
  const factsSlide: ReportDeckSlide = {
    kind: 'facts',
    title: 'PR facts',
    items: [
      { label: 'Repository', value: input.state.repo, href: null },
      { label: 'PR', value: String(input.state.number), href: null },
      { label: 'State', value: input.state.state, href: null },
      { label: 'Base', value: input.state.baseRef, href: null },
      { label: 'Head', value: input.state.headSha, href: null },
      {
        label: 'Files',
        value: String(input.output.overview.changeMap.length),
        href: null,
      },
    ],
  };
  const changeItems: ReportDeckChangeMapItem[] =
    input.output.overview.changeMap.map((item) => ({
      path: item.path,
      summaryMarkdown: item.summary,
      riskMarkdown: item.risk || null,
      href: fileUrls.get(item.path) ?? null,
    }));
  const columnsSlide = buildChecksAndRisksSlide(input.output);
  const trailingSlides = columnsSlide ? [columnsSlide] : [];
  const availableChangeSlides =
    REPORT_DECK_LIMITS.slides - 2 - trailingSlides.length;
  const changePages = paginate(
    changeItems,
    REPORT_DECK_LIMITS.normalChangeMapItems,
  );
  const overflowUsed = changePages.length > availableChangeSlides;
  const normalPageCount = overflowUsed
    ? Math.max(0, availableChangeSlides - 1)
    : changePages.length;
  const normalSlides = changePages
    .slice(0, normalPageCount)
    .map<ReportDeckSlide>((items, index) => ({
      kind: 'change-map',
      title: 'Change map',
      part: index + 1,
      totalParts: changePages.length,
      items,
    }));
  const appendixItems = changeItems.slice(
    normalPageCount * REPORT_DECK_LIMITS.normalChangeMapItems,
  );
  const appendixSlide: ReportDeckSlide[] = overflowUsed
    ? [
        {
          kind: 'appendix',
          title: 'Change map appendix',
          bodyMarkdown:
            'The remaining changed files are collected here so the deck stays within its slide limit.',
          groups: [
            {
              kind: 'change-map',
              title: 'Remaining changed files',
              items: appendixItems,
            },
          ],
        },
      ]
    : [];

  return {
    document: parseBuiltDeck({
      version: 2,
      eyebrow: 'PR REVIEW',
      title: `PR Overview: ${input.sourceRef}`,
      summaryMarkdown: input.output.overview.summary,
      generatedAt: input.generatedAt,
      links,
      slides: withBoundedLinks(
        [
          summarySlide,
          factsSlide,
          ...normalSlides,
          ...trailingSlides,
          ...appendixSlide,
        ],
        links.length,
      ),
    }),
    overflowUsed,
  };
}

function buildIssuesDeck(
  input: ReviewReportDeckInput,
  fileUrls: Map<string, string | null>,
  links: ReportDeckDocument['links'],
): BuiltReviewReportDeck {
  const findingCount =
    input.seededFindings.length + input.reportOnlyFindings.length;
  const summaryMarkdown =
    findingCount === 0
      ? 'No structured review findings were produced.'
      : `${findingCount} structured finding${findingCount === 1 ? '' : 's'}; ${input.seededFindings.length} seeded as local draft comment${input.seededFindings.length === 1 ? '' : 's'} and ${input.reportOnlyFindings.length} kept in the report.`;
  const summarySlide: ReportDeckSlide = {
    kind: 'summary',
    title: 'Review brief',
    facts: [
      { label: 'Findings', value: String(findingCount), href: null },
      {
        label: 'Seeded comments',
        value: String(input.seededFindings.length),
        href: null,
      },
      {
        label: 'Report only',
        value: String(input.reportOnlyFindings.length),
        href: null,
      },
      { label: 'Review SHA', value: input.state.headSha, href: null },
    ],
    emptyStateMarkdown:
      findingCount === 0
        ? 'There is nothing to triage in this review pass. Open the PR to inspect the change directly.'
        : null,
  };
  const seededItems = sortFindings(
    input.seededFindings.map(({ finding, line }) =>
      findingItem(finding, 'seeded', line, null, fileUrls),
    ),
  );
  const reportOnlyItems = sortFindings(
    input.reportOnlyFindings.map(({ finding, reason }) =>
      findingItem(
        finding,
        'report-only',
        finding.anchor.kind === 'inline' ? finding.anchor.line : null,
        reason,
        fileUrls,
      ),
    ),
  );
  const findingPages = [
    ...findingSlides('Seeded draft comments', 'seeded', seededItems),
    ...findingSlides('Report-only findings', 'report-only', reportOnlyItems),
  ];
  const availableFindingSlides = REPORT_DECK_LIMITS.slides - 1;
  const overflowUsed = findingPages.length > availableFindingSlides;
  const normalPageCount = overflowUsed
    ? availableFindingSlides - 1
    : findingPages.length;
  const normalSlides = findingPages.slice(0, normalPageCount);
  const consumedSeeded = normalSlides
    .filter(
      (slide): slide is Extract<ReportDeckSlide, { kind: 'findings' }> =>
        slide.kind === 'findings' && slide.disposition === 'seeded',
    )
    .reduce((count, slide) => count + slide.items.length, 0);
  const consumedReportOnly = normalSlides
    .filter(
      (slide): slide is Extract<ReportDeckSlide, { kind: 'findings' }> =>
        slide.kind === 'findings' && slide.disposition === 'report-only',
    )
    .reduce((count, slide) => count + slide.items.length, 0);
  const appendixGroups = [
    ...(seededItems.length > consumedSeeded
      ? [
          {
            kind: 'findings' as const,
            title: 'Remaining seeded comments',
            disposition: 'seeded' as const,
            items: seededItems.slice(consumedSeeded),
          },
        ]
      : []),
    ...(reportOnlyItems.length > consumedReportOnly
      ? [
          {
            kind: 'findings' as const,
            title: 'Remaining report-only findings',
            disposition: 'report-only' as const,
            items: reportOnlyItems.slice(consumedReportOnly),
          },
        ]
      : []),
  ];
  const appendixSlide: ReportDeckSlide[] = overflowUsed
    ? [
        {
          kind: 'appendix',
          title: 'Findings appendix',
          bodyMarkdown:
            'The remaining findings are collected here so the deck stays within its slide limit.',
          groups: appendixGroups,
        },
      ]
    : [];

  return {
    document: parseBuiltDeck({
      version: 2,
      eyebrow: 'PR REVIEW',
      title: `Review Issues: ${input.sourceRef}`,
      summaryMarkdown,
      generatedAt: input.generatedAt,
      links,
      slides: withBoundedLinks(
        [summarySlide, ...normalSlides, ...appendixSlide],
        links.length,
      ),
    }),
    overflowUsed,
  };
}

function buildChecksAndRisksSlide(
  output: ReviewAssistStructuredOutput,
): ReportDeckSlide | null {
  const columns = [
    ...(output.overview.checks.length > 0
      ? [
          {
            title: 'Checks',
            tone: 'check' as const,
            items: output.overview.checks,
          },
        ]
      : []),
    ...(output.overview.risks.length > 0
      ? [
          {
            title: 'Risks',
            tone: 'risk' as const,
            items: output.overview.risks,
          },
        ]
      : []),
  ];
  return columns.length > 0
    ? { kind: 'columns', title: 'Checks and risks', columns }
    : null;
}

function findingSlides(
  title: string,
  disposition: 'seeded' | 'report-only',
  findings: ReportDeckFindingItem[],
) {
  const pages = paginate(findings, REPORT_DECK_LIMITS.normalFindingItems);
  return pages.map<ReportDeckSlide>((items, index) => ({
    kind: 'findings',
    title,
    disposition,
    part: index + 1,
    totalParts: pages.length,
    items,
  }));
}

function findingItem(
  finding: ReviewAssistFinding,
  disposition: 'seeded' | 'report-only',
  line: number | null,
  reason: string | null,
  fileUrls: Map<string, string | null>,
): ReportDeckFindingItem {
  return {
    severity: finding.severity,
    disposition,
    path: finding.path,
    line,
    summaryMarkdown: finding.summary,
    suggestedFixMarkdown: finding.suggestedFix,
    confidence: finding.confidence ?? null,
    reason,
    href: fileUrls.get(finding.path) ?? null,
  };
}

function sortFindings(findings: ReportDeckFindingItem[]) {
  const rank = { critical: 0, major: 1, minor: 2, nit: 3 } as const;
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (left, right) =>
        rank[left.finding.severity] - rank[right.finding.severity] ||
        left.index - right.index,
    )
    .map(({ finding }) => finding);
}

type PresentationResult = {
  deck: BuiltReviewReportDeck;
  rejected: boolean;
  warnings: string[];
};

function applyOverviewPresentation(
  input: ReviewReportDeckInput,
  fallback: BuiltReviewReportDeck,
  entries: ReviewPresentationPlan['overview'],
  links: ReportDeckDocument['links'],
): PresentationResult {
  const requiredSources = [
    ...(input.output.overview.changeMap.length > 0
      ? (['change-map'] as const)
      : []),
    ...(input.output.overview.risks.length > 0 ? (['risks'] as const) : []),
  ];
  return applyPresentation({
    artifact: 'overview',
    entries,
    fallback,
    links,
    requiredSources,
    resolveSource: (source) => overviewSlidesForSource(source, input, fallback),
  });
}

function applyIssuesPresentation(
  input: ReviewReportDeckInput,
  fallback: BuiltReviewReportDeck,
  entries: ReviewPresentationPlan['issues'],
  links: ReportDeckDocument['links'],
): PresentationResult {
  const requiredSources = [
    ...(input.seededFindings.length > 0 ? (['seeded-comments'] as const) : []),
    ...(input.reportOnlyFindings.length > 0
      ? (['report-only-findings'] as const)
      : []),
  ];
  return applyPresentation({
    artifact: 'issues',
    entries,
    fallback,
    links,
    requiredSources,
    resolveSource: (source) => issuesSlidesForSource(source, fallback),
  });
}

function applyPresentation(input: {
  artifact: 'overview' | 'issues';
  entries: ReviewPresentationSlide[];
  fallback: BuiltReviewReportDeck;
  links: ReportDeckDocument['links'];
  requiredSources: string[];
  resolveSource: (source: string) => ReportDeckSlide[] | null;
}): PresentationResult {
  const warnings: string[] = [];
  const selectedSources = new Set<string>();
  const plannedSlides: ReportDeckSlide[] = [];
  const hasCombinedFindings = input.entries.some(
    (entry) => entry.kind === 'source' && entry.source === 'findings',
  );

  for (const entry of input.entries) {
    if (entry.kind === 'markdown') {
      plannedSlides.push({
        kind: 'markdown',
        title: entry.title,
        markdown: entry.markdown,
        tone: entry.tone,
      });
      continue;
    }
    if (
      hasCombinedFindings &&
      (entry.source === 'seeded-comments' ||
        entry.source === 'report-only-findings')
    ) {
      warnings.push(
        `${input.artifact}: ignored duplicate ${entry.source} source because findings already includes it.`,
      );
      continue;
    }
    if (selectedSources.has(entry.source)) {
      warnings.push(
        `${input.artifact}: ignored duplicate ${entry.source} source.`,
      );
      continue;
    }
    const expectedLayout = presentationLayout(entry.source);
    const sourceSlides = input.resolveSource(entry.source);
    if (entry.layout !== expectedLayout || sourceSlides === null) {
      return fallbackPresentation(
        input,
        `${input.artifact}: unsupported ${entry.source}/${entry.layout} presentation source.`,
      );
    }
    selectedSources.add(entry.source);
    plannedSlides.push(...retitleSlides(sourceSlides, entry.title));
  }

  for (const requiredSource of input.requiredSources) {
    if (sourceCovers(selectedSources, requiredSource)) continue;
    const sourceSlides = input.resolveSource(requiredSource);
    if (sourceSlides === null) {
      return fallbackPresentation(
        input,
        `${input.artifact}: could not restore required ${requiredSource} data.`,
      );
    }
    selectedSources.add(requiredSource);
    plannedSlides.push(...sourceSlides);
    warnings.push(
      `${input.artifact}: appended required ${requiredSource} data omitted by the presentation plan.`,
    );
  }

  const slides = normalizeAppendices([
    input.fallback.document.slides[0]!,
    ...plannedSlides,
  ]);
  if (slides.length > REPORT_DECK_LIMITS.slides) {
    return fallbackPresentation(
      input,
      `${input.artifact}: resolved presentation exceeded the deck slide bound.`,
    );
  }

  try {
    const document = parseBuiltDeck({
      ...input.fallback.document,
      slides: withBoundedLinks(slides, input.links.length),
    });
    return {
      deck: {
        document,
        overflowUsed:
          input.fallback.overflowUsed ||
          document.slides.some((slide) => slide.kind === 'appendix'),
      },
      rejected: false,
      warnings,
    };
  } catch {
    return fallbackPresentation(
      input,
      `${input.artifact}: resolved presentation was invalid.`,
    );
  }
}

function fallbackPresentation(
  input: Pick<PresentationResultInput, 'fallback'> & { artifact: string },
  warning: string,
): PresentationResult {
  return {
    deck: input.fallback,
    rejected: true,
    warnings: [
      `${warning} The deterministic ${input.artifact} layout was used.`,
    ],
  };
}

type PresentationResultInput = Parameters<typeof applyPresentation>[0];

function overviewSlidesForSource(
  source: string,
  input: ReviewReportDeckInput,
  fallback: BuiltReviewReportDeck,
): ReportDeckSlide[] | null {
  switch (source) {
    case 'pr-facts':
      return fallback.document.slides.filter((slide) => slide.kind === 'facts');
    case 'checks':
      return singleColumnSlide(
        'Checks',
        'Checks',
        'check',
        input.output.overview.checks,
      );
    case 'risks':
      return singleColumnSlide(
        'Risks',
        'Risks',
        'risk',
        input.output.overview.risks,
      );
    case 'next-actions':
      return singleColumnSlide(
        'Next actions',
        'Next actions',
        'check',
        input.output.overview.checks,
      );
    case 'change-map':
      return slidesForKind(fallback, 'change-map');
    default:
      return null;
  }
}

function issuesSlidesForSource(
  source: string,
  fallback: BuiltReviewReportDeck,
): ReportDeckSlide[] | null {
  switch (source) {
    case 'findings':
      return slidesForKind(fallback, 'findings');
    case 'seeded-comments':
      return findingSlidesForDisposition(fallback, 'seeded');
    case 'report-only-findings':
      return findingSlidesForDisposition(fallback, 'report-only');
    default:
      return null;
  }
}

function slidesForKind(
  deck: BuiltReviewReportDeck,
  kind: 'change-map' | 'findings',
) {
  const slides = deck.document.slides.filter((slide) => slide.kind === kind);
  const groups = deck.document.slides.flatMap((slide) =>
    slide.kind === 'appendix'
      ? slide.groups.filter((group) => group.kind === kind)
      : [],
  );
  return groups.length > 0
    ? [
        ...slides,
        {
          kind: 'appendix' as const,
          title:
            kind === 'change-map' ? 'Change map appendix' : 'Findings appendix',
          bodyMarkdown: 'Remaining deterministic review data.',
          groups,
        },
      ]
    : slides;
}

function findingSlidesForDisposition(
  deck: BuiltReviewReportDeck,
  disposition: 'seeded' | 'report-only',
) {
  const slides = deck.document.slides.filter(
    (slide): slide is Extract<ReportDeckSlide, { kind: 'findings' }> =>
      slide.kind === 'findings' && slide.disposition === disposition,
  );
  const groups = deck.document.slides.flatMap((slide) =>
    slide.kind === 'appendix'
      ? slide.groups.filter(
          (group) =>
            group.kind === 'findings' && group.disposition === disposition,
        )
      : [],
  );
  return groups.length > 0
    ? [
        ...slides,
        {
          kind: 'appendix' as const,
          title: 'Findings appendix',
          bodyMarkdown: 'Remaining deterministic review findings.',
          groups,
        },
      ]
    : slides;
}

function singleColumnSlide(
  title: string,
  columnTitle: string,
  tone: 'check' | 'risk',
  items: string[],
): ReportDeckSlide[] {
  return items.length > 0
    ? [
        {
          kind: 'columns',
          title,
          columns: [{ title: columnTitle, tone, items }],
        },
      ]
    : [];
}

function retitleSlides(slides: ReportDeckSlide[], title?: string) {
  return title ? slides.map((slide) => ({ ...slide, title })) : slides;
}

function normalizeAppendices(slides: ReportDeckSlide[]) {
  const normalSlides = slides.filter((slide) => slide.kind !== 'appendix');
  const appendices = slides.filter(
    (slide): slide is Extract<ReportDeckSlide, { kind: 'appendix' }> =>
      slide.kind === 'appendix',
  );
  if (appendices.length === 0) return normalSlides;
  const groups = appendices.flatMap((slide) => slide.groups);
  return [
    ...normalSlides,
    {
      kind: 'appendix' as const,
      title: appendices[0]!.title,
      bodyMarkdown:
        'Remaining deterministic review data is collected here so the deck stays within its slide limit.',
      groups,
    },
  ];
}

function sourceCovers(sources: Set<string>, requiredSource: string) {
  return (
    sources.has(requiredSource) ||
    (sources.has('findings') &&
      (requiredSource === 'seeded-comments' ||
        requiredSource === 'report-only-findings'))
  );
}

function presentationLayout(source: string) {
  switch (source) {
    case 'pr-facts':
      return 'facts';
    case 'checks':
    case 'risks':
    case 'next-actions':
      return 'columns';
    case 'change-map':
      return 'change-map';
    case 'seeded-comments':
    case 'report-only-findings':
    case 'findings':
      return 'findings';
    default:
      return null;
  }
}

function withBoundedLinks(
  slides: ReportDeckSlide[],
  globalLinkCount: number,
): ReportDeckSlide[] {
  let artifactLinks = globalLinkCount;
  const keepHref = (href: string | null, slideLinks: { count: number }) => {
    if (
      href === null ||
      artifactLinks >= REPORT_MARKDOWN_LIMITS.linksPerArtifact ||
      slideLinks.count >= REPORT_MARKDOWN_LIMITS.linksPerSlide
    ) {
      return null;
    }
    artifactLinks += 1;
    slideLinks.count += 1;
    return href;
  };

  return slides.map((slide) => {
    const slideLinks = { count: 0 };
    switch (slide.kind) {
      case 'summary':
        return {
          ...slide,
          facts: slide.facts.map((fact) => ({
            ...fact,
            href: keepHref(fact.href, slideLinks),
          })),
        };
      case 'facts':
        return {
          ...slide,
          items: slide.items.map((item) => ({
            ...item,
            href: keepHref(item.href, slideLinks),
          })),
        };
      case 'change-map':
        return {
          ...slide,
          items: slide.items.map((item) => ({
            ...item,
            href: keepHref(item.href, slideLinks),
          })),
        };
      case 'findings':
        return {
          ...slide,
          items: slide.items.map((item) => ({
            ...item,
            href: keepHref(item.href, slideLinks),
          })),
        };
      case 'appendix':
        return {
          ...slide,
          groups: slide.groups.map((group) =>
            group.kind === 'facts'
              ? {
                  ...group,
                  items: group.items.map((item) => ({
                    ...item,
                    href: keepHref(item.href, slideLinks),
                  })),
                }
              : group.kind === 'change-map'
                ? {
                    ...group,
                    items: group.items.map((item) => ({
                      ...item,
                      href: keepHref(item.href, slideLinks),
                    })),
                  }
                : {
                    ...group,
                    items: group.items.map((item) => ({
                      ...item,
                      href: keepHref(item.href, slideLinks),
                    })),
                  },
          ),
        };
      case 'columns':
      case 'markdown':
        return slide;
    }
  });
}

function primaryLinks(url: string): ReportDeckDocument['links'] {
  const href = safeReportUrl(url);
  return href ? [{ kind: 'primary', label: 'Open PR', href }] : [];
}

function parseBuiltDeck(value: unknown) {
  return v.parse(reportDeckDocumentSchema, value);
}

function paginate<T>(items: T[], pageSize: number) {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += pageSize) {
    pages.push(items.slice(index, index + pageSize));
  }
  return pages;
}
