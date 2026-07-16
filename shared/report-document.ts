export type ReportDocumentItem = {
  label: string | null;
  value: string;
};

export type ReportDocumentSection = {
  title: string;
  body: string | null;
  items: ReportDocumentItem[];
};

export type ReportDocument = {
  eyebrow: string | null;
  title: string;
  summary: string | null;
  generatedAt: string;
  sections: ReportDocumentSection[];
};

export function reportDocumentFromSummary(
  summary: unknown,
): ReportDocument | null {
  const summaryRecord = objectRecord(summary);
  return parseReportDocument(summaryRecord?.document);
}

export function parseReportDocument(value: unknown): ReportDocument | null {
  const record = objectRecord(value);
  if (
    !record ||
    !nullableString(record.eyebrow) ||
    typeof record.title !== 'string' ||
    !nullableString(record.summary) ||
    typeof record.generatedAt !== 'string' ||
    !Array.isArray(record.sections)
  ) {
    return null;
  }

  const sections = record.sections.map(parseSection);
  if (sections.some((section) => section === null)) return null;

  return {
    eyebrow: record.eyebrow,
    title: record.title,
    summary: record.summary,
    generatedAt: record.generatedAt,
    sections: sections as ReportDocumentSection[],
  };
}

function parseSection(value: unknown): ReportDocumentSection | null {
  const record = objectRecord(value);
  if (
    !record ||
    typeof record.title !== 'string' ||
    !nullableString(record.body) ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  const items = record.items.map(parseItem);
  if (items.some((item) => item === null)) return null;
  return {
    title: record.title,
    body: record.body,
    items: items as ReportDocumentItem[],
  };
}

function parseItem(value: unknown): ReportDocumentItem | null {
  const record = objectRecord(value);
  if (
    !record ||
    !nullableString(record.label) ||
    typeof record.value !== 'string'
  ) {
    return null;
  }
  return { label: record.label, value: record.value };
}

function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
