import * as v from 'valibot';
import {
  REPORT_MARKDOWN_LIMITS,
  safeReportUrl,
} from './report-markdown-policy';

export const REPORT_DECK_LIMITS = {
  slides: 48,
  titleCharacters: 200,
  labelCharacters: 200,
  factValueCharacters: 4_000,
  itemProseCharacters: 4_000,
  normalChangeMapItems: 6,
  normalFindingItems: 4,
  appendixItems: 4_096,
  summaryFacts: 12,
  factItems: 20,
  columns: 4,
  columnItems: 20,
} as const;

const titleSchema = boundedText(REPORT_DECK_LIMITS.titleCharacters);
const labelSchema = boundedText(REPORT_DECK_LIMITS.labelCharacters);
const proseSchema = boundedText(REPORT_DECK_LIMITS.itemProseCharacters);
const safeUrlSchema = v.pipe(
  v.string(),
  v.maxLength(REPORT_MARKDOWN_LIMITS.urlCharacters),
  v.check((value) => safeReportUrl(value) !== null, 'Invalid report URL.'),
  v.transform((value) => safeReportUrl(value) as string),
);
const nullableSafeUrlSchema = v.nullable(safeUrlSchema);

export const reportDeckLinkSchema = v.object({
  kind: v.picklist(['primary', 'source', 'file', 'finding', 'workbench']),
  label: labelSchema,
  href: safeUrlSchema,
});

const reportDeckFactSchema = v.object({
  label: labelSchema,
  value: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(REPORT_DECK_LIMITS.factValueCharacters),
  ),
  href: nullableSafeUrlSchema,
});

const reportDeckColumnSchema = v.object({
  title: titleSchema,
  tone: v.picklist(['neutral', 'check', 'risk', 'positive']),
  items: boundedNonEmptyArray(proseSchema, REPORT_DECK_LIMITS.columnItems),
});

export const reportDeckChangeMapItemSchema = v.object({
  path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  summaryMarkdown: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(2_000),
  ),
  riskMarkdown: v.nullable(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  ),
  href: nullableSafeUrlSchema,
});

export const reportDeckFindingItemSchema = v.object({
  severity: v.picklist(['critical', 'major', 'minor', 'nit']),
  disposition: v.picklist(['seeded', 'report-only']),
  path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  line: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  summaryMarkdown: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(1_000),
  ),
  suggestedFixMarkdown: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(4_000),
  ),
  confidence: v.nullable(v.picklist(['high', 'medium', 'low'])),
  reason: v.nullable(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  ),
  href: nullableSafeUrlSchema,
});

const reportDeckSummarySlideSchema = v.object({
  kind: v.literal('summary'),
  title: titleSchema,
  facts: boundedArray(reportDeckFactSchema, REPORT_DECK_LIMITS.summaryFacts),
  emptyStateMarkdown: v.nullable(proseSchema),
});

const reportDeckFactsSlideSchema = v.object({
  kind: v.literal('facts'),
  title: titleSchema,
  items: boundedArray(reportDeckFactSchema, REPORT_DECK_LIMITS.factItems),
});

const reportDeckColumnsSlideSchema = v.object({
  kind: v.literal('columns'),
  title: titleSchema,
  columns: boundedNonEmptyArray(
    reportDeckColumnSchema,
    REPORT_DECK_LIMITS.columns,
  ),
});

const reportDeckChangeMapSlideSchema = v.object({
  kind: v.literal('change-map'),
  title: titleSchema,
  part: v.pipe(v.number(), v.integer(), v.minValue(1)),
  totalParts: v.pipe(v.number(), v.integer(), v.minValue(1)),
  items: v.pipe(
    v.array(reportDeckChangeMapItemSchema),
    v.minLength(1),
    v.maxLength(REPORT_DECK_LIMITS.normalChangeMapItems),
  ),
});

const reportDeckFindingsSlideSchema = v.object({
  kind: v.literal('findings'),
  title: titleSchema,
  disposition: v.picklist(['seeded', 'report-only']),
  part: v.pipe(v.number(), v.integer(), v.minValue(1)),
  totalParts: v.pipe(v.number(), v.integer(), v.minValue(1)),
  items: v.pipe(
    v.array(reportDeckFindingItemSchema),
    v.minLength(1),
    v.maxLength(REPORT_DECK_LIMITS.normalFindingItems),
  ),
});

const reportDeckAppendixGroupSchema = v.variant('kind', [
  v.object({
    kind: v.literal('change-map'),
    title: titleSchema,
    items: v.pipe(
      v.array(reportDeckChangeMapItemSchema),
      v.minLength(1),
      v.maxLength(REPORT_DECK_LIMITS.appendixItems),
    ),
  }),
  v.object({
    kind: v.literal('findings'),
    title: titleSchema,
    disposition: v.picklist(['seeded', 'report-only']),
    items: v.pipe(
      v.array(reportDeckFindingItemSchema),
      v.minLength(1),
      v.maxLength(REPORT_DECK_LIMITS.appendixItems),
    ),
  }),
]);

