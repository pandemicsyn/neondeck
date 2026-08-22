import * as v from 'valibot';

const reportDocumentItemSchema = v.object({
  label: v.nullable(v.string()),
  value: v.string(),
});

const reportDocumentSectionSchema = v.object({
  title: v.string(),
  body: v.nullable(v.string()),
  items: v.array(reportDocumentItemSchema),
});

const reportDocumentSchema = v.object({
  eyebrow: v.nullable(v.string()),
  title: v.string(),
  summary: v.nullable(v.string()),
  generatedAt: v.string(),
  sections: v.array(reportDocumentSectionSchema),
});

const reportDocumentExternalValueSchema = v.unknown();
type ReportDocumentExternalValue = v.InferInput<
  typeof reportDocumentExternalValueSchema
>;

export type ReportDocumentItem = v.InferOutput<typeof reportDocumentItemSchema>;
export type ReportDocumentSection = v.InferOutput<
  typeof reportDocumentSectionSchema
>;
export type ReportDocument = v.InferOutput<typeof reportDocumentSchema>;

export function reportDocumentFromSummary(
  summary: ReportDocumentExternalValue,
): ReportDocument | null {
  const summaryRecord = objectRecord(summary);
  return parseReportDocument(summaryRecord?.document);
}

export function parseReportDocument(
  value: ReportDocumentExternalValue,
): ReportDocument | null {
  const parsed = v.safeParse(reportDocumentSchema, value);
  return parsed.success ? parsed.output : null;
}

function objectRecord(value: ReportDocumentExternalValue) {
  if (Array.isArray(value)) return null;
  const parsed = v.safeParse(v.record(v.string(), v.unknown()), value);
  return parsed.success ? parsed.output : null;
}
