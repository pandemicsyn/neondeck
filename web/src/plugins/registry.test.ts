// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { pluginRegistry, plugins } from './registry';

describe('dashboard Autopilot surface', () => {
  it('registers Active Watches without the legacy Autopilot panel', () => {
    expect(plugins.map(({ id }) => id)).toContain('active-watches');
    expect(plugins.map(({ id }) => id)).not.toContain('autopilot');
    expect(pluginRegistry['active-watches']).toBeDefined();
    expect(pluginRegistry.autopilot).toBeUndefined();
  });
});
