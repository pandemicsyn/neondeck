export const RESOLVED_THEME_STORAGE_KEY = 'neondeck.resolved-theme';
export const THEME_PREFERENCE_STORAGE_KEY = 'neondeck.theme-preference';

export const THEME_BOOTSTRAP_SOURCE = String.raw`(()=>{const preferenceKey='${THEME_PREFERENCE_STORAGE_KEY}';const resolvedKey='${RESOLVED_THEME_STORAGE_KEY}';const systemTheme=()=>window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';const read=()=>{let preference=null;let resolved=null;try{preference=window.localStorage.getItem(preferenceKey);resolved=window.localStorage.getItem(resolvedKey)}catch{}if(preference==='system')return systemTheme();if(preference==='light'||preference==='dark'){return preference}if(resolved==='light'||resolved==='dark')return resolved;return systemTheme()};const apply=()=>{document.documentElement.dataset.theme=read()};apply();window.addEventListener('storage',(event)=>{if(event.key===preferenceKey||event.key===resolvedKey)apply()})})();`;

export const REPORT_THEME_BOOTSTRAP_CSS = String.raw`
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0c0d12;
  --canvas: #0a0b10;
  --panel: #0a0b10;
  --field: #070810;
  --line: rgba(255, 255, 255, 0.07);
  --ink: #d7f7ff;
  --muted: #91a8b0;
  --primary: #00b7c7;
  --primary-strong: #69e6ff;
  --primary-ink: #070810;
  --accent: #ff4fb8;
  --violet: #b59cff;
}

:root[data-theme='light'] {
  color-scheme: light;
  --bg: #edf5f8;
  --canvas: #edf5f8;
  --panel: #edf5f8;
  --field: #dbeaef;
  --line: rgba(20, 45, 60, 0.13);
  --ink: #19232e;
  --muted: #56646d;
  --primary: #006f7f;
  --primary-strong: #005b69;
  --primary-ink: #edf5f8;
  --accent: #b31170;
  --violet: #6034bd;
}

html[data-theme] body {
  background: var(--bg);
  color: var(--ink);
}

html[data-theme='light'] .report-deck {
  --rd-good: #157a5f;
  --rd-warning: #8a5b00;
  --rd-danger: #b42335;
}
`;

const THEME_BOOTSTRAP_MARKER = 'data-neondeck-theme-bootstrap';

export function withReportThemeBootstrap(html: string) {
  if (html.includes(THEME_BOOTSTRAP_MARKER)) return html;
  const markup = `<script ${THEME_BOOTSTRAP_MARKER}>${THEME_BOOTSTRAP_SOURCE}</script>\n<style ${THEME_BOOTSTRAP_MARKER}>${REPORT_THEME_BOOTSTRAP_CSS}</style>`;
  const charsetMeta =
    /<meta\s+charset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)\s*\/?>/iu;
  if (charsetMeta.test(html)) {
    return html.replace(charsetMeta, (meta) => `${meta}\n${markup}`);
  }
  const head = /<head(?:\s[^>]*)?>/iu;
  if (!head.test(html)) return html;
  return html.replace(head, (openingTag) => `${openingTag}\n${markup}`);
}
