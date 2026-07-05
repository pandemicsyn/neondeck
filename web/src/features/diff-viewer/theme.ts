import type { PatchDiffProps } from '@pierre/diffs/react';
import type { ThemeTypes } from '@pierre/diffs/react';

export type ResolvedDiffTheme = Extract<ThemeTypes, 'light' | 'dark'>;

const baseDiffOptions = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  diffStyle: 'unified',
  diffIndicators: 'bars',
  hunkSeparators: 'line-info-basic',
  lineDiffType: 'word',
  overflow: 'wrap',
  stickyHeader: true,
  tokenizeMaxLineLength: 1800,
  tokenizeMaxLength: 220_000,
  useTokenTransformer: true,
} satisfies Omit<
  NonNullable<PatchDiffProps<undefined>['options']>,
  'themeType'
>;

export function neondeckDiffOptions(themeType: ResolvedDiffTheme) {
  return {
    ...baseDiffOptions,
    themeType,
  } satisfies NonNullable<PatchDiffProps<undefined>['options']>;
}

export const neondeckDiffUnsafeCss = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-font-size: calc(10.5px * var(--deck-text-scale));
    --diffs-line-height: 1.55;
    color: var(--ink);
  }
  [data-neondeck-review-annotation] {
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--primary) 10%, var(--field));
    color: var(--ink);
    padding: 6px 8px;
    font-family: var(--font-sans);
    font-size: calc(10.5px * var(--deck-text-scale));
    line-height: 1.4;
  }
  [data-neondeck-review-annotation-title] {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: var(--primary);
    font-family: var(--font-mono);
    font-size: calc(9.5px * var(--deck-text-scale));
    text-transform: uppercase;
  }
  [data-neondeck-review-annotation] p {
    margin: 4px 0 0;
  }
  [data-neondeck-review-annotation] a {
    color: var(--primary);
    display: inline-flex;
    font-family: var(--font-mono);
    font-size: calc(9.5px * var(--deck-text-scale));
    margin-top: 4px;
    text-decoration: none;
  }
`;
