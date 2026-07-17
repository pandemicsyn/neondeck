export const REPORT_MARKDOWN_LIMITS = {
  summaryCharacters: 4_000,
  freeformCharacters: 6_000,
  codeBlockCharacters: 4_000,
  tableBodyRows: 12,
  tableColumns: 6,
  tableCellCharacters: 1_000,
  nestingDepth: 4,
  linksPerSlide: 32,
  linksPerArtifact: 128,
  urlCharacters: 2_048,
} as const;

export const REPORT_MARKDOWN_ALLOWED_ELEMENTS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h2',
  'h3',
  'h4',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

const absoluteHttpUrl = /^https?:\/\//iu;
const unsafeUrlCharacters = /[\u0000-\u001f\u007f\s]/u;

export function safeReportUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > REPORT_MARKDOWN_LIMITS.urlCharacters ||
    unsafeUrlCharacters.test(value) ||
    !absoluteHttpUrl.test(value)
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.hostname.length === 0
    ) {
      return null;
    }

    const normalized = parsed.href;
    return normalized.length <= REPORT_MARKDOWN_LIMITS.urlCharacters
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export function reportMarkdownUrlTransform(value: string) {
  return safeReportUrl(value);
}
