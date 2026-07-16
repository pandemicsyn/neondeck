export const REPORT_DECK_CSS = String.raw`
.report-deck {
  --rd-bg: var(--bg, #0a0b10);
  --rd-canvas: var(--canvas, #0a0b10);
  --rd-panel: var(--panel, #0c0d12);
  --rd-field: var(--field, #070810);
  --rd-line: var(--line, rgba(255, 255, 255, 0.12));
  --rd-ink: var(--ink, #d7f7ff);
  --rd-muted: var(--muted, rgba(215, 247, 255, 0.64));
  --rd-primary: var(--primary-strong, #69e6ff);
  --rd-primary-calm: var(--primary, #00b7c7);
  --rd-primary-ink: var(--primary-ink, #070810);
  --rd-accent: var(--accent, #ff4fb8);
  --rd-violet: var(--violet, #8b4dff);
  --rd-good: #4dd6a8;
  --rd-warning: #f0b95b;
  --rd-danger: #ff6b7a;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto 2px minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--rd-bg);
  color: var(--rd-ink);
  font: 14px/1.55 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
}

@media (prefers-color-scheme: light) {
  html:not([data-theme]) .report-deck {
    --rd-bg: #edf5f8;
    --rd-canvas: #edf5f8;
    --rd-panel: #f7fbfd;
    --rd-field: #dbeaef;
    --rd-line: rgba(20, 45, 60, 0.18);
    --rd-ink: #19232e;
    --rd-muted: #435965;
    --rd-primary: #007f91;
    --rd-primary-calm: #007f91;
    --rd-primary-ink: #edf5f8;
    --rd-accent: #b71f78;
    --rd-violet: #7044d8;
    --rd-good: #157a5f;
    --rd-warning: #8a5b00;
    --rd-danger: #b42335;
  }
}

.report-deck,
.report-deck * {
  box-sizing: border-box;
}

.report-deck button,
.report-deck a {
  font: inherit;
}

.report-deck button {
  cursor: pointer;
}

.report-deck button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.report-deck a {
  color: var(--rd-primary);
  text-decoration-color: color-mix(in srgb, var(--rd-primary) 54%, transparent);
  text-underline-offset: 0.18em;
}

.report-deck a:hover {
  text-decoration-color: currentColor;
}

.report-deck :where(button, a):focus-visible,
.report-deck-heading:focus-visible,
.report-deck:focus-visible {
  outline: 1px solid var(--rd-primary);
  outline-offset: 2px;
}

.report-deck:focus-visible {
  outline-offset: -2px;
}

.report-deck-toolbar {
  display: flex;
  min-height: 46px;
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid var(--rd-line);
  background: var(--rd-panel);
  padding: 7px 14px;
}

.report-deck-heading-group {
  min-width: 0;
}

.report-deck-eyebrow,
.report-deck-count,
.report-deck-meta,
.report-deck-kicker,
.report-deck-fact dt,
.report-deck-fact-label,
.report-deck-column h3,
.report-deck-path,
.report-deck-finding-meta,
.report-deck-appendix-label,
.report-deck-footer,
.report-deck-code-label {
  font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

.report-deck-eyebrow {
  margin: 0;
  color: var(--rd-primary);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.report-deck-heading {
  max-width: min(76vw, 78rem);
  margin: 1px 0 0;
  overflow: hidden;
  font: 600 16px/1.25 "Chakra Petch", ui-sans-serif, system-ui, sans-serif;
  text-overflow: ellipsis;
  text-wrap: balance;
  white-space: nowrap;
}

.report-deck-count {
  flex: none;
  margin-inline-start: auto;
  color: var(--rd-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.report-deck-progress-track {
  position: relative;
  overflow: hidden;
  background: color-mix(in srgb, var(--rd-line) 80%, transparent);
}

.report-deck-progress {
  width: 100%;
  height: 100%;
  background: var(--rd-primary-calm);
  transform-origin: left center;
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.report-deck-stage {
  min-height: 0;
  overflow: hidden;
  background: var(--rd-canvas);
}

.report-deck-slide {
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: clamp(16px, 2.6vw, 34px);
}

.report-deck-slide[hidden] {
  display: none;
}

.report-deck-slide-frame {
  display: flex;
  width: min(100%, 112rem);
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  flex-direction: column;
  border: 1px solid var(--rd-line);
  background: var(--rd-panel);
}

.report-deck-slide-header {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--rd-line);
  padding: 10px 16px;
}

.report-deck-slide-title {
  margin: 0;
  color: var(--rd-primary);
  font: 600 14px/1.3 "IBM Plex Mono", ui-monospace, monospace;
  letter-spacing: 0.04em;
  text-wrap: balance;
}

.report-deck-part {
  margin-inline-start: auto;
  color: var(--rd-muted);
  font: 10px/1 "IBM Plex Mono", ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

.report-deck-slide-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: clamp(16px, 2.3vw, 30px);
  scrollbar-gutter: stable;
}

.report-deck-summary-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(220px, 0.55fr);
  gap: clamp(22px, 4vw, 58px);
}

.report-deck-summary-copy {
  max-width: 74ch;
  font-size: clamp(14px, 1.15vw, 18px);
  line-height: 1.68;
  text-wrap: pretty;
}

.report-deck-summary-side {
  align-self: start;
  border-top: 1px solid var(--rd-primary-calm);
  padding-top: 12px;
}

.report-deck-links {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 16px;
}

.report-deck-action {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  border: 1px solid var(--rd-primary-calm);
  padding: 5px 10px;
  font: 600 10px/1 "IBM Plex Mono", ui-monospace, monospace;
  text-decoration: none;
}

.report-deck-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1px;
  margin: 0;
  background: var(--rd-line);
  border: 1px solid var(--rd-line);
}

.report-deck-fact {
  min-width: 0;
  background: var(--rd-panel);
  padding: 12px 14px;
}

.report-deck-fact dt,
.report-deck-fact-label {
  margin: 0 0 5px;
  color: var(--rd-muted);
  font-size: 9px;
  letter-spacing: 0.04em;
}

.report-deck-fact dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 14px;
}

.report-deck-empty {
  margin-top: 20px;
  border: 1px solid var(--rd-primary-calm);
  background: color-mix(in srgb, var(--rd-primary-calm) 6%, var(--rd-panel));
  padding: 14px 16px;
}

.report-deck-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1px;
  border: 1px solid var(--rd-line);
  background: var(--rd-line);
}

.report-deck-column {
  min-width: 0;
  background: var(--rd-panel);
  padding: 16px;
}

.report-deck-column h3 {
  margin: 0 0 12px;
  color: var(--rd-primary);
  font-size: 10px;
  letter-spacing: 0.06em;
}

.report-deck-column[data-tone="risk"] h3 {
  color: var(--rd-warning);
}

.report-deck-column[data-tone="positive"] h3 {
  color: var(--rd-good);
}

.report-deck-list,
.report-deck-change-list,
.report-deck-finding-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.report-deck-list li + li,
.report-deck-change + .report-deck-change,
.report-deck-finding + .report-deck-finding {
  border-top: 1px solid var(--rd-line);
}

.report-deck-list li {
  padding: 9px 0;
}

.report-deck-change,
.report-deck-finding {
  display: grid;
  grid-template-columns: minmax(160px, 0.34fr) minmax(0, 1fr);
  gap: 16px;
  padding: 13px 0;
}

.report-deck-change:first-child,
.report-deck-finding:first-child {
  padding-top: 0;
}

.report-deck-change:last-child,
.report-deck-finding:last-child {
  padding-bottom: 0;
}

.report-deck-path {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rd-primary);
  font-size: 11px;
}

.report-deck-risk {
  margin-top: 7px;
  color: var(--rd-warning);
}

.report-deck-finding-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  color: var(--rd-muted);
  font-size: 9px;
}

.report-deck-severity {
  display: inline-flex;
  min-height: 20px;
  align-items: center;
  border: 1px solid currentColor;
  padding: 2px 6px;
  color: var(--rd-warning);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.report-deck-severity[data-severity="critical"],
.report-deck-severity[data-severity="major"] {
  color: var(--rd-danger);
}

.report-deck-severity[data-severity="nit"] {
  color: var(--rd-muted);
}

.report-deck-fix {
  margin-top: 9px;
  border-top: 1px solid var(--rd-line);
  padding-top: 8px;
}

.report-deck-kicker {
  margin: 0 0 4px;
  color: var(--rd-muted);
  font-size: 9px;
}

.report-deck-appendix-note {
  margin: 0 0 16px;
  max-width: 74ch;
  color: var(--rd-muted);
}

.report-deck-appendix-group + .report-deck-appendix-group {
  margin-top: 22px;
  border-top: 1px solid var(--rd-line);
  padding-top: 16px;
}

.report-deck-appendix-label {
  margin: 0 0 10px;
  color: var(--rd-primary);
  font-size: 10px;
}

.report-deck-markdown-tone-correctness {
  border-color: color-mix(in srgb, var(--rd-warning) 54%, var(--rd-line));
}

.report-deck-markdown-tone-security {
  border-color: color-mix(in srgb, var(--rd-danger) 60%, var(--rd-line));
}

.report-deck-markdown-tone-positive {
  border-color: color-mix(in srgb, var(--rd-good) 54%, var(--rd-line));
}

.report-markdown > :first-child {
  margin-top: 0;
}

.report-markdown {
  overflow-wrap: anywhere;
}

.report-markdown > :last-child {
  margin-bottom: 0;
}

.report-markdown p,
.report-markdown ul,
.report-markdown ol,
.report-markdown blockquote,
.report-markdown pre,
.report-markdown table {
  margin: 0 0 0.85em;
}

.report-markdown h2,
.report-markdown h3,
.report-markdown h4 {
  margin: 1.15em 0 0.5em;
  color: var(--rd-primary);
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  line-height: 1.35;
  text-wrap: balance;
}

.report-markdown h2 { font-size: 16px; }
.report-markdown h3 { font-size: 14px; }
.report-markdown h4 { font-size: 12px; }

.report-markdown ul,
.report-markdown ol {
  padding-inline-start: 20px;
}

.report-markdown li + li {
  margin-top: 0.3em;
}

.report-markdown blockquote {
  border: 1px solid var(--rd-line);
  background: var(--rd-field);
  padding: 9px 12px;
  color: var(--rd-muted);
}

.report-markdown code {
  background: var(--rd-field);
  color: var(--rd-primary);
  padding: 1px 4px;
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 0.9em;
}

.report-markdown pre {
  overflow: auto;
  border: 1px solid var(--rd-line);
  background: var(--rd-field);
  padding: 11px 12px;
}

.report-markdown pre code {
  padding: 0;
  background: transparent;
  color: var(--rd-ink);
}

.report-markdown table {
  width: 100%;
  border-collapse: collapse;
}

.report-markdown th,
.report-markdown td {
  border: 1px solid var(--rd-line);
  padding: 6px 8px;
  text-align: start;
}

.report-markdown th {
  background: var(--rd-field);
  font: 600 10px/1.35 "IBM Plex Mono", ui-monospace, monospace;
}

.report-markdown-inert-link {
  color: inherit;
  text-decoration: underline dotted var(--rd-muted);
  text-underline-offset: 0.18em;
}

.report-deck-footer {
  display: grid;
  min-height: 44px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border-top: 1px solid var(--rd-line);
  background: var(--rd-panel);
  padding: 6px 10px;
  font-size: 10px;
}

.report-deck-nav-button {
  min-width: 74px;
  min-height: 30px;
  border: 1px solid var(--rd-line);
  border-radius: 0;
  background: transparent;
  color: var(--rd-muted);
  padding: 5px 10px;
}

.report-deck-nav-button:hover:not(:disabled) {
  border-color: var(--rd-primary-calm);
  color: var(--rd-primary);
}

.report-deck-dots {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 5px;
  overflow-x: auto;
  padding: 4px;
}

.report-deck-dot {
  width: 18px;
  min-width: 18px;
  height: 18px;
  border: 0;
  background: transparent;
  padding: 5px;
}

.report-deck-dot::before {
  display: block;
  width: 8px;
  height: 8px;
  border: 1px solid var(--rd-muted);
  background: transparent;
  content: "";
}

.report-deck-dot[aria-current="true"]::before {
  border-color: var(--rd-primary);
  background: var(--rd-primary);
}

.report-deck-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 760px) {
  .report-deck-summary-layout,
  .report-deck-change,
  .report-deck-finding {
    grid-template-columns: 1fr;
  }

  .report-deck-summary-side {
    border-top-color: var(--rd-line);
  }

  .report-deck-toolbar {
    min-height: 42px;
  }

  .report-deck-heading {
    max-width: 65vw;
    font-size: 13px;
  }

  .report-deck-slide {
    padding: 10px;
  }

  .report-deck-slide-body {
    padding: 14px;
  }

  .report-deck-footer {
    gap: 6px;
  }

  .report-deck-nav-button {
    min-width: 62px;
  }
}

@media (pointer: coarse) {
  .report-deck :where(button, a) {
    min-height: 40px;
  }

  .report-deck-dot {
    width: 40px;
    min-width: 40px;
    height: 40px;
    padding: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .report-deck-progress {
    transition: none;
  }
}

@media print {
  .report-deck {
    --rd-bg: #fff;
    --rd-canvas: #fff;
    --rd-panel: #fff;
    --rd-field: #edf5f8;
    --rd-line: rgba(20, 45, 60, 0.28);
    --rd-ink: #111;
    --rd-muted: #435965;
    --rd-primary: #007f91;
    --rd-primary-calm: #007f91;
    --rd-warning: #8a5b00;
    --rd-danger: #b42335;
    --rd-good: #157a5f;
    display: block;
    height: auto;
    overflow: visible;
    background: #fff;
    color: #111;
  }

  .report-deck-toolbar,
  .report-deck-progress-track,
  .report-deck-footer,
  .report-deck-live {
    display: none;
  }

  .report-deck-stage {
    overflow: visible;
    background: #fff;
  }

  .report-deck-slide,
  .report-deck-slide[hidden] {
    display: block;
    height: auto;
    break-after: page;
    padding: 0;
  }

  .report-deck-slide-frame {
    height: auto;
    min-height: 90vh;
    border-color: #19232e;
    background: #fff;
  }

  .report-deck-slide-body {
    overflow: visible;
  }
}
`;
