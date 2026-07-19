import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  RESOLVED_THEME_STORAGE_KEY,
  THEME_BOOTSTRAP_SOURCE,
  THEME_PREFERENCE_STORAGE_KEY,
  withReportThemeBootstrap,
} from '../shared/theme-bootstrap';

describe('theme bootstrap', () => {
  it('keeps the dashboard bootstrap synchronized with the shared source', () => {
    const indexHtml = readFileSync(
      new URL('../web/index.html', import.meta.url),
      'utf8',
    );

    expect(indexHtml).toContain(RESOLVED_THEME_STORAGE_KEY);
    expect(indexHtml).toContain(THEME_PREFERENCE_STORAGE_KEY);
    expect(normalizeScript(indexHtml)).toBe(
      normalizeScript(THEME_BOOTSTRAP_SOURCE),
    );
  });

  it('upgrades legacy reports exactly once', () => {
    const legacy =
      '<!doctype html><html><head></head><body>Report</body></html>';
    const upgraded = withReportThemeBootstrap(legacy);

    expect(upgraded).toContain(
      `<script data-neondeck-theme-bootstrap>${THEME_BOOTSTRAP_SOURCE}</script>`,
    );
    expect(withReportThemeBootstrap(upgraded)).toBe(upgraded);
  });

  it('honors fixed preferences and resolves system preferences live', () => {
    const fixed = executeBootstrap({
      preference: 'dark',
      prefersDark: false,
      resolved: 'light',
    });
    expect(fixed.theme()).toBe('dark');

    const system = executeBootstrap({
      preference: 'system',
      prefersDark: true,
      resolved: 'light',
    });
    expect(system.theme()).toBe('dark');

    system.setStoredPreference('light');
    expect(system.theme()).toBe('light');
  });
});

function normalizeScript(source: string) {
  const script = source.includes('<script')
    ? source.match(
        /<script data-neondeck-theme-bootstrap>([\s\S]*?)<\/script>/u,
      )?.[1]
    : source;
  return script?.replace(/[\s;]+/gu, '');
}

function executeBootstrap({
  preference,
  prefersDark,
  resolved,
}: {
  preference: 'dark' | 'light' | 'system';
  prefersDark: boolean;
  resolved: 'dark' | 'light';
}) {
  const values = new Map<string, string>([
    [THEME_PREFERENCE_STORAGE_KEY, preference],
    [RESOLVED_THEME_STORAGE_KEY, resolved],
  ]);
  const dataset: Record<string, string> = {};
  let storageListener: ((event: { key: string }) => void) | undefined;
  runInNewContext(THEME_BOOTSTRAP_SOURCE, {
    document: { documentElement: { dataset } },
    window: {
      addEventListener: (
        type: string,
        listener: (event: { key: string }) => void,
      ) => {
        if (type === 'storage') storageListener = listener;
      },
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
      matchMedia: () => ({ matches: prefersDark }),
    },
  });
  return {
    setStoredPreference(nextPreference: 'dark' | 'light' | 'system') {
      values.set(THEME_PREFERENCE_STORAGE_KEY, nextPreference);
      storageListener?.({ key: THEME_PREFERENCE_STORAGE_KEY });
    },
    theme: () => dataset.theme,
  };
}