const reportDeckAppendixSlideSchema = v.object({
  kind: v.literal('appendix'),
  title: titleSchema,
  bodyMarkdown: proseSchema,
  groups: v.pipe(
    v.array(reportDeckAppendixGroupSchema),
    v.minLength(1),
    v.maxLength(3),
  ),
});

export const reportDeckSlideSchema = v.variant('kind', [
  reportDeckSummarySlideSchema,
  reportDeckFactsSlideSchema,
  reportDeckColumnsSlideSchema,
  reportDeckChangeMapSlideSchema,
  reportDeckFindingsSlideSchema,
  reportDeckAppendixSlideSchema,
]);

export const reportDeckDocumentSchema = v.pipe(
  v.object({
    version: v.literal(2),
    eyebrow: v.nullable(labelSchema),
    title: titleSchema,
    summaryMarkdown: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(REPORT_MARKDOWN_LIMITS.summaryCharacters),
    ),
    generatedAt: v.pipe(v.string(), v.isoTimestamp()),
    links: boundedArray(
      reportDeckLinkSchema,
      REPORT_MARKDOWN_LIMITS.linksPerArtifact,
    ),
    slides: v.pipe(
      v.array(reportDeckSlideSchema),
      v.minLength(1),
      v.maxLength(REPORT_DECK_LIMITS.slides),
    ),
  }),
  v.check((deck) => deckInvariantsHold(deck), 'Invalid report deck structure.'),
);

export type ReportDeckLink = v.InferOutput<typeof reportDeckLinkSchema>;
export type ReportDeckChangeMapItem = v.InferOutput<
  typeof reportDeckChangeMapItemSchema
>;
export type ReportDeckFindingItem = v.InferOutput<
  typeof reportDeckFindingItemSchema
>;
export type ReportDeckSlide = v.InferOutput<typeof reportDeckSlideSchema>;
export type ReportDeckDocument = v.InferOutput<typeof reportDeckDocumentSchema>;

export function reportDeckFromSummary(summary: unknown) {
  const summaryRecord = objectRecord(summary);
  return parseReportDeckDocument(summaryRecord?.deck);
}

export function parseReportDeckDocument(
  value: unknown,
): ReportDeckDocument | null {
  const parsed = v.safeParse(reportDeckDocumentSchema, value);
  return parsed.success ? parsed.output : null;
}

function deckInvariantsHold(deck: {
  links: ReportDeckLink[];
  slides: ReportDeckSlide[];
}) {
  if (deck.slides[0]?.kind !== 'summary') return false;
  const appendixIndex = deck.slides.findIndex(
    (slide) => slide.kind === 'appendix',
  );
  if (appendixIndex >= 0 && appendixIndex !== deck.slides.length - 1) {
    return false;
  }

  let totalLinks = deck.links.length;
  for (const slide of deck.slides) {
    const slideLinks = linksInSlide(slide);
    if (slideLinks > REPORT_MARKDOWN_LIMITS.linksPerSlide) return false;
    totalLinks += slideLinks;
    if (
      (slide.kind === 'change-map' || slide.kind === 'findings') &&
      (slide.part > slide.totalParts || slide.totalParts < 1)
    ) {
      return false;
    }
    if (
      slide.kind === 'findings' &&
      slide.items.some((item) => item.disposition !== slide.disposition)
    ) {
      return false;
    }
    if (
      slide.kind === 'appendix' &&
      slide.groups.some(
        (group) =>
          group.kind === 'findings' &&
          group.items.some((item) => item.disposition !== group.disposition),
      )
    ) {
      return false;
    }
  }
  return totalLinks <= REPORT_MARKDOWN_LIMITS.linksPerArtifact;
}

function linksInSlide(slide: ReportDeckSlide) {
  switch (slide.kind) {
    case 'summary':
      return slide.facts.filter((fact) => fact.href !== null).length;
    case 'facts':
      return slide.items.filter((fact) => fact.href !== null).length;
    case 'change-map':
    case 'findings':
      return slide.items.filter((item) => item.href !== null).length;
    case 'appendix':
      return slide.groups.reduce(
        (count, group) =>
          count + group.items.filter((item) => item.href !== null).length,
        0,
      );
    case 'columns':
      return 0;
  }
}

function boundedText(maxLength: number) {
  return v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maxLength));
}

function boundedArray<
  TItem extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(item: TItem, maxLength: number) {
  return v.pipe(v.array(item), v.maxLength(maxLength));
}

function boundedNonEmptyArray<
  TItem extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(item: TItem, maxLength: number) {
  return v.pipe(v.array(item), v.minLength(1), v.maxLength(maxLength));
}

function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
