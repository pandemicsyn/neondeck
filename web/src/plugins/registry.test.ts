// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { DisplayPlugin } from '../types';
import { pluginRegistry, plugins, resolvePluginConfig } from './registry';

const pluginWithoutParser: DisplayPlugin<{ label: string }> = {
  id: 'test-plugin',
  title: 'Test plugin',
  kind: 'data',
  defaultConfig: { label: 'default' },
  Component: () => null,
};

describe('dashboard Autopilot surface', () => {
  it('registers Active Watches without the legacy Autopilot panel', () => {
    expect(plugins.map(({ id }) => id)).toContain('active-watches');
    expect(plugins.map(({ id }) => id)).not.toContain('autopilot');
    expect(pluginRegistry['active-watches']).toBeDefined();
    expect(pluginRegistry.autopilot).toBeUndefined();
  });

  it.each([
    ['string', 'invalid'],
    ['array', ['invalid']],
  ])('falls back to plugin defaults for %s configuration', (_label, config) => {
    expect(resolvePluginConfig(pluginWithoutParser, config)).toEqual({
      config: { label: 'default' },
      issues: [],
    });
  });

  it('retains valid plugin settings when a sibling field is not JSON-safe', () => {
    expect(
      resolvePluginConfig(pluginWithoutParser, {
        label: 'configured',
        legacyCallback: () => undefined,
      }),
    ).toEqual({
      config: { label: 'configured' },
      issues: [],
    });
  });
});
