import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReportDeckDocument } from '../../shared/report-deck';
import { REPORT_DECK_CSS } from '../../shared/report-deck-styles';
import { ReportDeck } from '../../shared/report-deck-view';
import { REPORT_DECK_CONTROLLER_SOURCE } from './report-deck-controller';
import { escapeHtml } from './report-html';

export function renderReportDeckHtml(document: ReportDeckDocument) {
  const deck = renderToStaticMarkup(
    createElement(ReportDeck, { document, staticController: true }),
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    @media print { html, body { height: auto; overflow: visible; } }
    body { background: #0a0b10; }
    ${REPORT_DECK_CSS}
  </style>
</head>
<body>
  ${deck}
  <script>${REPORT_DECK_CONTROLLER_SOURCE}</script>
</body>
</html>
`;
}
