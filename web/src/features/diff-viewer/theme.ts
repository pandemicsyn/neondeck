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
  [data-neondeck-review-annotation].pr-review-draft-stale {
    border-color: color-mix(in srgb, var(--accent) 46%, var(--line));
    background: color-mix(in srgb, var(--accent) 10%, var(--field));
  }
  .pr-review-composer {
    display: grid;
    gap: 6px;
  }
  .pr-review-composer textarea {
    width: 100%;
    min-height: 54px;
    resize: vertical;
    border: 1px solid var(--line);
    background: var(--field);
    padding: 6px;
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: calc(10.5px * var(--deck-text-scale));
    line-height: 1.4;
    outline: none;
  }
  .pr-review-composer textarea::placeholder {
    color: var(--deck-faint);
    opacity: 1;
  }
  .pr-review-composer textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
  }
  .pr-review-composer-actions,
  .pr-review-inline-actions {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pr-review-composer-actions button,
  .pr-review-inline-actions button,
  .pr-review-inline-actions a {
    display: inline-flex;
    min-height: calc(24px * var(--deck-density-space));
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    background: var(--field);
    padding: 4px 6px;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: calc(9.5px * var(--deck-text-scale));
    line-height: 1;
    text-decoration: none;
    transition:
      background-color 160ms ease,
      border-color 160ms ease,
      color 160ms ease;
    white-space: nowrap;
  }
  .pr-review-composer-actions button:not(:disabled):hover,
  .pr-review-inline-actions button:not(:disabled):hover,
  .pr-review-inline-actions a:hover {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 8%, var(--field));
    color: var(--primary-strong);
  }
  .pr-review-composer-actions button:focus-visible,
  .pr-review-inline-actions button:focus-visible,
  .pr-review-inline-actions a:focus-visible {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
    outline: none;
  }
  .pr-review-composer-actions button:disabled,
  .pr-review-inline-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
`;
