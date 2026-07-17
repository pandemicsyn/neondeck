import {
  REPORT_DECK_LIMITS,
  parseReportDeckDocument,
  type ReportDeckDocument,
  type ReportDeckSlide,
} from './report-deck';
import type { ReportDocument, ReportDocumentItem } from './report-document';
import { REPORT_MARKDOWN_LIMITS } from './report-markdown-policy';

export function reportDocumentToDeck(
  document: ReportDocument,
): ReportDeckDocument | null {
  const generatedAt = isoTimestamp(document.generatedAt);
  const summaryMarkdown = plainTextMarkdown(
    document.summary ?? 'This retained report has no narrative summary.',
  ).slice(0, REPORT_MARKDOWN_LIMITS.summaryCharacters);
  const summarySlide: ReportDeckSlide = {
    kind: 'summary',
    title: 'Review brief',
    facts: [{ label: 'Generated', value: generatedAt, href: null }],
    emptyStateMarkdown: null,
  };
  const sectionSlides = document.sections.flatMap(sectionSlidesForDocument);
  const availableSlides = REPORT_DECK_LIMITS.slides - 1;
  const overflowUsed = sectionSlides.length > availableSlides;
  const normalSlides = overflowUsed
    ? sectionSlides.slice(0, availableSlides - 1)
    : sectionSlides;
  const overflowItems = overflowUsed
    ? sectionSlides.slice(availableSlides - 1).flatMap((slide) =>
        slide.kind === 'facts'
          ? slide.items.map((item) => ({
              ...item,
              label: bounded(`${slide.title} · ${item.label}`, 200),
            }))
          : [],
      )
    : [];
  if (overflowItems.length > REPORT_DECK_LIMITS.appendixItems) return null;

  const slides: ReportDeckSlide[] = [
    summarySlide,
    ...normalSlides,
    ...(overflowUsed
      ? [
          {
            kind: 'appendix' as const,
            title: 'Retained report appendix',
            bodyMarkdown:
              'Additional retained report data is collected here for compatibility.',
            groups: [
              {
                kind: 'facts' as const,
                title: 'Additional report data',
                items: overflowItems,
              },
            ],
          },
        ]
      : []),
  ];

  return parseReportDeckDocument({
    version: 2,
    eyebrow: document.eyebrow ? bounded(document.eyebrow, 200) : null,
    title: bounded(document.title, 200),
    summaryMarkdown,
    generatedAt,
    links: [],
    slides,
  });
}

function sectionSlidesForDocument(
  section: ReportDocument['sections'][number],
): ReportDeckSlide[] {
  const items = [
    ...(section.body?.trim()
      ? [{ label: 'Summary', value: section.body, href: null }]
      : []),
    ...section.items.flatMap(boundedFacts),
  ];
  if (items.length === 0) return [];
  const pages = paginate(items, REPORT_DECK_LIMITS.factItems);
  return pages.map((page, index) => ({
    kind: 'facts',
    title: bounded(
      pages.length > 1
        ? `${section.title} · part ${index + 1} of ${pages.length}`
        : section.title,
      200,
    ),
    items: page,
  }));
}

function boundedFacts(item: ReportDocumentItem) {
  const value = item.value.trim();
  if (!value) return [];
  const chunks: string[] = [];
  for (
    let index = 0;
    index < value.length;
    index += REPORT_DECK_LIMITS.factValueCharacters
  ) {
    chunks.push(
      value.slice(index, index + REPORT_DECK_LIMITS.factValueCharacters),
    );
  }
  return chunks.map((chunk, index) => ({
    label: bounded(
      `${item.label ?? 'item'}${chunks.length > 1 ? ` · ${index + 1}` : ''}`,
      REPORT_DECK_LIMITS.labelCharacters,
    ),
    value: chunk,
    href: null,
  }));
}

function plainTextMarkdown(value: string) {
  return value.replaceAll(/([\\`*_[\]{}()#+.!<>|~-])/gu, '\\$1');
}

function bounded(value: string, maxLength: number) {
  const normalized = value.trim() || 'Untitled report';
  return normalized.slice(0, maxLength);
}

function isoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : '1970-01-01T00:00:00.000Z';
}

function paginate<T>(items: T[], pageSize: number) {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += pageSize) {
    pages.push(items.slice(index, index + pageSize));
  }
  return pages;
}
