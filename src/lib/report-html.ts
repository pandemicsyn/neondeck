import { withReportThemeBootstrap } from '../../shared/theme-bootstrap';

export type ReportHtmlSection = {
  title: string;
  body?: string | null;
  items?: Array<{
    label?: string | null;
    value: string;
  }>;
};

export type RenderReportHtmlInput = {
  title: string;
  eyebrow?: string | null;
  summary?: string | null;
  sections?: ReportHtmlSection[];
  generatedAt?: string | Date;
};

export function renderReportHtml(input: RenderReportHtmlInput) {
  const generatedAt = dateText(input.generatedAt ?? new Date());
  const sections = (input.sections ?? []).map(renderSection).join('\n');
  const summary = input.summary
    ? `<p class="summary">${escapeHtml(input.summary)}</p>`
    : '';
  const eyebrow = input.eyebrow
    ? `<p class="eyebrow">${escapeHtml(input.eyebrow)}</p>`
    : '';

  return withReportThemeBootstrap(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0a0b10;
      --panel: #0c0d12;
      --field: #070810;
      --line: #ffffff1f;
      --ink: #d7f7ff;
      --muted: #d7f7ff99;
      --primary: #69e6ff;
      --accent: #ff4fb8;
      --violet: #8b4dff;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #edf5f8;
        --panel: #f7fbfd;
        --field: #dbeaef;
        --line: #142d3c24;
        --ink: #19232e;
        --muted: #334653;
        --primary: #007f91;
        --accent: #b71f78;
        --violet: #7044d8;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 13px/1.55 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
      padding: 28px;
    }
    header {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, #69e6ff12, transparent 60%), var(--panel);
      padding: 18px 20px;
    }
    .eyebrow,
    .meta,
    h2,
    dt {
      font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .eyebrow {
      margin: 0 0 7px;
      color: var(--primary);
      font-size: 10px;
      letter-spacing: 0.08em;
    }
    h1 {
      margin: 0;
      font: 600 20px/1.25 "Chakra Petch", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }
    .summary {
      margin: 10px 0 0;
      max-width: 74ch;
      color: var(--muted);
    }
    .meta {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 10px;
    }
    section {
      margin-top: 14px;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 16px 18px;
    }
    h2 {
      margin: 0 0 10px;
      color: var(--primary);
      font-size: 12px;
      letter-spacing: 0.06em;
    }
    p {
      margin: 0;
      max-width: 74ch;
    }
    dl {
      display: grid;
      grid-template-columns: minmax(120px, 0.34fr) 1fr;
      gap: 8px 14px;
      margin: 0;
    }
    dt {
      min-width: 0;
      color: var(--muted);
      font-size: 10px;
      overflow-wrap: anywhere;
    }
    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li + li {
      margin-top: 6px;
    }
    code {
      background: var(--field);
      color: var(--primary);
      padding: 1px 4px;
      font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  </style>
</head>
<body>
  <main>
    <header>
      ${eyebrow}
      <h1>${escapeHtml(input.title)}</h1>
      ${summary}
      <p class="meta">generated ${escapeHtml(generatedAt)}</p>
    </header>
    ${sections}
  </main>
</body>
</html>
`);
}

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSection(section: ReportHtmlSection) {
  const body = section.body ? `<p>${escapeHtml(section.body)}</p>` : '';
  const items = section.items?.length
    ? `<dl>${section.items
        .map(
          (item) =>
            `<dt>${escapeHtml(item.label ?? 'item')}</dt><dd>${escapeHtml(item.value)}</dd>`,
        )
        .join('')}</dl>`
    : '';
  return `<section><h2>${escapeHtml(section.title)}</h2>${body}${items}</section>`;
}

function dateText(value: string | Date) {
  if (value instanceof Date) return value.toISOString();
  return value;
}
