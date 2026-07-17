import type { ReportDeckDocument } from './report-deck';

export const representativeReportDeckFixture = {
  version: 2,
  eyebrow: 'PR REVIEW',
  title: 'PR Overview: pandemicsyn/neondeck#125',
  summaryMarkdown:
    'The review keeps the narrative **brief** and makes [`report-deck.ts`](https://github.com/pandemicsyn/neondeck) actionable.',
  generatedAt: '2026-07-15T12:00:00.000Z',
  links: [
    {
      kind: 'primary',
      label: 'Open PR',
      href: 'https://github.com/pandemicsyn/neondeck/pull/125',
    },
  ],
  slides: [
    {
      kind: 'summary',
      title: 'Review brief',
      facts: [
        { label: 'State', value: 'open', href: null },
        { label: 'Review SHA', value: 'abc123', href: null },
      ],
      emptyStateMarkdown: null,
    },
    {
      kind: 'facts',
      title: 'PR facts',
      items: [
        { label: 'Base', value: 'main', href: null },
        { label: 'Head', value: 'abc123', href: null },
      ],
    },
    {
      kind: 'columns',
      title: 'Checks and risks',
      columns: [
        { title: 'Checks', tone: 'check', items: ['`npm run check` passes.'] },
        {
          title: 'Risks',
          tone: 'risk',
          items: ['Verify retained v1 report compatibility.'],
        },
      ],
    },
    {
      kind: 'change-map',
      title: 'Change map',
      part: 1,
      totalParts: 1,
      items: [
        {
          path: 'shared/report-deck.ts',
          summaryMarkdown: 'Adds the bounded v2 contract.',
          riskMarkdown: null,
          href: 'https://github.com/pandemicsyn/neondeck',
        },
      ],
    },
    {
      kind: 'findings',
      title: 'Report-only findings',
      disposition: 'report-only',
      part: 1,
      totalParts: 1,
      items: [
        {
          severity: 'minor',
          disposition: 'report-only',
          path: 'shared/report-deck.ts',
          line: 12,
          summaryMarkdown: 'Keep the parser strict.',
          suggestedFixMarkdown: 'Reject invalid version or slide data.',
          confidence: 'high',
          reason: 'fixture',
          href: null,
        },
      ],
    },
    {
      kind: 'appendix',
      title: 'Change map appendix',
      bodyMarkdown: 'Remaining deterministic data stays available.',
      groups: [
        {
          kind: 'change-map',
          title: 'Remaining changed files',
          items: [
            {
              path: 'shared/report-markdown.tsx',
              summaryMarkdown: 'Owns safe Markdown rendering.',
              riskMarkdown: null,
              href: null,
            },
          ],
        },
      ],
    },
  ],
} satisfies ReportDeckDocument;

export const hostileReportMarkdownFixtures = {
  rawHtml:
    'Before <script>alert(1)</script> after <img src=x onerror=alert(2)>.',
  nestedLinks:
    '[outer [inner](https://example.com/inner)](https://example.com/outer)',
  encodedJavascript: '[encoded](jav&#x61;script:alert(1))',
  whitespaceJavascript: '[space](java\tscript:alert(1))',
  protocolRelative: '[protocol relative](//example.com/path)',
  credentials: '[credentials](https://user:secret@example.com/path)',
  giantTable: [
    '| A | B |',
    '| --- | --- |',
    ...Array.from({ length: 13 }, (_, index) => `| ${index} | value |`),
  ].join('\n'),
  overlongUrl: `[long](https://example.com/${'a'.repeat(2_100)})`,
  oversizedCodeBlock: `\`\`\`text\n${'x'.repeat(4_001)}\n\`\`\``,
  excessiveNesting: [
    '- one',
    '  - two',
    '    - three',
    '      - four',
    '        - five',
  ].join('\n'),
  malformedAutolink: '<https://exa mple.com>',
} as const;
