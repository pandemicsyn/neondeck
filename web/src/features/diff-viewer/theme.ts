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
`;
